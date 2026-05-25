/**
 * Message Converter - OpenAI messages to DesignArena format
 */

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return String(content || '');
}

function separateMessages(messages) {
  const system = [], conversation = [];
  for (const msg of messages) {
    if (msg.role === 'system') system.push(msg);
    else conversation.push(msg);
  }
  return { system, conversation };
}

function buildSystemPrompt(systemMsgs, defaultPrompt) {
  if (systemMsgs.length === 0) return defaultPrompt || '';
  return systemMsgs.map(m => extractText(m.content)).filter(c => c.trim()).join('\n\n');
}

function mergeConversation(messages) {
  if (messages.length === 0) return '';
  if (messages.length === 1 && messages[0].role === 'user') return extractText(messages[0].content);
  const parts = [];
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (history.length > 0) {
    parts.push('<conversation_history>');
    for (const msg of history) {
      const text = extractText(msg.content);
      if (!text.trim()) continue;
      const role = msg.role === 'assistant' ? 'assistant' :
                   msg.role === 'tool' ? 'tool_result' : 'user';
      parts.push('<' + role + '>' + text + '</' + role + '>');
    }
    parts.push('</conversation_history>');
  }
  const lastText = extractText(last.content);
  if (lastText.trim()) parts.push('<current_query>\n' + lastText + '\n</current_query>');
  return parts.join('\n\n');
}

const TOOL_MAP = {
  read_file: 'read_file', write_file: 'write_file', edit_file: 'edit_file',
  bash: 'bash', execute_command: 'bash', run_command: 'bash', shell: 'bash',
  web_search: 'web_search', search_web: 'web_search',
  web_fetch: 'web_fetch', fetch_url: 'web_fetch',
  grep: 'grep', search_code: 'grep',
  generate_image: 'generate_image', create_image: 'generate_image',
  fetch_image: 'fetch_image',
  deploy_to_vercel: 'deploy_to_vercel', deploy: 'deploy_to_vercel',
  batch_create_files: 'batch_create_files', multi_edit: 'multi_edit',
  delete_file: 'delete_file', apply_patch: 'apply_patch'
};

function resolveToolNames(openaiTools) {
  if (!openaiTools || !Array.isArray(openaiTools) || openaiTools.length === 0) return ['read_file'];
  const names = new Set();
  for (const tool of openaiTools) {
    const fnName = (tool.function?.name || tool.type || '').toLowerCase();
    names.add(TOOL_MAP[fnName] || 'bash');
  }
  return [...names];
}

function buildToolSystemPrompt(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return '';
  const descs = openaiTools.map(t => {
    const fn = t.function || {};
    const params = fn.parameters?.properties
      ? Object.entries(fn.parameters.properties)
          .map(([k, v]) => '  - ' + k + ': ' + (v.type || 'string') + (v.description ? ' - ' + v.description : ''))
          .join('\n')
      : '';
    return '<tool>\n<name>' + fn.name + '</name>\n<description>' + (fn.description || '') +
           '</description>\n<parameters>\n' + params + '\n</parameters>\n</tool>';
  }).join('\n\n');
  return '<tools_instructions>\nYou have access to the following tools. To use a tool, output a JSON block:\n\n```json\n{"tool": "<tool_name>", "parameters": {...}}\n```\n\nAvailable tools:\n' +
         descs + '\n</tools_instructions>';
}

function parseToolCalls(content) {
  const calls = [];
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    try {
      const p = JSON.parse(m[1]);
      if (p.tool || p.function || p.name) {
        calls.push({
          id: 'call_' + Math.random().toString(36).slice(2, 10),
          type: 'function',
          function: { name: p.tool || p.function || p.name, arguments: JSON.stringify(p.parameters || p.arguments || {}) }
        });
      }
    } catch {}
  }
  return calls;
}

module.exports = {
  extractText, separateMessages, buildSystemPrompt, mergeConversation,
  resolveToolNames, buildToolSystemPrompt, parseToolCalls, TOOL_MAP
};
