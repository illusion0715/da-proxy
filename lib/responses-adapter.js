/**
 * Responses Adapter — converts between OpenAI Responses API and Chat Completions
 *
 * Codex uses POST /v1/responses (newer Responses API)
 * We convert to internal format and reuse the Agon chat pipeline.
 */
const { parseToolCalls } = require('./message-converter');

/**
 * Flatten Responses-API style content blocks to a plain string.
 */
function _flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'input_text' || b.type === 'output_text')
      .map(b => b.text || '')
      .join('\n');
  }
  return String(content || '');
}

/**
 * Convert Responses API request body → Chat Completions shape.
 */
function responsesToChat(body) {
  const messages = (body.input || []).map(item => ({
    role: item.role,
    content: _flattenContent(item.content)
  }));

  let tools = null;
  if (body.tools && Array.isArray(body.tools)) {
    tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    }));
  }

  return {
    model: body.model,
    messages,
    tools,
    stream: !!body.stream,
    max_tokens: body.max_output_tokens || 4096,
    temperature: body.temperature
  };
}

/**
 * Build a non-streaming Responses-API response.
 */
function buildResponsesResponse(content, meta, modelId) {
  const rid = 'resp_' + Math.random().toString(36).slice(2, 14);
  const toolCalls = parseToolCalls(content);
  const visible = content.replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();

  const output = [];
  if (visible) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: visible }]
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: 'function_call',
      id: tc.id,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    });
  }

  return {
    id: rid,
    object: 'response',
    model: modelId,
    output,
    usage: {
      input_tokens: meta?.input_tokens || 0,
      output_tokens: meta?.output_tokens || 0,
      total_tokens: (meta?.input_tokens || 0) + (meta?.output_tokens || 0)
    }
  };
}

/**
 * Convert Agon events → Responses-API SSE lines.
 * state tracks: { started, outputIndex, contentIndex, itemId }
 */
function agonToResponsesSSE(event, state, modelId) {
  const lines = [];

  const write = (evt, data) => {
    lines.push(`event: ${evt}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push('');
  };

  if (event.event_type === 'assistant_message') {
    const content = event.payload?.content || '';
    const meta = event.payload?.metadata;
    const visible = content.replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();

    // First event
    if (!state.started) {
      state.started = true;
      state.outputIndex = 0;
      state.contentIndex = 0;
      state.itemId = 'item_' + Math.random().toString(36).slice(2, 10);
      write('response.created', {
        type: 'response.created',
        response: {
          id: state.itemId,
          object: 'response',
          model: modelId,
          output: [],
          usage: null
        }
      });
      write('response.in_progress', {
        type: 'response.in_progress',
        response: {
          id: state.itemId,
          object: 'response',
          model: modelId,
          output: [],
          usage: null
        }
      });
    }

    // Text delta
    if (visible) {
      const outputItemId = 'msg_' + Math.random().toString(36).slice(2, 10);
      write('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: {
          type: 'message',
          id: outputItemId,
          role: 'assistant',
          content: []
        }
      });
      write('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: outputItemId,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '' }
      });
      write('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: outputItemId,
        output_index: state.outputIndex,
        content_index: 0,
        delta: visible
      });
      write('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: outputItemId,
        output_index: state.outputIndex,
        content_index: 0,
        text: visible
      });
      write('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: outputItemId,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: visible }
      });
      write('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: {
          type: 'message',
          id: outputItemId,
          role: 'assistant',
          content: [{ type: 'output_text', text: visible }]
        }
      });
      state.outputIndex++;
    }

    // Completed
    write('response.completed', {
      type: 'response.completed',
      response: {
        id: state.itemId,
        object: 'response',
        model: modelId,
        output: visible ? [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: visible }]
        }] : [],
        usage: {
          input_tokens: meta?.input_tokens || 0,
          output_tokens: meta?.output_tokens || 0,
          total_tokens: (meta?.input_tokens || 0) + (meta?.output_tokens || 0)
        }
      }
    });
  }

  if (event.event_type === 'error') {
    if (!state.started) {
      state.started = true;
      write('response.created', {
        type: 'response.created',
        response: { id: 'err', object: 'response', model: modelId, output: [], usage: null }
      });
    }
    write('response.failed', {
      type: 'response.failed',
      response: {
        id: state.itemId || 'err',
        object: 'response',
        model: modelId,
        output: [],
        usage: null
      }
    });
  }

  return lines;
}

module.exports = { responsesToChat, buildResponsesResponse, agonToResponsesSSE };
