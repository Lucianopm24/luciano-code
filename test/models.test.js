import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_MODEL_INDEX,
  PREDEFINED_MODELS,
  RECOMMENDED_MODELS,
  defaultModelChoice,
  renderModelChoices,
} from '../src/models.js';
import { DEFAULT_MODEL, normalizeConfig } from '../src/config.js';

test('visible selector exposes only recommended DeepSeek models and Custom', () => {
  const choices = renderModelChoices(DEFAULT_MODEL).join('\n');

  assert.deepEqual(RECOMMENDED_MODELS.map((model) => model.id), [
    'deepseek-ai/deepseek-v4-flash',
    'deepseek-ai/deepseek-v4-pro',
  ]);
  assert.equal(CUSTOM_MODEL_INDEX, 3);
  assert.match(choices, /1\. DeepSeek V4 Flash/);
  assert.match(choices, /2\. DeepSeek V4 Pro/);
  assert.match(choices, /3\. Custom model ID/);
  assert.doesNotMatch(choices, /Llama|Mistral|meta\/|mistralai\//);
});

test('hidden presets remain in the internal catalog for compatibility', () => {
  assert.ok(PREDEFINED_MODELS.some((model) => model.id === 'meta/llama-3.3-70b-instruct'));
  assert.ok(PREDEFINED_MODELS.some((model) => model.id === 'mistralai/mistral-large-2-instruct'));
});

test('new configurations default to DeepSeek V4 Flash', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek-ai/deepseek-v4-flash');
  assert.equal(normalizeConfig().model, 'deepseek-ai/deepseek-v4-flash');
  assert.equal(defaultModelChoice(DEFAULT_MODEL), 1);
});

test('legacy hidden model IDs fall back to Custom in the visible selector', () => {
  const choices = renderModelChoices('meta/llama-3.3-70b-instruct').join('\n');
  assert.equal(defaultModelChoice('meta/llama-3.3-70b-instruct'), CUSTOM_MODEL_INDEX);
  assert.match(choices, /3\. Custom model ID  ← current/);
});
