'use strict';
// Client for an OpenAI-compatible chat-completions endpoint that the site
// owner runs themselves (Ollama, vLLM, llama.cpp server… with an open-weight
// model). Streaming by default so visitors see the answer as it is written.
const config = require('./config');

function isConfigured() {
  return !!(config.llm.baseUrl && config.llm.model);
}

// Calls onDelta(text) for each streamed chunk; resolves with the full text.
async function chat({ messages, onDelta = null, maxTokens = config.llm.maxTokens, temperature = 0.2 }) {
  if (!isConfigured()) throw new Error('llm_not_configured');
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.llm.model, messages, stream: true, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`llm_http_${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) {
    // Server ignored stream:true and sent one JSON body.
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (onDelta && text) onDelta(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const delta = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }
  return full;
}

module.exports = { isConfigured, chat };
