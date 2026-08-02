import test from 'node:test';
import assert from 'node:assert/strict';
import { NvidiaNimClient } from '../src/nvidia.js';

function streamResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('NVIDIA content deltas are forwarded unchanged and in order', async () => {
  const originalFetch = globalThis.fetch;
  const received = [];
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return streamResponse([
    'data: {"choices":[{"delta":{"content":"Ho"}}]}\n',
    'data: {"choices":[{"delta":{"content":"la"}}]}\n',
    'data: {"choices":[{"delta":{"content":" mun"}}]}\n',
    'data: {"choices":[{"delta":{"content":"do"}}]}\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10000,"completion_tokens":4700,"total_tokens":14700}}\n',
    'data: [DONE]\n',
    ]);
  };

  try {
    const client = new NvidiaNimClient({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      preferences: { stream: true },
    });
    const result = await client.complete([{ role: 'user', content: 'hello' }], {
      onToken: (token) => received.push(token),
    });

    assert.deepEqual(received, ['Ho', 'la', ' mun', 'do']);
    assert.equal(result.content, 'Hola mundo');
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.equal(result.usage.total_tokens, 14700);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NVIDIA reasoning deltas are forwarded unchanged and in order', async () => {
  const originalFetch = globalThis.fetch;
  const received = [];
  globalThis.fetch = async () => streamResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"Pen"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"san"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"do"}}]}\n',
    'data: [DONE]\n',
  ]);

  try {
    const client = new NvidiaNimClient({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      preferences: { stream: true },
    });
    const result = await client.complete([{ role: 'user', content: 'hello' }], {
      onReasoning: (token) => received.push(token),
    });

    assert.deepEqual(received, ['Pen', 'san', 'do']);
    assert.equal(result.reasoning, 'Pensando');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
