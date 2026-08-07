import readline from 'node:readline';
import { box } from './ui/box.js';
import { colors } from './ui/colors.js';
import { NvidiaNimClient } from './nvidia.js';
import { CUSTOM_MODEL_INDEX, defaultModelChoice, modelById, RECOMMENDED_MODELS, renderModelChoices } from './models.js';
import { createTerminalRenderer, getTerminalStream } from './ui/terminal-renderer.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  getApiKey,
  normalizeConfig,
  saveConfig,
} from './config.js';

function question(readlineInterface, prompt) {
  return new Promise((resolve) => readlineInterface.question(prompt, resolve));
}

export function createSecretReader({ input, output }) {
  return (prompt = 'Secret: ', { allowEmpty = false } = {}) => new Promise((resolve, reject) => {
    const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');

    if (!interactive) {
      reject(new Error('Secret input requires an interactive terminal.'));
      return;
    }

    let answer = '';
    const wasPaused = input.isPaused?.() ?? false;
    output.write(prompt);
    input.resume();
    input.setRawMode(true);

    const finish = (value, error) => {
      input.setRawMode(false);
      if (wasPaused) input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          finish('', new Error('Configuración cancelada.'));
          return;
        }
        if (byte === 13 || byte === 10) {
          if (answer || allowEmpty) finish(answer);
          return;
        }
        if (byte === 127 || byte === 8) {
          if (answer.length) {
            answer = answer.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (byte >= 32) {
          answer += String.fromCharCode(byte);
          output.write('•');
        }
      }
    };

    input.on('data', onData);
  });
}

export async function chooseModel(readlineInterface, output, currentModel = DEFAULT_MODEL) {
  output.write(`\n${colors.bold('Choose your NVIDIA NIM model')}\n`);
  output.write(`${colors.dim('Recommended NVIDIA NIM models: GLM 5.2 and MiniMax M3. Choose Custom for another catalog ID.')}\n\n`);
  output.write(`${renderModelChoices(currentModel).join('\n')}\n\n`);

  const defaultChoice = defaultModelChoice(currentModel);
  const rawChoice = (await question(
    readlineInterface,
    `Model choice ${colors.dim(`[${defaultChoice}]`)}: `,
  )).trim();
  const choice = rawChoice ? Number(rawChoice) : defaultChoice;

  if (Number.isInteger(choice) && choice >= 1 && choice <= CUSTOM_MODEL_INDEX) {
    if (choice === CUSTOM_MODEL_INDEX) {
      const custom = (await question(
        readlineInterface,
        `Custom model ID ${colors.dim(`[${currentModel}]`)}: `,
      )).trim();
      return custom || currentModel;
    }
    return RECOMMENDED_MODELS[choice - 1]?.id || currentModel;
  }

  output.write(`${colors.amber('⚠')} Invalid model choice; keeping ${currentModel}.\n`);
  return currentModel;
}

async function confirmUnverifiedModel(readlineInterface, output, selectedModel, currentModel, reason) {
  output.write(`${colors.amber('⚠')} ${reason}\n`);
  const answer = (await question(
    readlineInterface,
    `${colors.amber('Save this unverified model anyway?')} ${colors.dim('[y/N]')} `,
  )).trim().toLowerCase();
  return ['y', 'yes', 's', 'si', 'sí'].includes(answer) ? selectedModel : currentModel;
}

async function validateSelectedModel({ readlineInterface, output, currentConfig, selectedModel }) {
  const currentModel = currentConfig.model || DEFAULT_MODEL;
  const preset = modelById(selectedModel);
  const apiKey = getApiKey(currentConfig);
  if (!apiKey) {
    return confirmUnverifiedModel(
      readlineInterface,
      output,
      selectedModel,
      currentModel,
      `${selectedModel} cannot be verified until an NVIDIA API key is configured${preset?.experimental ? ' and is marked experimental' : ''}.`,
    );
  }

  try {
    const availableModels = await new NvidiaNimClient(currentConfig).listModels();
    if (availableModels.includes(selectedModel)) return selectedModel;
    return confirmUnverifiedModel(
      readlineInterface,
      output,
      selectedModel,
      currentModel,
      availableModels.length
        ? `NVIDIA does not list ${selectedModel} for this key/endpoint.`
        : `NVIDIA returned no models, so ${selectedModel} could not be verified.`,
    );
  } catch (error) {
    return confirmUnverifiedModel(
      readlineInterface,
      output,
      selectedModel,
      currentModel,
      `Could not verify the model with NVIDIA: ${colors.slate(error.message)}`,
    );
  }
}

