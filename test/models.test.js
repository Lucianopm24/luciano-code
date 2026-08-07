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

test('visible selector exposes GLM 5.2, MiniMax M3, and Custom', () => {
  const choices = renderModelChoices(DEFAULT_MODEL).join('\n');

  assert.deepEqual(RECOMMENDED_MODELS.map((model) => model.id), [
    'z-ai/glm-5.2',
    'minimaxai/minimax-m3',
  ]);
  assert.equal(CUSTOM_MODEL_INDEX, 3);
  assert.match(choices, /1\. GLM 5\.2/);
  assert.match(choices, /2\. MiniMax M3/);
  assert.match(choices, /3\. Custom model ID/);
  assert.doesNotMatch(choices, /Llama|Mistral|meta\/|mistralai\//);
});

test('deprecated DeepSeek presets are no longer available', () => {
  assert.ok(!PREDEFINED_MODELS.some((model) => model.id === 'deepseek-ai/deepseek-v4-flash'));
  assert.ok(!PREDEFINED_MODELS.some((model) => model.id === 'deepseek-ai/deepseek-v4-pro'));
});

test('new configurations default to GLM 5.2', () => {
  assert.equal(DEFAULT_MODEL, 'z-ai/glm-5.2');
  assert.equal(normalizeConfig().model, 'z-ai/glm-5.2');
  assert.equal(defaultModelChoice(DEFAULT_MODEL), 1);
});

test('deprecated model IDs normalize to the new default', () => {
  const choices = renderModelChoices('deepseek-ai/deepseek-v4-flash').join('\n');
  assert.equal(normalizeConfig({ model: 'deepseek-ai/deepseek-v4-flash' }).model, DEFAULT_MODEL);
  assert.equal(defaultModelChoice('deepseek-ai/deepseek-v4-flash'), CUSTOM_MODEL_INDEX);
  assert.match(choices, /3\. Custom model ID  ← current/);
});
