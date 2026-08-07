export const PREDEFINED_MODELS = [
  {
    id: 'meta/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    provider: 'Meta',
    description: 'General-purpose choice for coding and reasoning.',
  },
  {
    id: 'meta/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B Instruct',
    provider: 'Meta',
    description: 'Strong coding quality with broad instruction support.',
  },
  {
    id: 'meta/llama-3.1-8b-instruct',
    name: 'Llama 3.1 8B Instruct',
    provider: 'Meta',
    description: 'Fast and economical choice for everyday tasks.',
  },
  {
    id: 'mistralai/mistral-large-2-instruct',
    name: 'Mistral Large 2',
    provider: 'Mistral AI',
    description: 'Multilingual model for code and analysis.',
  },
  {
    id: 'mistralai/mixtral-8x22b-instruct-v0.1',
    name: 'Mixtral 8x22B Instruct',
    provider: 'Mistral AI',
    description: 'Mixture-of-experts model with strong open-model performance.',
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    provider: 'Z.ai',
    description: 'Strong general-purpose model for coding and reasoning via NVIDIA NIM.',
  },
  {
    id: 'minimaxai/minimax-m3',
    name: 'MiniMax M3',
    provider: 'MiniMax',
    description: 'Fast, capable model for coding workflows via NVIDIA NIM.',
  },
];

export const DEPRECATED_MODEL_IDS = new Set([
  'deepseek-ai/deepseek-v4-flash',
  'deepseek-ai/deepseek-v4-pro',
]);

export const RECOMMENDED_MODELS = PREDEFINED_MODELS.filter((model) => [
  'z-ai/glm-5.2',
  'minimaxai/minimax-m3',
].includes(model.id));

export const DEFAULT_REPLACEMENT_MODEL = RECOMMENDED_MODELS[0].id;

export function isDeprecatedModel(modelId) {
  return DEPRECATED_MODEL_IDS.has(modelId);
}

export const CUSTOM_MODEL_INDEX = RECOMMENDED_MODELS.length + 1;

export function modelById(modelId) {
  return PREDEFINED_MODELS.find((model) => model.id === modelId);
}

export function defaultModelChoice(modelId) {
  const index = RECOMMENDED_MODELS.findIndex((model) => model.id === modelId);
  return index >= 0 ? index + 1 : CUSTOM_MODEL_INDEX;
}

export function renderModelChoices(currentModel) {
  const lines = RECOMMENDED_MODELS.map((model, index) => {
    const marker = model.id === currentModel ? '  ← current' : '';
    return `${index + 1}. ${model.name} · ${model.provider} · recommended — ${model.description}${marker}\n   ${model.id}`;
  });
  const customMarker = RECOMMENDED_MODELS.some((model) => model.id === currentModel) ? '' : '  ← current';
  lines.push(`${CUSTOM_MODEL_INDEX}. Custom model ID${customMarker}`);
  return lines;
}