async function askYesNo(readlineInterface, prompt, defaultValue) {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await question(readlineInterface, `${prompt} ${colors.dim(`[${suffix}]`)} `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ['y', 'yes', 's', 'si', 'sí'].includes(answer);
}

export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  currentConfig = normalizeConfig(),
  isFirstRun = false,
  readlineInterface: existingInterface,
} = {}) {
  output = createTerminalRenderer(output);
  const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  let readlineInterface = existingInterface;
  let ownsInterface = false;

  // A TTY must have no readline instance attached while the key is captured.
  if (interactive && readlineInterface && !readlineInterface.closed) {
    readlineInterface.close();
    readlineInterface = undefined;
  }

  if (!interactive && !readlineInterface) {
    readlineInterface = readline.createInterface({
      input,
      output: getTerminalStream(output),
      terminal: false,
    });
    ownsInterface = true;
  }

  const readSecret = createSecretReader({ input, output });
  const existingKey = getApiKey(currentConfig);

  output.write(`\n${box([
    colors.white(isFirstRun ? 'Configure your AI provider to get started.' : 'Update your Luciano Code AI preferences.'),
    colors.slate('Your key stays local and is never printed in full.'),
    colors.amber('Local storage uses permissions 600; use NVIDIA_API_KEY on shared machines.'),
    '',
    colors.slate('Need a key? Open https://build.nvidia.com/settings/api-keys'),
  ], { title: 'NVIDIA NIM setup', width: 58, tone: 'green' })}\n\n`);

  try {
    let apiKey = currentConfig.apiKey;
    if (process.env.NVIDIA_API_KEY?.trim()) {
      output.write(`${colors.green('✓')} ${colors.slate('NVIDIA_API_KEY detected in your environment; it will be used as an override.')}\n`);
    } else if (existingKey && !interactive) {
      // Non-interactive setup is not exposed by the CLI, but never attempts to read a secret.
      apiKey = currentConfig.apiKey;
    } else if (interactive) {
      const keyPrompt = existingKey
        ? `NVIDIA API key ${colors.dim('(Enter to keep current)')}: `
        : `NVIDIA API key (Enter to configure later) · ${colors.dim('Get one at build.nvidia.com/settings/api-keys')}: `;
      const enteredKey = await readSecret(keyPrompt, { allowEmpty: true });
      if (enteredKey) apiKey = enteredKey;
    }

    if (!readlineInterface) {
      readlineInterface = readline.createInterface({
        input,
        output: getTerminalStream(output),
        terminal: true,
      });
      ownsInterface = true;
    }

    const selectedModel = await chooseModel(
      readlineInterface,
      output,
      currentConfig.model || DEFAULT_MODEL,
    );
    const model = await validateSelectedModel({
      readlineInterface,
      output,
      currentConfig: { ...currentConfig, apiKey },
      selectedModel,
    });

    const requestedLanguage = (await question(
      readlineInterface,
      `Response language ${colors.dim(`[${currentConfig.preferences.language}]`)} (es/en): `,
    )).trim().toLowerCase();
    const language = ['es', 'en'].includes(requestedLanguage)
      ? requestedLanguage
      : currentConfig.preferences.language;
    if (requestedLanguage && !['es', 'en'].includes(requestedLanguage)) {
      output.write(`${colors.amber('⚠')} Language must be es or en; keeping ${language}.\n`);
    }

    const temperatureInput = (await question(
      readlineInterface,
      `Temperature ${colors.dim(`[${currentConfig.preferences.temperature}]`)} (0–2): `,
    )).trim();
    const requestedTemperature = temperatureInput ? Number(temperatureInput) : currentConfig.preferences.temperature;
    const temperature = Number.isFinite(requestedTemperature)
      ? Math.min(2, Math.max(0, requestedTemperature))
      : currentConfig.preferences.temperature;
    if (temperatureInput && !Number.isFinite(requestedTemperature)) {
      output.write(`${colors.amber('⚠')} Temperature must be a number from 0 to 2; keeping ${temperature}.\n`);
    }
    const stream = await askYesNo(readlineInterface, 'Stream responses in the terminal?', currentConfig.preferences.stream);
    const noThink = await askYesNo(
      readlineInterface,
      'Disable model reasoning/thinking when supported?',
      currentConfig.preferences.noThink,
    );

    const saved = await saveConfig({
      ...currentConfig,
      apiKey,
      baseUrl: currentConfig.baseUrl || DEFAULT_BASE_URL,
      model,
      preferences: { ...currentConfig.preferences, language, temperature, stream, noThink },
    });

    output.write(`\n${colors.green('✓')} Configuration saved to ${colors.dim('~/.config/luciano-code/config.json')}\n`);
    return saved;
  } finally {
    if (ownsInterface && readlineInterface && !readlineInterface.closed) readlineInterface.close();
  }
}

export async function runKeySetup({
  input = process.stdin,
  output = process.stdout,
  currentConfig = normalizeConfig(),
  readlineInterface: existingInterface,
} = {}) {
  output = createTerminalRenderer(output);
  const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  let readlineInterface = existingInterface;
  let ownsInterface = false;

  if (interactive && readlineInterface && !readlineInterface.closed) {
    readlineInterface.close();
    readlineInterface = undefined;
  }

  if (!interactive && !readlineInterface) {
    throw new Error('key set requires an interactive terminal.');
  }

  const readSecret = createSecretReader({ input, output });

  try {
    output.write(`\n${colors.bold('NVIDIA API key')}\n`);
    output.write(`${colors.slate('The key is stored locally with restricted permissions and never printed in full.')}\n`);
    output.write(`${colors.dim('Create one at https://build.nvidia.com/settings/api-keys')}\n`);
    const apiKey = await readSecret('New NVIDIA API key (Enter to cancel): ', { allowEmpty: true });
    if (!apiKey) {
      output.write(`${colors.dim('No changes made.')}\n`);
      return currentConfig;
    }
    const saved = await saveConfig({ ...currentConfig, apiKey });
    output.write(`${colors.green('✓')} Key updated (${colors.dim('local config')}).\n`);
    if (process.env.NVIDIA_API_KEY?.trim()) {
      output.write(`${colors.amber('⚠')} NVIDIA_API_KEY is still the active environment override. Run ${colors.green('unset NVIDIA_API_KEY')} in your shell to use this local key.\n`);
    }
    return saved;
  } finally {
    if (ownsInterface && readlineInterface && !readlineInterface.closed) readlineInterface.close();
  }
}
