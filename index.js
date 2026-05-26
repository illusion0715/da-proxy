/**
 * DA-Proxy — OpenAI-compatible API proxy for DesignArena (designarena.ai)
 *
 * True streaming: Agon events forwarded in real-time
 * Session pool: pre-warmed sessions to absorb rate limits
 * Two paths: Agon testing (34 exact) + Tournament (456 pool-based)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const ModelRegistry = require('./lib/model-registry');
const { chat } = require('./lib/agon-client');
const { separateMessages, buildSystemPrompt, mergeConversation, buildToolSystemPrompt } = require('./lib/message-converter');
const { convertRequest, agonEventsToAnthropicSSE, buildNonStreamingResponse } = require('./lib/anthropic-adapter');
const { responsesToChat, buildResponsesResponse, agonToResponsesSSE } = require('./lib/responses-adapter');

const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const modelRegistry = new ModelRegistry();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => { if (req.path !== '/health') console.log(req.method, req.path, res.statusCode, (Date.now() - start) + 'ms'); });
  next();
});
app.use('/v1', (req, res, next) => {
  if (!config.apiKey) return next();
  if (req.method === 'GET' && (req.path === '/models' || req.path.startsWith('/models/'))) return next();
  const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (key === config.apiKey) return next();
  return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_api_key' } });
});

// Route aliases: allow requests without /v1 prefix (e.g. POST /responses -> /v1/responses)
app.use((req, res, next) => {
  if (!req.path.startsWith('/v1') && req.path !== '/health') {
    const rewritten = '/v1' + req.path;
    req.url = rewritten;
  }
  next();
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), models: modelRegistry.models.length });
});

// Models
app.get('/v1/models', (req, res) => res.json(modelRegistry.getOpenAIList()));
app.get('/v1/models/:id', (req, res) => {
  const id = modelRegistry.resolveModelId(req.params.id);
  const info = modelRegistry.getModelInfo(id);
  if (!info) return res.status(404).json({ error: { message: 'Model not found', type: 'invalid_request_error' } });
  res.json(info);
});

// Chat
app.post('/v1/chat/completions', async (req, res) => {
  const rid = 'req_' + Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  const { model, messages, stream, tools, temperature } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages required', type: 'invalid_request_error' } });
  }
  const modelId = modelRegistry.resolveModelId(model || 'gpt-5.5');
  if (!modelId) return res.status(400).json({ error: { message: 'Model not found', type: 'invalid_request_error' } });
  const modelInfo = modelRegistry.getModelInfo(modelId);
  console.log('[' + rid + '] ' + modelId + ' ' + (modelInfo.agon_compatible ? 'agon' : 'tournament') + ' stream=' + !!stream);

  // === AGON PATH (exact, streaming) ===
  if (modelInfo.agon_compatible) {
    try {
      const { system, conversation } = separateMessages(messages);
      let sp = buildSystemPrompt(system, config.defaultSystemPrompt);
      if (tools && tools.length > 0) sp += '\n\n' + buildToolSystemPrompt(tools);
      const merged = mergeConversation(conversation);

      let thinking, re;
      if (modelInfo.provider === 'google' || modelId.includes('gemini')) {
        thinking = { type: 'enabled', budget_tokens: config.maxReasoningBudgetTokens || 4096 };
        re = 'high';
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const keepAlive = setInterval(() => {
          res.write(': ping\n\n');
        }, 10000);

        const cid = 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
        const created = Math.floor(Date.now() / 1000);
        res.write('data: ' + JSON.stringify({
          id: cid, object: 'chat.completion.chunk', created, model: modelId,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        }) + '\n\n');

        let tokensInfo = null;
        await chat({
          modelId, systemPrompt: sp, message: merged,
          onChunk: (event) => {
            const sse = _eventToSSE(event, cid, created, modelId);
            if (!sse) return;
            if (sse._usage) { tokensInfo = sse._usage; delete sse._usage; }
            res.write('data: ' + JSON.stringify(sse) + '\n\n');
          }
        });

        const finish = {
          id: cid, object: 'chat.completion.chunk', created, model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: tokensInfo || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        res.write('data: ' + JSON.stringify(finish) + '\n\n');
        res.write('data: [DONE]\n\n');
        clearInterval(keepAlive);
        return res.end();
      }

      // Non-streaming: collect
      let nsContent = '', nsTokens = null;
      await chat({
        modelId, systemPrompt: sp, message: merged,
        onChunk: (event) => {
          if (event.event_type === 'assistant_message') {
            nsContent = event.payload?.content || '';
            if (event.payload?.metadata) {
              nsTokens = { prompt_tokens: event.payload.metadata.input_tokens || 0, completion_tokens: event.payload.metadata.output_tokens || 0, total_tokens: event.payload.metadata.total_tokens || 0 };
            }
          }
        }
      });
      console.log('[' + rid + '] done ' + (Date.now() - t0) + 'ms');
      return res.json({
        id: 'chatcmpl-' + Math.random().toString(36).slice(2, 14),
        object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: nsContent }, finish_reason: 'stop' }],
        usage: nsTokens || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    } catch (err) {
      console.error('[' + rid + '] agon error:', err.message);
      return res.status(503).json({ error: { message: 'Rate limited or service error: ' + err.message, type: 'api_error' } });
    }
  }

  // Non-Agon models: not supported (registry-only, no exact invocation path)
  return res.status(400).json({
    error: {
      message: 'Model "' + modelId + '" is registry-only and cannot be invoked exactly. Use /v1/models to see ' + modelRegistry.models.filter(m => m.agon_compatible).length + ' Agon-compatible models.',
      type: 'invalid_request_error',
      agon_models: modelRegistry.models.filter(m => m.agon_compatible).map(m => m.id).slice(0, 20)
    }
  });
});

// === Anthropic Messages API (Claude-compatible endpoint) ===
app.post('/v1/messages', async (req, res) => {
  const rid = 'msg_' + Math.random().toString(36).slice(2, 14);
  const t0 = Date.now();
  const { stream } = req.body;

  // Convert Anthropic request to Agon format
  const { modelId, systemPrompt, message } = convertRequest(
    req.body, config.anthropicModelMap, config.defaultSystemPrompt
  );

  if (!message) {
    return res.status(400).json({
      type: 'error', error: { type: 'invalid_request_error', message: 'messages required' }
    });
  }

  console.log('[' + rid + '] anthropic ' + modelId + ' stream=' + !!stream);

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 10000);

      const state = { msgStarted: false, contentIndex: 0 };
      let finalContent = '', finalMeta = null;

      await chat({
        modelId, systemPrompt, message,
        onChunk: (event) => {
          if (event.event_type === 'assistant_message') {
            finalContent = event.payload?.content || '';
            finalMeta = event.payload?.metadata;
          }
          const sse = agonEventsToAnthropicSSE(event, state, rid, modelId);
          for (const line of sse) {
            res.write(line + '\n');
          }
        }
      });

      console.log('[' + rid + '] done ' + (Date.now() - t0) + 'ms');
      clearInterval(keepAlive);
      res.end();
    } else {
      let content = '', meta = null;
      await chat({
        modelId, systemPrompt, message,
        onChunk: (event) => {
          if (event.event_type === 'assistant_message') {
            content = event.payload?.content || '';
            meta = event.payload?.metadata;
          }
        }
      });

      console.log('[' + rid + '] done ' + (Date.now() - t0) + 'ms');
      res.json(buildNonStreamingResponse(content, meta, rid, modelId));
    }
  } catch (err) {
    console.error('[' + rid + '] error:', err.message);
    res.status(503).json({
      type: 'error',
      error: { type: 'api_error', message: 'Service error: ' + err.message }
    });
  }
});

// === OpenAI Responses API (Codex-compatible endpoint) ===
app.post('/v1/responses', async (req, res) => {
  const rid = 'resp_' + Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  const { stream } = req.body;

  // Convert Responses → Chat Completions format, then reuse pipeline
  const chatBody = responsesToChat(req.body);
  const { model, messages, tools, temperature } = chatBody;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'input required', type: 'invalid_request_error' } });
  }

  const modelInfo = modelRegistry.getModelInfo(model);
  const modelId = modelInfo ? model : (modelRegistry.resolveModelId(model) || model);
  console.log('[' + rid + '] responses ' + modelId + ' stream=' + !!stream);

  if (!modelInfo || !modelInfo.agon_compatible) {
    return res.status(400).json({
      error: {
        message: 'Model "' + modelId + '" is not directly invocable (registry-only).',
        type: 'invalid_request_error'
      }
    });
  }

  try {
    const { system, conversation } = separateMessages(messages);
    let sp = buildSystemPrompt(system, config.defaultSystemPrompt);
    if (tools && tools.length > 0) sp += '\n\n' + buildToolSystemPrompt(tools);
    const merged = mergeConversation(conversation);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 10000);

      const _w = (evt, data) => {
        res.write(`event: ${evt}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const msgId = 'msg_' + Math.random().toString(36).slice(2, 10);

      // 1. Send setup events immediately (before waiting for Agon)
      _w('response.created', { type: 'response.created', response: { id: rid, object: 'response', model: modelId, status: 'in_progress', output: [], usage: null } });
      _w('response.in_progress', { type: 'response.in_progress', response: { id: rid, object: 'response', model: modelId, status: 'in_progress', output: [], usage: null } });
      _w('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      _w('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });

      // 2. Get full response from Agon (not incremental — we chunk it ourselves)
      let fullContent = '', meta = null;
      await chat({
        modelId, systemPrompt: sp, message: merged,
        onChunk: (event) => {
          if (event.event_type === 'assistant_message') {
            fullContent = (event.payload?.content || '').replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();
            meta = event.payload?.metadata;
          }
        }
      });

      // 3. Chunk the text and stream deltas
      const chars = [...fullContent];
      const chunkSize = 3;
      for (let i = 0; i < chars.length; i += chunkSize) {
        const chunk = chars.slice(i, i + chunkSize).join('');
        _w('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: chunk });
        if (chars.length > 20) await new Promise(r => setTimeout(r, 10));
      }

      // 4. Completion events
      _w('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: fullContent });
      _w('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullContent, annotations: [] } });
      _w('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullContent, annotations: [] }] } });

      const inT = meta?.input_tokens || 0, outT = meta?.output_tokens || 0;
      _w('response.completed', { type: 'response.completed', response: { id: rid, object: 'response', model: modelId, status: 'completed', output: [{ id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullContent, annotations: [] }] }], usage: { input_tokens: inT, output_tokens: outT, total_tokens: inT + outT } } });

      console.log('[' + rid + '] done ' + (Date.now() - t0) + 'ms');
      clearInterval(keepAlive);
      res.end();
    } else {
      let content = '', meta = null;
      await chat({
        modelId, systemPrompt: sp, message: merged,
        onChunk: (event) => {
          if (event.event_type === 'assistant_message') {
            content = event.payload?.content || '';
            meta = event.payload?.metadata;
          }
        }
      });
      console.log('[' + rid + '] done ' + (Date.now() - t0) + 'ms');
      res.json(buildResponsesResponse(content, meta, modelId));
    }
  } catch (err) {
    console.error('[' + rid + '] error:', err.message);
    res.status(503).json({ error: { message: 'Service error: ' + err.message, type: 'api_error' } });
  }
});

// SSE event converter (OpenAI format)
function _eventToSSE(event, cid, created, modelId) {
  switch (event.event_type) {
    case 'status_update':
    case 'thought_complete':
      return null;
    case 'assistant_message':
      const content = event.payload?.content || '';
      const meta = event.payload?.metadata;
      const chunk = {
        id: cid, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta: { content }, finish_reason: null }]
      };
      if (meta) {
        chunk._usage = { prompt_tokens: meta.input_tokens || 0, completion_tokens: meta.output_tokens || 0, total_tokens: meta.total_tokens || 0 };
      }
      if (event.payload?.reasoning_content) {
        chunk.choices[0].delta.reasoning_content = event.payload.reasoning_content;
      }
      return chunk;
    case 'tool_call_started':
      return {
        id: cid, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.payload?.call_id || 'call_0', type: 'function', function: { name: event.payload?.tool_name || '', arguments: JSON.stringify(event.payload?.arguments || {}) } }] }, finish_reason: null }]
      };
    case 'error':
      return {
        id: cid, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta: { content: 'Error: ' + (event.payload?.error || 'Unknown') }, finish_reason: 'error' }]
      };
    default:
      return null;
  }
}

async function start() {
  console.log('DA-Proxy v1.1 — DesignArena OpenAI-compatible proxy');
  console.log('='.repeat(60));
  try { const m = await modelRegistry.refresh(); console.log('Loaded ' + m.length + ' models'); } catch (e) { console.error('Model load failed:', e.message); }
  modelRegistry.startAutoRefresh(config.modelRefreshSec);
  const port = process.env.PORT || config.port || 3141;
  app.listen(port, config.host || '0.0.0.0', () => {
    console.log('Listening on http://0.0.0.0:' + port);
    console.log('  GET  /v1/models  |  POST /v1/chat/completions  |  POST /v1/messages  |  POST /v1/responses');
    console.log('  Also available without /v1 prefix: /responses, /messages, /chat/completions');
    console.log('='.repeat(60));
  });
}

process.on('SIGINT', () => { modelRegistry.stop(); sessionPool.stop(); process.exit(0); });
start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
