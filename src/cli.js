import readline from 'node:readline';
import { runDemo } from './demo.js';
import { runPrompt, runWorkspaceAnalysis } from './agent.js';
import { hasNvidiaDataConsent, loadConfig, normalizeConfig, normalizeMaxTokens, saveConfig, setNvidiaDataConsent, MAX_TOKENS_MIN, MAX_TOKENS_MAX } from './config.js';
import { renderConsentStatus } from './consent.js';
import {
  clearCurrentConversation,
  listConversationHistory,
  resumeLatestConversation,
  startNewConversation,
} from './memory.js';
import { chooseModel, runKeySetup, runSetup } from './setup.js';
import { NvidiaNimClient } from './nvidia.js';
import { renderConfig, renderHelp, renderStatus } from './ui/banner.js';
import { renderTrustStatus, revokeCurrentFolderTrust } from './trust.js';
import { colors } from './ui/colors.js';
import { toolInstructions } from './tools.js';
import { createTerminalRenderer, getTerminalStream } from './ui/terminal-renderer.js';

const PROMPT = `${colors.green('luciano-code')} ${colors.dim('>')} `;
const ACCEPTED = new Set(['y', 'yes', 's', 'si', 'sí']);

export function parseCommandInput(rawInput) {
  const rawText = String(rawInput ?? '');
  if (!rawText.startsWith('/')) return { type: 'prompt', text: rawText.trim() };

  const parts = rawText.slice(1).trim().split(/\s+/).filter(Boolean);
  return {
    type: 'command',
    command: (parts.shift() || '').toLowerCase(),
    args: parts,
    text: rawText.trim(),
  };
}

function clearTerminal(stream) {
  stream.clear?.();
}

