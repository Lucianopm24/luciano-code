import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, formatToolRequest, parseToolRequest, TOOL_DEFINITIONS } from '../src/tools.js';

test('web_search is exposed and parses a web search request', () => {
  assert.ok(TOOL_DEFINITIONS.some(({ function: definition }) => definition.name === 'web_search'));
  assert.deepEqual(parseToolRequest('{"tool":"web_search","arguments":{"query":"Node.js streams"}}'), {
    tool: 'web_search',
    arguments: { query: 'Node.js streams' },
  });
  assert.match(formatToolRequest({ tool: 'web_search', arguments: { query: 'Node.js streams' } }), /Node\.js streams/);
});

test('web_search calls SearXNG JSON endpoint and formats results', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      results: [{ title: 'Streams', url: 'https://example.test/streams', content: 'A stream is incremental.' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await executeTool('.', { tool: 'web_search', arguments: { query: 'Node.js streams' } });
    assert.match(requestedUrl, /^https:\/\/search\.lucianopm\.com\/search\?/);
    assert.match(requestedUrl, /q=Node\.js\+streams/);
    assert.match(requestedUrl, /format=json/);
    assert.match(result, /Streams/);
    assert.match(result, /https:\/\/example\.test\/streams/);
    assert.match(result, /incremental/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
