/**
 * Anthropic Adapter — converts between Anthropic Messages API and Agon formats
 *
 * Request:  Anthropic /v1/messages  → Agon chat({modelId, systemPrompt, message})
 * Response: Agon events            → Anthropic SSE / JSON
 */
const { mergeConversation, buildToolSystemPrompt, parseToolCalls } = require('./message-converter');

/**
 * Extract plain text from Anthropic content (string | content-block[])
 */
function _extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' || b.type === 'tool_result' || b.type === 'tool_use')
      .map(b => {
        if (b.type === 'text') return b.text || '';
        if (b.type === 'tool_result') {
          return typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        }
        if (b.type === 'tool_use') return JSON.stringify({ tool: b.name, parameters: b.input || {} });
        return '';
      })
      .join('\n');
  }
  return String(content || '');
}

/**
 * Convert Anthropic Messages request to Agon-compatible arguments.
 * {
 *   modelId, systemPrompt, message  — ready for agon-client.chat()
 * }
 */
function convertRequest(anthropicBody, modelMap, defaultSystemPrompt) {
  // 1. System prompt (Anthropic: separate field; OpenAI: first message)
  let systemPrompt = '';
  const sys = anthropicBody.system;
  if (typeof sys === 'string') {
    systemPrompt = sys;
  } else if (Array.isArray(sys)) {
    systemPrompt = sys
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n\n');
  }
  if (!systemPrompt.trim()) systemPrompt = defaultSystemPrompt || '';

  // 2. Model name mapping
  const mappedModel = (modelMap && modelMap[anthropicBody.model])
    ? modelMap[anthropicBody.model]
    : anthropicBody.model;

  // 3. Convert Anthropic messages → OpenAI-like messages (role + string content)
  const oaiLike = (anthropicBody.messages || []).map(m => ({
    role: m.role === 'assistant' ? 'assistant' :
          m.role === 'user' ? 'user' :
          m.role === 'tool' ? 'tool' : 'user',
    content: _extractText(m.content)
  }));

  const merged = mergeConversation(oaiLike);

  // 4. Append tool instructions to system prompt
  let tools = anthropicBody.tools;
  if (tools && tools.length > 0) {
    const oaiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
    const tp = buildToolSystemPrompt(oaiTools);
    systemPrompt = tp ? systemPrompt + '\n\n' + tp : systemPrompt;
  }

  return { modelId: mappedModel, systemPrompt, message: merged };
}

/**
 * Convert Agon events to Anthropic SSE event strings.
 *
 * State: { msgStarted: bool, contentIndex: number }
 * msgId, modelId are set at stream start.
 *
 * Returns an array of strings ready to write to the response.
 */
function agonEventsToAnthropicSSE(event, state, msgId, modelId) {
  const lines = [];

  const write = (evt, data) => {
    lines.push(`event: ${evt}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push(''); // blank line separator
  };

  // First assistant_message: start the message + content blocks
  if (event.event_type === 'assistant_message') {
    const content = event.payload?.content || '';
    const meta = event.payload?.metadata;
    const reasoning = event.payload?.reasoning_content || '';

    // --- Message start (once) ---
    if (!state.msgStarted) {
      state.msgStarted = true;
      state.contentIndex = 0;
      write('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: modelId,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: meta?.input_tokens || 0, output_tokens: 0 }
        }
      });
    }

    // --- Parse tool calls from JSON blocks ---
    const toolCalls = parseToolCalls(content);
    // Strip tool-call JSON fences from the visible text
    let visible = content.replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();

    // --- Reasoning / thinking block (if any) ---
    if (reasoning) {
      const idx = state.contentIndex++;
      write('content_block_start', {
        type: 'content_block_start', index: idx,
        content_block: { type: 'thinking', thinking: '' }
      });
      write('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'thinking_delta', thinking: reasoning }
      });
      write('content_block_stop', { type: 'content_block_stop', index: idx });
    }

    // --- Text block ---
    if (visible) {
      const idx = state.contentIndex++;
      write('content_block_start', {
        type: 'content_block_start', index: idx,
        content_block: { type: 'text', text: '' }
      });
      write('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'text_delta', text: visible }
      });
      write('content_block_stop', { type: 'content_block_stop', index: idx });
    }

    // --- Tool-use blocks ---
    for (const tc of toolCalls) {
      const idx = state.contentIndex++;
      let argsParsed = {};
      try { argsParsed = JSON.parse(tc.function.arguments || '{}'); } catch {}
      write('content_block_start', {
        type: 'content_block_start', index: idx,
        content_block: {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: argsParsed
        }
      });
      write('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' }
      });
      write('content_block_stop', { type: 'content_block_stop', index: idx });
    }

    // --- Message end ---
    const outTokens = meta?.output_tokens || 0;
    const inTokens = meta?.input_tokens || 0;
    write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outTokens }
    });
    write('message_stop', { type: 'message_stop' });
  }

  if (event.event_type === 'error') {
    if (!state.msgStarted) {
      state.msgStarted = true;
      write('message_start', {
        type: 'message_start',
        message: {
          id: msgId, type: 'message', role: 'assistant', content: [],
          model: modelId, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
    }
    write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'error', stop_sequence: null },
      usage: { output_tokens: 0 }
    });
    write('message_stop', { type: 'message_stop' });
  }

  return lines;
}

/**
 * Build a non-streaming Anthropic response JSON from final Agon output.
 */
function buildNonStreamingResponse(content, meta, msgId, modelId) {
  const blocks = [];
  const toolCalls = parseToolCalls(content);
  const visible = content.replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();

  if (visible) {
    blocks.push({ type: 'text', text: visible });
  }
  for (const tc of toolCalls) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }

  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content: blocks,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: meta?.input_tokens || 0,
      output_tokens: meta?.output_tokens || 0
    }
  };
}

module.exports = { convertRequest, agonEventsToAnthropicSSE, buildNonStreamingResponse };
