import readline from 'node:readline';
import { runDemo } from './demo.js';
import { buildSystemPrompt, runPrompt, runWorkspaceAnalysis } from './agent.js';
import { CloudClient, CLOUD_SESSION_EXPIRED_MESSAGE, CLOUD_THREAD_NOT_FOUND_MESSAGE, findCloudRepo, formatCloudUpdatedAt, validateCloudRepo } from './cloud.js';
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
import { renderMarkdown } from './ui/markdown.js';
import { toolInstructions } from './tools.js';
import { createTerminalRenderer, getTerminalStream } from './ui/terminal-renderer.js';
import {
  accountIdentity,
  clearAuth,
  setSessionApiKey,
  syncAccountSettings,
  updateAccountConfig,
  updateAccountKey,
  updateAccountModel,
  updateAccountSystemPrompt,
  clearSessionApiKey,
  loadAuth,
  runLoginFlow,
} from './auth.js';
import { setSystemPrompt } from './memory.js';

const PROMPT = `${colors.green('You')} ${colors.dim('>')} `;
const ACCEPTED = new Set(['y', 'yes', 's', 'si', 'sí']);

function comparableJson(value) {
  return JSON.stringify(value);
}

function parseConfigBlob(blob) {
  if (typeof blob !== 'string') return null;
  try {
    return JSON.parse(blob);
  } catch {
    return undefined;
  }
}

function accountPromptValue(payload) {
  return typeof payload?.prompt === 'string' && payload.prompt.length ? payload.prompt : null;
}

function localConfigBlob(config) {
  return JSON.stringify(config);
}

async function askSyncResolution(ask, label) {
  const answer = (await ask(
    `Local and account ${label} differ.\n1) Pull from account (overwrite local)\n2) Push local to account (overwrite account)\n> `,
  )).trim();
  if (answer === '1') return 'pull';
  if (answer === '2') return 'push';
  return null;
}

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

function cloudMessageContent(message) {
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  return '';
}

function renderCloudHistory(thread, stream) {
  const messages = Array.isArray(thread?.uiMessages) ? thread.uiMessages : [];
  if (!messages.length) {
    stream.write(`${colors.dim('Cloud session has no visible messages yet.')}\n`);
    return;
  }
  stream.write(`\n${colors.bold('Cloud session history')}\n`);
  for (const message of messages) {
    const role = message?.role === 'user' ? 'You' : message?.role === 'assistant' ? 'Coder' : message?.role || 'Message';
    const content = cloudMessageContent(message);
    if (!content) continue;
    const rendered = role === 'Coder' ? renderMarkdown(content) : content;
    stream.write(`\n${colors.brightGreen(role)} ${colors.dim('›')}\n${rendered}\n`);
  }
  stream.write('\n');
}

function cloudThreadLabel(thread, index) {
  return `${index + 1}. ${thread.title} · ${thread.status} · ${formatCloudUpdatedAt(thread.updatedAt)} · ID: ${thread.threadId}`;
}

export async function chooseCloudThread(threads, ask, output) {
  if (threads.length === 1) return threads[0];
  output.write(`\n${colors.bold('Choose a Cloud session')}\n`);
  threads.forEach((thread, index) => output.write(`${cloudThreadLabel(thread, index)}\n`));
  const answer = (await ask(`Session ${colors.dim(`[1-${threads.length}]`)}: `)).trim();
  const choice = Number(answer);
  if (!Number.isInteger(choice) || choice < 1 || choice > threads.length) {
    output.write(`${colors.amber('⚠')} Invalid Cloud session choice.\n`);
    return null;
  }
  return threads[choice - 1];
}

