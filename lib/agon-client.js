/**
 * Agon client with built-in rate limit pacing
 * - Never creates sessions faster than 1/second (avoids triggering limit)
 * - Retries on 429/503 with proper backoff
 * - True streaming via real-time event forwarding
 */
const https = require('https');
const HOST = 'www.designarena.ai';
const BASE = '/api/agon/api';
const POLL_INTERVAL = 2000;
const MAX_POLLS = 300;
const MIN_CREATE_INTERVAL = 1500;

let lastCreateTime = 0;
let rateLimitUntil = 0;

function request(pathname, method = 'GET', body = undefined) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path: BASE + pathname, method, headers, timeout: 600000 }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** Pace session creation to avoid rate limits */
async function paceCreate() {
  // If globally rate-limited, wait
  if (Date.now() < rateLimitUntil) {
    const waitMs = rateLimitUntil - Date.now() + 1000;
    console.log('[agon] global backoff ' + Math.ceil(waitMs / 1000) + 's');
    await new Promise(r => setTimeout(r, waitMs));
  }
  // Ensure minimum interval between creates
  const elapsed = Date.now() - lastCreateTime;
  if (elapsed < MIN_CREATE_INTERVAL) {
    const waitMs = MIN_CREATE_INTERVAL - elapsed;
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastCreateTime = Date.now();
}

async function chat({ modelId, systemPrompt, message, onChunk }) {
  await paceCreate();

  // Create session with retry
  let session;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await request('/sessions/testing', 'POST', {
        config: {
          model: modelId,
          tools: ['godot_export'],
          system_prompt: systemPrompt || 'You are a helpful AI assistant.'
        },
        template_type: 'vite-react-ts'
      });

      if (res.status === 201) {
        session = {
          sessionId: res.json.session_id,
          agentId: res.json.model_id || 'agent_1',
          modelId,
          modelDisplayName: res.json.model_display_name,
          provider: res.json.provider
        };
        break;
      }

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers?.['retry-after'] || '60', 10);
        rateLimitUntil = Math.max(rateLimitUntil, Date.now() + retryAfter * 1000);
        const delay = retryAfter * 1000 + 2000 * attempt;
        console.log('[agon] ' + res.status + ' retry in ' + (delay / 1000) + 's (attempt ' + (attempt + 1) + ')');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw new Error(res.json?.detail || 'Create failed: ' + res.status);
    } catch (err) {
      if (attempt >= 7) throw err;
      const delay = 3000 * Math.pow(2, attempt);
      console.log('[agon] error, retry in ' + (delay / 1000) + 's: ' + err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  if (!session) throw new Error('Failed to create session after retries');

  // Send message
  const sendRes = await request(
    '/sessions/' + encodeURIComponent(session.sessionId) + '/agents/' + encodeURIComponent(session.agentId) + '/send',
    'POST', { message }
  );
  if (sendRes.status !== 202) {
    throw new Error('Send failed: ' + sendRes.status);
  }

  // Poll events
  let latest = 0, finished = false;
  for (let i = 0; i < MAX_POLLS && !finished; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    let evRes;
    try {
      evRes = await request(
        '/sessions/' + encodeURIComponent(session.sessionId) + '/events?model_id=' + encodeURIComponent(session.agentId) + '&since=' + latest + '&limit=200'
      );
    } catch { continue; }
    const events = evRes?.json?.events || [];
    for (const e of events) {
      const eid = Number(e.event_id) || 0;
      if (eid <= latest) continue;
      latest = eid;
      if (onChunk) onChunk(e);
      if (e.event_type === 'assistant_message' || e.event_type === 'error') finished = true;
    }
  }
  return { session, latest_event_id: latest };
}

module.exports = { chat };
