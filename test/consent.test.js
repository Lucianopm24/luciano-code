import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNvidiaDataConsent, normalizeConfig, setNvidiaDataConsent } from '../src/config.js';
import { NvidiaNimClient } from '../src/nvidia.js';

test('NVIDIA consent is explicit and persists through config normalization', () => {
  const undecided = normalizeConfig();
  assert.equal(undecided.nvidiaDataConsent, null);
  assert.equal(hasNvidiaDataConsent(undecided), false);

  const accepted = setNvidiaDataConsent(undecided, 'accepted');
  assert.equal(accepted.nvidiaDataConsent, 'accepted');
  assert.equal(hasNvidiaDataConsent(accepted), true);

  const declined = setNvidiaDataConsent(accepted, 'declined');
  assert.equal(declined.nvidiaDataConsent, 'declined');
  assert.equal(hasNvidiaDataConsent(declined), false);
});

test('NVIDIA client blocks complete and model-list requests without consent', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called');
  };
  try {
    const client = new NvidiaNimClient({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'declined',
    });
    await assert.rejects(
      client.complete([{ role: 'user', content: 'private prompt' }]),
      /consent/i,
    );
    await assert.rejects(client.listModels(), /consent/i);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