export function createCli({
  input = process.stdin,
  output = process.stdout,
  config = normalizeConfig(),
  memoryBaseDir,
  manualModel,
  configExists = true,
  accountSyncOptions = {},
  readlineInterface: existingInterface,
  cloudClient: injectedCloudClient,
} = {}) {
  output = createTerminalRenderer(output);
  let readlineInterface;
  let commandQueue = Promise.resolve();
  let activeConfig = normalizeConfig(config);
  let localConfigExists = configExists;
  const fallbackModel = manualModel || activeConfig.model;
  let restarting = false;
  const cloudClient = injectedCloudClient || new CloudClient();
  let activeCloudSession = null;

  const handleCloudError = async (error, { threadRequest = false } = {}) => {
    if (error?.status === 401 || error?.sessionExpired || error?.message === CLOUD_SESSION_EXPIRED_MESSAGE) {
      output.write(`${colors.amber('⚠')} ${CLOUD_SESSION_EXPIRED_MESSAGE}\n`);
      activeCloudSession = null;
      return;
    }
    if (error?.status === 404 && threadRequest) {
      output.write(`${colors.amber('⚠')} ${CLOUD_THREAD_NOT_FOUND_MESSAGE}\n`);
      activeCloudSession = null;
      return;
    }
    output.write(`${colors.red('✗')} ${colors.slate(error.message)}\n`);
  };

  const loadCloudSession = async (repo, requestedThreadId, hybrid) => {
    activeCloudSession = null;
    const validRepo = validateCloudRepo(repo);
    let thread;
    let selectedThreadId = requestedThreadId;
    let syncThreadId = requestedThreadId;
    if (requestedThreadId) {
      try {
        thread = await cloudClient.getThread(validRepo, requestedThreadId);
      } catch (error) {
        // Some backend deployments expose 32-character session IDs while the
        // direct lookup still recognizes only the legacy 24-character shape.
        // The API documents title lookup as a fallback, so resolve the exact
        // listed session and retry with its authoritative title.
        if (error?.status !== 404 || requestedThreadId.length <= 24) throw error;
        const listedThreads = await cloudClient.listThreads(validRepo);
        const listedThread = listedThreads.find((item) => item.threadId === requestedThreadId);
        if (!listedThread?.title) throw error;
        syncThreadId = listedThread.title;
        thread = await cloudClient.getThread(validRepo, syncThreadId);
      }
    } else {
      const threads = await cloudClient.listThreads(validRepo);
      if (!threads.length) {
        output.write(`No Cloud sessions found for ${validRepo}. Use /cloud use to start one.\n`);
        return false;
      }
      const selected = await chooseCloudThread(threads, ask, output);
      if (!selected) return false;
      selectedThreadId = selected.threadId;
      syncThreadId = selectedThreadId;
      thread = await cloudClient.getThread(validRepo, selectedThreadId);
    }

    activeCloudSession = {
      repo: validRepo,
      threadId: syncThreadId || thread.threadId || selectedThreadId || '',
      hybrid,
      llmMessages: Array.isArray(thread.llmMessages)
        ? thread.llmMessages.map((message) => ({ ...message }))
        : [],
    };
    renderCloudHistory(thread, output);
    output.write(`${colors.green('✓')} Cloud session loaded in ${hybrid ? 'hybrid' : 'local'} mode. Changes stay on this machine.\n`);
    return true;
  };

  const resolveCloudRepo = async (repo) => {
    const validRepo = validateCloudRepo(repo);
    const repos = await cloudClient.listRepos();
    const match = findCloudRepo(repos, validRepo);
    if (!match) {
      output.write(`${colors.amber('⚠')} ${validRepo} is not connected. Connect it first from code.lucianopm.com/cloud.\n`);
      return null;
    }
    // The API accepts short names, but the documented canonical identifier is
    // fullName. Resolve it once so every Cloud command queries the same repo.
    return match.fullName || match.repo || validRepo;
  };

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
        cloudLlmMessages: activeCloudSession?.llmMessages,
        onTurnComplete: activeCloudSession
          ? async ({ messages, llmMessages = [] }) => {
            if (llmMessages.length) activeCloudSession.llmMessages.push(...llmMessages);
            else activeCloudSession.llmMessages.push(...messages);
            if (activeCloudSession.hybrid) {
              await cloudClient.appendMessages(
                activeCloudSession.repo,
                activeCloudSession.threadId,
                messages,
              );
            }
          }
          : undefined,
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
        case 'login':
          if (!input.isTTY || !output.isTTY) {
            output.write(`${colors.amber('⚠')} /login requires an interactive terminal. Run ${colors.green('luciano-code')} directly.\n`);
            break;
          }
          await runLoginFlow({ ask, output });
          break;
        case 'sync': {
          const result = await syncAccountSettings({ output, ...accountSyncOptions });
          if (!result.authenticated) {
            activeConfig = normalizeConfig({ ...activeConfig, model: fallbackModel });
            if (!result.expired) {
              output.write(`${colors.amber('⚠')} No account session found. Run ${colors.green('/login')} first.\n`);
            }
            break;
          }
          if (!result.settings) break;

          const { key: accountKey, config: accountConfig, systemPrompt: accountSystemPrompt } = result.settings;
          const localSnapshot = normalizeConfig(activeConfig);
          const hadLocalConfig = localConfigExists;
          const localKey = hadLocalConfig && localSnapshot.apiKey ? localSnapshot.apiKey : null;
          const accountApiKey = typeof accountKey?.apiKey === 'string' && accountKey.apiKey.trim()
            ? accountKey.apiKey.trim()
            : null;
          const localModel = hadLocalConfig && localSnapshot.model ? localSnapshot.model : null;
          const accountModel = typeof accountKey?.model === 'string' && accountKey.model.trim()
            ? accountKey.model.trim()
            : null;
          const keyModelDiffer = localKey !== accountApiKey || localModel !== accountModel;

          if (keyModelDiffer) {
            let resolution = null;
            if (!localKey && !localModel && (accountApiKey || accountModel)) resolution = 'pull';
            else if (!accountApiKey && !accountModel && (localKey || localModel)) resolution = 'push';
            else resolution = await askSyncResolution(ask, 'key');

            if (resolution === 'pull') {
              activeConfig = await saveConfig({
                ...activeConfig,
                ...(accountApiKey ? { apiKey: accountApiKey } : { apiKey: '' }),
                ...(accountModel ? { model: accountModel } : {}),
              });
              localConfigExists = true;
              output.write(`${colors.green('✓')} Key/model pulled from account.\n`);
            } else if (resolution === 'push') {
              if (localKey) await updateAccountKey(result.auth.token, localKey, accountSyncOptions);
              if (localModel) await updateAccountModel(result.auth.token, localModel, accountSyncOptions);
              output.write(`${colors.green('✓')} Key/model pushed to account.\n`);
            } else {
              output.write(`${colors.amber('⚠')} Key/model left unchanged.\n`);
            }
            setSessionApiKey(activeConfig.apiKey || '');
          }

          const localConfig = localSnapshot;
          const localBlob = localConfigBlob(activeConfig);
          const accountBlob = typeof accountConfig?.blob === 'string' ? accountConfig.blob : null;
          const parsedAccountBlob = parseConfigBlob(accountBlob);
          let configResolution = null;
          if (accountBlob !== null && parsedAccountBlob === undefined) {
            output.write(`${colors.amber('⚠')} Account config is not valid JSON; config was left unchanged.\n`);
          } else if (!hadLocalConfig && accountBlob !== null) configResolution = 'pull';
          else if (hadLocalConfig && accountBlob === null) configResolution = 'push';
          else if (accountBlob !== null && comparableJson(parsedAccountBlob) !== comparableJson(localConfig)) {
            configResolution = await askSyncResolution(ask, 'config');
          }

          if (configResolution === 'pull') {
            const resolvedKey = activeConfig.apiKey;
            const resolvedModel = activeConfig.model;
            activeConfig = await saveConfig({
              ...parsedAccountBlob,
              apiKey: resolvedKey,
              model: resolvedModel,
              systemPrompt: localSnapshot.systemPrompt,
            });
            localConfigExists = true;
            output.write(`${colors.green('✓')} Config pulled from account.\n`);
          } else if (configResolution === 'push') {
            await updateAccountConfig(result.auth.token, localBlob, accountSyncOptions);
            output.write(`${colors.green('✓')} Config pushed to account.\n`);
          } else if (configResolution === null && accountBlob !== null && parsedAccountBlob !== undefined
            && comparableJson(parsedAccountBlob) === comparableJson(localConfig)) {
            output.write(`${colors.dim('✓ Config already synchronized.')}\n`);
          }

          const localPrompt = activeConfig.systemPrompt;
          const accountPrompt = accountPromptValue(accountSystemPrompt);
          let promptResolution = null;
          if (!localPrompt && accountPrompt) promptResolution = 'pull';
          else if (localPrompt && !accountPrompt) promptResolution = 'push';
          else if (localPrompt && accountPrompt && localPrompt !== accountPrompt) {
            promptResolution = await askSyncResolution(ask, 'system prompt');
          }

          if (promptResolution === 'pull') {
            activeConfig = await saveConfig({ ...activeConfig, systemPrompt: accountPrompt });
            await setSystemPrompt(buildSystemPrompt(activeConfig), memoryBaseDir ? { baseDir: memoryBaseDir } : {});
            localConfigExists = true;
            output.write(`${colors.green('✓')} System prompt pulled from account.\n`);
          } else if (promptResolution === 'push') {
            await updateAccountSystemPrompt(result.auth.token, localPrompt || '', accountSyncOptions);
            output.write(`${colors.green('✓')} System prompt pushed to account.\n`);
          } else if (localPrompt && accountPrompt === localPrompt) {
            output.write(`${colors.dim('✓ System prompt already synchronized.')}\n`);
          }
          break;
        }
        case 'cloud': {
          const action = parts[0]?.toLowerCase();
          if (action === 'repos') {
            if (parts.length > 1) {
              output.write(`${colors.dim('Usage:')} ${colors.green('/cloud repos')}\n`);
              break;
            }
            try {
              const repos = await cloudClient.listRepos();
              if (!repos.length) {
                output.write(`${colors.dim('No Cloud repositories are connected.')}\n`);
                break;
              }
              output.write(`\n${colors.bold('Connected Cloud repositories')}\n`);
              for (const item of repos) output.write(`${colors.green('·')} ${colors.white(item.fullName || item.repo)}\n`);
            } catch (error) {
              await handleCloudError(error);
            }
            break;
          }

          const repo = parts[1];
          if (action === 'threads') {
            if (!repo || parts.length > 2) {
              output.write(`${colors.dim('Usage:')} ${colors.green('/cloud threads <repo>')}\n`);
              break;
            }
            try {
              const canonicalRepo = await resolveCloudRepo(repo);
              if (!canonicalRepo) break;
              const threads = await cloudClient.listThreads(canonicalRepo);
              if (!threads.length) {
                output.write(`No Cloud sessions found for ${canonicalRepo}.\n`);
                break;
              }
              output.write(`\n${colors.bold(`Cloud sessions for ${canonicalRepo}`)}\n`);
              threads.forEach((thread, index) => output.write(`${cloudThreadLabel(thread, index)}\n`));
            } catch (error) {
              await handleCloudError(error);
            }
            break;
          }

          if (!['continue', 'use'].includes(action)) {
            output.write(`${colors.dim('Usage:')} ${colors.green('/cloud repos')} · ${colors.green('/cloud threads <repo>')} · ${colors.green('/cloud continue <repo>')} · ${colors.green('/cloud use <repo> [t <threadId>]')}\n`);
            break;
          }
          if (!repo) {
            output.write(`${colors.amber('⚠')} A repository name is required.\n`);
            break;
          }
          try {
            const validRepo = validateCloudRepo(repo);
            let threadId;
            let hybrid = action === 'use';
            let sessionRepo = validRepo;
            const canonicalRepo = await resolveCloudRepo(validRepo);
            if (!canonicalRepo) break;
            sessionRepo = canonicalRepo;
            if (action === 'use') {
              if (parts[2]?.toLowerCase() === 't') {
                threadId = parts[3];
                if (parts.length > 4) {
                  output.write(`${colors.amber('⚠')} Usage: ${colors.green('/cloud use <repo> [t <threadId>]')}\n`);
                  break;
                }
                if (parts.length === 3) {
                  // `/cloud use repo t` means list and choose; never invent an ID.
                  threadId = undefined;
                }
              } else if (parts.length > 2) {
                output.write(`${colors.amber('⚠')} Usage: ${colors.green('/cloud use <repo> [t <threadId>]')}\n`);
                break;
              }
            } else if (parts.length > 2) {
              output.write(`${colors.amber('⚠')} Usage: ${colors.green('/cloud continue <repo>')}\n`);
              break;
            }
            await loadCloudSession(sessionRepo, threadId, hybrid);
          } catch (error) {
            await handleCloudError(error, { threadRequest: true });
          }
          break;
        }
        case 'whoami': {
          const auth = await loadAuth();
          const identity = accountIdentity(auth?.account);
          output.write(identity
            ? `${colors.green('✓')} Signed in as ${colors.white(identity)}.\n`
            : `${colors.dim('No account identity is available. Run /login to sign in.')}\n`);
          break;
        }
        case 'logout': {
          const removed = await clearAuth();
          clearSessionApiKey();
          activeConfig = normalizeConfig({ ...activeConfig, model: fallbackModel });
          output.write(removed
            ? `${colors.green('✓')} Signed out.\n`
            : `${colors.dim('No account session was saved.')}\n`);
          break;
        }
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
          if (sub === 'prompt') {
            if (parts.length === 1) {
              output.write(activeConfig.systemPrompt
                ? `${activeConfig.systemPrompt}\n`
                : `${colors.dim('No local system prompt configured.')}\n`);
              break;
            }
            const requestedPrompt = parts.slice(1).join(' ');
            const nextPrompt = requestedPrompt.toLowerCase() === 'clear' && parts.length === 2 ? null : requestedPrompt;
            activeConfig = await saveConfig({ ...activeConfig, systemPrompt: nextPrompt });
            localConfigExists = true;
            await setSystemPrompt(buildSystemPrompt(activeConfig), memoryBaseDir ? { baseDir: memoryBaseDir } : {});
            output.write(nextPrompt
              ? `${colors.green('✓')} Local system prompt saved and active for this session.\n`
              : `${colors.green('✓')} Local system prompt cleared.\n`);
            break;
          }
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