export function createCli({
  input = process.stdin,
  output = process.stdout,
  config = normalizeConfig(),
  memoryBaseDir,
  readlineInterface: existingInterface,
} = {}) {
  output = createTerminalRenderer(output);
  let readlineInterface;
  let commandQueue = Promise.resolve();
  let activeConfig = normalizeConfig(config);
  let restarting = false;

  const handleCommand = async (rawInput) => {
    const rawText = String(rawInput ?? '');
    if (!rawText.trim()) return;

    const parsedInput = parseCommandInput(rawText);
    if (parsedInput.type === 'prompt') {
      await runPrompt(parsedInput.text, activeConfig, output, {
        input,
        readlineInterface,
        ask,
        memoryBaseDir,
      });
      return;
    }

    const { command, args: parts } = parsedInput;
    if (!command) {
      output.write(`${colors.dim('Type /help to see available commands.')}\n`);
      return;
    }

    try {
      switch (command) {
        case 'help':
        case '?':
          output.write(`\n${renderHelp()}\n`);
          break;
        case 'setup':
          if (!input.isTTY || !output.isTTY) {
            output.write(`${colors.amber('⚠')} setup requires an interactive terminal. Run ${colors.green('luciano-code')} directly.\n`);
            break;
          }
          restarting = true;
          readlineInterface.close();
          activeConfig = await runSetup({
            input,
            output,
            currentConfig: activeConfig,
            isFirstRun: false,
          });
          readlineInterface = createReadline();
          restarting = false;
          break;
        case 'key':
          if (parts[0]?.toLowerCase() !== 'set') {
            output.write(`${colors.dim('Usage:')} ${colors.green('key set')}\n`);
            break;
          }
          if (!input.isTTY || !output.isTTY) {
            output.write(`${colors.amber('⚠')} key set requires an interactive terminal. Run ${colors.green('luciano-code')} directly.\n`);
            break;
          }
          restarting = true;
          readlineInterface.close();
          activeConfig = await runKeySetup({ input, output, currentConfig: activeConfig });
          readlineInterface = createReadline();
          restarting = false;
          break;
        case 'nothink':
          {
            const mode = parts[0]?.toLowerCase();
            if (!mode || mode === 'status') {
              output.write(`${colors.dim('No-think mode:')} ${colors.white(activeConfig.preferences.noThink ? 'enabled' : 'disabled')}\n`);
              break;
            }
            if (!['on', 'off'].includes(mode)) {
              output.write(`${colors.dim('Usage:')} ${colors.green('nothink on')} · ${colors.green('nothink off')} · ${colors.green('nothink status')}\n`);
              break;
            }
            activeConfig = await saveConfig({
              ...activeConfig,
              preferences: { ...activeConfig.preferences, noThink: mode === 'on' },
            });
            output.write(`${colors.green('✓')} No-think mode ${colors.white(mode === 'on' ? 'enabled' : 'disabled')}.\n`);
          }
          break;
        case 'tokens':
          {
            const mode = parts[0]?.toLowerCase();
            if (!mode || mode === 'status') {
              output.write(`${colors.dim('Max output tokens:')} ${colors.white(activeConfig.preferences.maxTokens)} ${colors.dim(`(range ${MAX_TOKENS_MIN}–${MAX_TOKENS_MAX})`)}\n`);
              output.write(`${colors.dim('Change with:')} ${colors.green('/tokens set <number>')}\n`);
              break;
            }
            const rawValue = mode === 'set' ? parts[1] : mode;
            const requested = Number(rawValue);
            if (mode !== 'set' && !/^\d+$/.test(mode)) {
              output.write(`${colors.dim('Usage:')} ${colors.green('/tokens set <number>')} · ${colors.green('/tokens status')}\n`);
              break;
            }
            if (!Number.isFinite(requested) || requested <= 0) {
              output.write(`${colors.amber('⚠')} Provide a positive number of tokens.\n`);
              output.write(`${colors.dim('Usage:')} ${colors.green('/tokens set <number>')} · ${colors.green('/tokens status')}\n`);
              break;
            }
            const clamped = normalizeMaxTokens(requested);
            activeConfig = await saveConfig({
              ...activeConfig,
              preferences: { ...activeConfig.preferences, maxTokens: clamped },
            });
            const note = clamped !== Math.floor(requested)
              ? ` ${colors.dim(`(clamped to range ${MAX_TOKENS_MIN}–${MAX_TOKENS_MAX})`)}`
              : '';
            output.write(`${colors.green('✓')} Max output tokens set to ${colors.white(clamped)}${note}.\n`);
          }
          break;
        case 'model':
          if (parts[0]?.toLowerCase() !== 'set') {
            output.write(`${colors.dim('Usage:')} ${colors.green('model set [<model-id>]')}\n`);
            break;
          }
          {
            const model = parts.slice(1).join(' ').trim()
              || await chooseModel(readlineInterface, output, activeConfig.model);
            if (model.trim()) {
              const requestedModel = model.trim();
              try {
                if (!hasNvidiaDataConsent(activeConfig)) {
                  output.write(`${colors.amber('⚠')} NVIDIA data-sharing consent is required before contacting NVIDIA. Use ${colors.green('/consent accept')}.\n`);
                  break;
                }
                const availableModels = await new NvidiaNimClient(activeConfig).listModels();
                if (!availableModels.includes(requestedModel)) {
                  output.write(`${colors.amber('⚠')} ${availableModels.length
                    ? `Model ${colors.white(requestedModel)} is not available in NVIDIA NIM.`
                    : `NVIDIA returned no models, so ${colors.white(requestedModel)} could not be verified.`} Run ${colors.green('models')} to inspect the active catalog.\n`);
                  if (!input.isTTY || !output.isTTY) {
                    output.write(`${colors.dim('Model not changed because this session is non-interactive.')}\n`);
                    break;
                  }
                  const confirmation = (await ask(
                    `${colors.amber('Save this unverified model ID anyway?')} ${colors.dim('[y/N]')} `,
                  )).trim().toLowerCase();
                  if (!['y', 'yes', 's', 'si', 'sí'].includes(confirmation)) {
                    output.write(`${colors.dim('Model not changed.')}\n`);
                    break;
                  }
                }
              } catch (error) {
                output.write(`${colors.amber('⚠')} Could not validate the model against NVIDIA NIM: ${colors.slate(error.message)}\n`);
                if (!input.isTTY || !output.isTTY) {
                  output.write(`${colors.dim('Model not changed because this session is non-interactive.')}\n`);
                  break;
                }
                const confirmation = (await ask(
                  `${colors.amber('Save this unverified model ID anyway?')} ${colors.dim('[y/N]')} `,
                )).trim().toLowerCase();
                if (!['y', 'yes', 's', 'si', 'sí'].includes(confirmation)) {
                  output.write(`${colors.dim('Model not changed.')}\n`);
                  break;
                }
              }
              activeConfig = await saveConfig({ ...activeConfig, model: requestedModel });
              output.write(`${colors.green('✓')} Active model updated to ${colors.white(activeConfig.model)}\n`);
            }
          }
          break;
        case 'config': {
          const sub = parts[0]?.toLowerCase();
          if (sub === 'search') {
            const action = parts[1]?.toLowerCase();
            if (action !== 'set') {
              output.write(`${colors.dim('Usage:')} ${colors.green('/config search set <searxng-url>')}\n`);
              output.write(`${colors.dim('Current search endpoint:')} ${colors.white(activeConfig.preferences.searxngUrl)}\n`);
              break;
            }
            const rawUrl = parts.slice(2).join(' ').trim().replace(/^["']|["']$/g, '').trim();
            if (!rawUrl) {
              output.write(`${colors.amber('⚠')} A SearXNG JSON URL is required, e.g. ${colors.green('/config search set https://example.com/search')}.\n`);
              break;
            }
            let parsed;
            try {
              parsed = new URL(rawUrl);
            } catch {
              output.write(`${colors.amber('⚠')} That does not look like a valid URL.\n`);
              break;
            }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              output.write(`${colors.amber('⚠')} The URL must use http or https.\n`);
              break;
            }
            const normalizedUrl = rawUrl.replace(/\/+$/, '');
            activeConfig = await saveConfig({
              ...activeConfig,
              preferences: { ...activeConfig.preferences, searxngUrl: normalizedUrl },
            });
            output.write(`${colors.green('✓')} Web search endpoint set to ${colors.white(activeConfig.preferences.searxngUrl)}.\n`);
            break;
          }
          output.write(`\n${renderConfig(activeConfig)}\n`);
          break;
        }
        case 'consent':
          if (!parts[0]) {
            output.write(`${renderConsentStatus(activeConfig)}\n`);
            break;
          }
          if (!['accept', 'decline'].includes(parts[0].toLowerCase())) {
            output.write(`${colors.dim('Usage:')} ${colors.green('/consent accept')} · ${colors.green('/consent decline')}\n`);
            break;
          }
          activeConfig = await saveConfig(setNvidiaDataConsent(
            activeConfig,
            parts[0].toLowerCase() === 'accept' ? 'accepted' : 'declined',
          ));
          output.write(`${renderConsentStatus(activeConfig)}\n`);
          break;
        case 'history': {
          const history = await listConversationHistory(memoryBaseDir ? { baseDir: memoryBaseDir } : {});
          if (!history.length) {
            output.write(`${colors.dim('Conversation history is empty.')}\n`);
            break;
          }
          output.write(`\n${colors.bold('Conversation History')}\n`);
          for (const item of history) {
            const date = new Date(item.updatedAt).toLocaleString();
            output.write(`${item.current ? colors.green('●') : colors.dim('·')} ${colors.white(item.title)} ${colors.dim(`· ${date} · ${item.messageCount} messages`)}\n`);
          }
          break;
        }
        case 'clear': {
          if (!input.isTTY || !output.isTTY) {
            output.write(`${colors.amber('⚠')} /clear requires confirmation in an interactive terminal.\n`);
            break;
          }
          const answer = (await ask(`${colors.amber('Clear the current conversation?')} ${colors.dim('[y/N]')} `)).trim().toLowerCase();
          if (!ACCEPTED.has(answer)) {
            output.write(`${colors.dim('Conversation kept.')}\n`);
            break;
          }
          await clearCurrentConversation(memoryBaseDir ? { baseDir: memoryBaseDir } : {});
          output.write(`${colors.green('✓')} Current conversation cleared and archived locally.\n`);
          break;
        }
        case 'new':
          await startNewConversation(memoryBaseDir ? { baseDir: memoryBaseDir } : {});
          output.write(`${colors.green('✓')} New conversation started.\n`);
          break;
        case 'resume': {
          const conversation = await resumeLatestConversation(memoryBaseDir ? { baseDir: memoryBaseDir } : {});
          output.write(conversation.messages.length
            ? `${colors.green('✓')} Resumed the latest local conversation (${conversation.messages.length} messages).\n`
            : `${colors.dim('No saved conversation is available to resume.')}\n`);
          break;
        }
        case 'models':
          if (!hasNvidiaDataConsent(activeConfig)) {
            output.write(`${colors.amber('⚠')} NVIDIA data-sharing consent is required before contacting NVIDIA. Use ${colors.green('/consent accept')}.\n`);
            break;
          }
          await showModels(activeConfig, output);
          break;
        case 'tools':
          output.write(`\n${toolInstructions(activeConfig)}\n`);
          output.write(`${colors.dim('Authorization:')} ${colors.green('y')} approve once · ${colors.green('a')} approve tools for this session · ${colors.green('n')} reject\n`);
          break;
        case 'trust':
          if (parts[0]?.toLowerCase() === 'reset') {
            if (!input.isTTY || !output.isTTY) {
              output.write(`${colors.amber('⚠')} trust reset requires an interactive terminal.\n`);
              break;
            }
            activeConfig = await revokeCurrentFolderTrust(activeConfig);
            output.write(`${colors.green('✓')} Current folder trust revoked. It will be checked again on next launch.\n`);
          } else {
            output.write(`\n${renderTrustStatus(activeConfig)}\n`);
          }
          break;
        case 'demo':
          await runDemo(output, {
            config: activeConfig,
            input,
            readlineInterface,
            ask,
            memoryBaseDir,
          });
          break;
        case 'analyze':
        case 'analiza':
          await runWorkspaceAnalysis(activeConfig, output, {
            input,
            readlineInterface,
            ask,
            memoryBaseDir,
          });
          break;
        case 'status':
          output.write(`\n${renderStatus(activeConfig)}\n`);
          break;
        case 'screen':
          clearTerminal(output);
          break;
        case 'exit':
        case 'quit':
          output.write(`\n${colors.green('✓')} ${colors.slate('Goodbye. Keep building.')}\n`);
          readlineInterface.close();
          return;
        default:
          output.write(`${colors.amber('⚠')} Unknown command ${colors.white(`/${command}`)}. Use ${colors.green('/help')}.\n`);
      }
    } finally {
      if (!readlineInterface.closed) readlineInterface.prompt();
    }
  };

  const ask = (prompt) => new Promise((resolve) => readlineInterface.question(prompt, resolve));

  const showModels = async (currentConfig, stream) => {
    try {
      const models = await new NvidiaNimClient(currentConfig).listModels();
      if (!models.length) {
        stream.write(`${colors.amber('⚠')} NVIDIA returned no available models.\n`);
        return;
      }
      stream.write(`\n${colors.bold('Available NVIDIA NIM models')}\n`);
      stream.write(`${models.map((model) => `  ${colors.green('·')} ${model}`).join('\n')}\n`);
      stream.write(`${colors.dim('Use:')} ${colors.green('model set <model-id>')}\n`);
    } catch (error) {
      stream.write(`${colors.red('✗')} ${colors.slate(error.message)}\n`);
    }
  };

  const createReadline = (reusableInterface) => {
    const nextInterface = reusableInterface && !reusableInterface.closed
      ? reusableInterface
      : readline.createInterface({
        input,
        output: getTerminalStream(output),
        terminal: Boolean(output.isTTY),
      });
    nextInterface.setPrompt(PROMPT);
    nextInterface.on('line', (line) => {
      commandQueue = commandQueue
        .then(() => handleCommand(line))
        .catch((error) => {
          output.write(`${colors.red('✗')} ${colors.slate(error.message)}\n`);
        });
    });
    nextInterface.on('close', () => {
      if (input.isTTY && !restarting) output.write('\n');
    });
    return nextInterface;
  };

  readlineInterface = createReadline(existingInterface);

  return {
    start() {
      readlineInterface.prompt();
      return readlineInterface;
    },
    close() {
      readlineInterface.close();
    },
    getConfig() {
      return activeConfig;
    },
  };
}

export async function loadCliConfig() {
  const { config, exists } = await loadConfig();
  return { config, exists };
}
