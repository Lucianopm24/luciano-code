import { randomUUID } from 'node:crypto';
import { NvidiaNimClient } from './nvidia.js';
import { getApiKey, hasNvidiaDataConsent, isConfigured, isTrusted, saveConfig } from './config.js';
import { chooseModel } from './setup.js';
import { colors } from './ui/colors.js';
import { Spinner } from './ui/spinner.js';
import { renderMarkdown } from './ui/markdown.js';
import { createLiveRenderer } from './ui/stream-renderer.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';
import { appendConversationMessage, loadCurrentConversation, selectContextMessages } from './memory.js';
import {
  createToolAuthorizer,
  executeTool,
  parseToolRequest,
  TOOL_DEFINITIONS,
  toolInstructions,
  workspaceRoot,
} from './tools.js';

const MAX_TOOL_TURNS = 12;
const MAX_AUTOMATIC_529_RETRIES = 10;

function isToolSchemaUnsupported(error) {
  return error?.status === 400 || error?.status === 422;
}

const API_KEY_URL = 'https://build.nvidia.com/settings/api-keys';

function apiKeyMessage() {
  return [
    `${colors.amber('⚠')} NVIDIA NIM is not configured.`,
    `Get an API key at ${colors.green(API_KEY_URL)}, then run ${colors.green('/setup')} or ${colors.green('/key set')}.`,
  ].join(' ');
}

function toolResultMessage(request, result) {
  return [
    `[Tool result: ${request.tool}]`,
    result,
    'Continue the task using this result. If another tool is needed, output only the required tool JSON object.',
  ].join('\n');
}

function nativeToolRequest(call) {
  const request = parseToolRequest({
    type: 'function',
    id: call.id,
    function: call.function,
  });
  return request ? { ...request, callId: call.id } : null;
}


function toolExecutionKey(request) {
  if (request?.eventId) return `event:${request.eventId}`;
  return request?.callId ? `call:${request.callId}` : null;
}

async function runAuthorizedTool(request, { authorizeTool, root, stream, spinner, toolResults }) {
  const executionRequest = request?.eventId || request?.callId
    ? request
    : { ...request, eventId: `tool-execution-${randomUUID()}` };
  const eventKey = toolExecutionKey(executionRequest);
  if (eventKey && toolResults.has(eventKey)) return toolResults.get(eventKey);

  spinner.clear();
  const authorization = await authorizeTool(executionRequest);
  let result;
  if (!authorization.approved) {
    result = `Tool request rejected: ${authorization.reason}`;
    stream.toolRejected(authorization.reason, executionRequest, { eventId: eventKey });
  } else {
    try {
      result = await executeTool(root, executionRequest);
      stream.toolCompleted(executionRequest, { eventId: eventKey });
    } catch (error) {
      result = `Tool failed: ${error.message}`;
      stream.toolFailed(executionRequest, error.message, { eventId: eventKey });
    }
  }
  if (eventKey) toolResults.set(eventKey, result);
  spinner.start('Working with the tool result...');
  return result;
}

export async function runPrompt(
  prompt,
  config,
  stream = process.stdout,
  {
    input = process.stdin,
    readlineInterface,
    ask,
    initialToolRequests = [],
    onInitialToolResult,
    memoryBaseDir,
  } = {},
) {
  stream = createTerminalRenderer(stream);
  if (!isTrusted(config)) {
    stream.write(`\n${colors.amber('⚠')} This folder is not trusted. Agent execution and tools are disabled until you trust it at startup.\n`);
    return;
  }

  if (!hasNvidiaDataConsent(config)) {
    stream.write(`\n${colors.amber('⚠')} NVIDIA data-sharing consent is required before sending prompts, files, or tool results to NVIDIA. Use ${colors.green('/consent accept')} in an interactive terminal.\n`);
    return;
  }

  if (!isConfigured(config) || !getApiKey(config)) {
    stream.write(`\n${apiKeyMessage()}\n`);
    return;
  }

  let activeConfig = config;
  let client = new NvidiaNimClient(activeConfig);
  const systemContent = [
    `You are Luciano Code AI, a concise coding assistant. Respond in ${config.preferences.language === 'en' ? 'English' : 'Spanish'} unless the user asks otherwise.`,
    'Always format the final response as Markdown. Use headings, bullets, fenced code blocks, tables, and inline code when they improve clarity.',
    'Do not use raw ANSI escape sequences or HTML. Do not claim to have modified files unless a tool result confirms it.',
    config.preferences.noThink
      ? 'Do not spend effort on hidden reasoning. Give a direct, concise answer and proceed with tools when needed.'
      : 'Only expose reasoning/progress that the provider explicitly returns as reasoning_content or reasoning; never invent private chain-of-thought.',
    toolInstructions(),
  ].join('\n\n');
  const memoryOptions = memoryBaseDir ? { baseDir: memoryBaseDir } : {};
  const conversation = await loadCurrentConversation(memoryOptions);
  if (!conversation.messages.some((message) => message.role === 'system')) {
    await appendConversationMessage({ role: 'system', content: systemContent }, memoryOptions);
  }
  await appendConversationMessage({ role: 'user', content: prompt }, memoryOptions);
  const storedConversation = await loadCurrentConversation(memoryOptions);
  const messages = [
    { role: 'system', content: systemContent },
    ...selectContextMessages(
      storedConversation.messages.filter((message) => message.role !== 'system'),
      activeConfig.preferences.contextMessages,
    ).map(({ role, content }) => ({ role, content })),
  ];
  const spinner = new Spinner(stream);
  const root = workspaceRoot();
  const authorizeTool = createToolAuthorizer({
    input,
    output: stream,
    readlineInterface,
    ask,
  });
  const streamEnabled = Boolean(activeConfig.preferences.stream);
  let nativeToolsEnabled = true;
  const toolResults = new Map();

  const recoverProviderError = async (error) => {
    spinner.clear();
    if (error.status === 529) {
      stream.write(`\n${colors.amber('⚠')} The NVIDIA NIM servers are overloaded. Try again or try with a different model.\n`);
      if (!input?.isTTY || !stream?.isTTY || !readlineInterface || readlineInterface.closed) return 'cancel';
      stream.write(`${colors.green('1.')} Change model\n${colors.green('2.')} Try again\n`);
      const choice = (await ask(`${colors.green('Choose an option')} ${colors.dim('[1/2]')} `)).trim().toLowerCase();
      if (choice === '1' || choice === 'change model' || choice === 'model') {
        const selectedModel = await chooseModel(readlineInterface, stream, activeConfig.model);
        if (selectedModel && selectedModel !== activeConfig.model) {
          activeConfig = await saveConfig({ ...activeConfig, model: selectedModel });
          client = new NvidiaNimClient(activeConfig);
          stream.write(`${colors.green('✓')} Model changed to ${colors.white(activeConfig.model)}. Retrying...\n`);
        }
        return 'retry';
      }
      if (choice === '2' || choice === 'try again' || choice === 'retry') return 'retry';
      return 'cancel';
    }

    if (error.status === 429) {
      stream.write(`\n${colors.amber('⚠')} You are going too fast! Wait a minute and then try again.\n`);
      if (!input?.isTTY || !stream?.isTTY || !readlineInterface || readlineInterface.closed) return 'cancel';
      stream.write(`${colors.green('1.')} Try again\n${colors.green('2.')} Send another request\n`);
      const choice = (await ask(`${colors.green('Choose an option')} ${colors.dim('[1/2]')} `)).trim().toLowerCase();
      if (choice === '1' || choice === 'try again' || choice === 'retry') return 'retry';
      if (choice === '2' || choice === 'send another request' || choice === 'another') {
        stream.write(`${colors.dim('Returning to the prompt so you can send another request.')}\n`);
      }
      return 'cancel';
    }

    return 'cancel';
  };

  const completeWithRecovery = async (options) => {
    let automatic529Retries = 0;

    while (true) {
      try {
        const response = await client.complete(messages, options);
        return { response, cancelled: false };
      } catch (error) {
        if (error?.status === 529 && automatic529Retries < MAX_AUTOMATIC_529_RETRIES) {
          automatic529Retries += 1;
          spinner.clear();
          spinner.start(`NVIDIA NIM overloaded · automatic retry ${automatic529Retries}/${MAX_AUTOMATIC_529_RETRIES}...`);
          continue;
        }

        if (![429, 529].includes(error?.status)) throw error;
        const action = await recoverProviderError(error);
        if (action === 'retry') {
          automatic529Retries = 0;
          continue;
        }
        return { response: null, cancelled: true };
      }
    }
  };

  if (!stream.isTTY) {
    stream.write(`\n${colors.green('luciano-code')} ${colors.dim('>')} ${colors.white(prompt)}\n`);
  }
  spinner.start(config.preferences.noThink ? 'Working...' : 'Thinking...');

  try {
    const pendingInitialToolRequests = [...initialToolRequests];
    while (pendingInitialToolRequests.length) {
      const request = pendingInitialToolRequests.shift();
      const result = await runAuthorizedTool(request, {
        authorizeTool,
        root,
        stream,
        spinner,
        toolResults,
      });
      messages.push({
        role: 'user',
        content: toolResultMessage(request, result),
      });
      const followUp = onInitialToolResult?.({ request, result, stream, spinner });
      if (followUp === true || followUp?.stop === true) return;
      if (Array.isArray(followUp)) pendingInitialToolRequests.push(...followUp);
      if (Array.isArray(followUp?.requests)) pendingInitialToolRequests.push(...followUp.requests);
    }

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const live = streamEnabled ? createLiveRenderer(stream, spinner) : null;
      let streamedAnswer = '';
      let fallbackToolBuffer = '';
      let fallbackCandidateActive = false;
      let fallbackToolDetected = false;
      let response;
      try {
        const completed = await completeWithRecovery({
          tools: nativeToolsEnabled ? TOOL_DEFINITIONS : [],
          onReasoning: streamEnabled && !activeConfig.preferences.noThink ? (token) => live.writeReasoning(token) : undefined,
          onToken: streamEnabled ? (token) => {
            streamedAnswer += token;
            live.writeResponse(token);
          } : undefined,
        });
        if (completed.cancelled) return;
        response = completed.response;
      } catch (error) {
        if (!isToolSchemaUnsupported(error)) throw error;
        nativeToolsEnabled = false;
        if (live) live.finish();
        stream.write(`${colors.dim('· This model does not expose native tools; using JSON tool mode.')}\n`);
        fallbackCandidateActive = false;
        fallbackToolBuffer = '';
        fallbackToolDetected = false;
        const completed = await completeWithRecovery({
          onReasoning: streamEnabled && !activeConfig.preferences.noThink ? (token) => live.writeReasoning(token) : undefined,
          onToken: streamEnabled ? (token) => {
            streamedAnswer += token;
            if (fallbackToolDetected) return;

            if (fallbackCandidateActive) {
              fallbackToolBuffer += token;
              const parsed = parseToolRequest(fallbackToolBuffer);
              if (parsed) {
                fallbackToolDetected = true;
                return;
              }
              const completeCandidate = /}\s*(?:```)?\s*$/.test(fallbackToolBuffer)
                || /```\s*$/.test(fallbackToolBuffer);
              if (completeCandidate) {
                live.writeResponse(fallbackToolBuffer);
                fallbackToolBuffer = '';
                fallbackCandidateActive = false;
              }
              return;
            }

            const fenceIndex = token.search(/```(?:json)?\s*/i);
            const braceIndex = token.indexOf('{');
            const candidateIndex = fenceIndex >= 0 && (braceIndex < 0 || fenceIndex < braceIndex)
              ? fenceIndex
              : braceIndex;
            if (candidateIndex >= 0) {
              const prefix = token.slice(0, candidateIndex);
              if (prefix) live.writeResponse(prefix);
              fallbackToolBuffer = token.slice(candidateIndex);
              fallbackCandidateActive = true;
              if (parseToolRequest(fallbackToolBuffer)) fallbackToolDetected = true;
              return;
            }

            live.writeResponse(token);
          } : undefined,
        });
        if (completed.cancelled) return;
        response = completed.response;
      }
      const responseContent = typeof response === 'string'
        ? response
        : response?.content || streamedAnswer;
      const nativeCalls = nativeToolsEnabled && typeof response === 'object' && Array.isArray(response.toolCalls)
        ? response.toolCalls.map(nativeToolRequest).filter(Boolean)
        : [];
      const parsedTextualRequest = nativeCalls.length ? null : parseToolRequest(responseContent);
      const textualRequest = parsedTextualRequest
        ? { ...parsedTextualRequest, eventId: `text-turn-${turn}` }
        : null;
      if (!nativeToolsEnabled && fallbackCandidateActive && !fallbackToolDetected && !textualRequest && fallbackToolBuffer) {
        live?.writeResponse(fallbackToolBuffer);
        fallbackToolBuffer = '';
        fallbackCandidateActive = false;
      }

      if (!nativeCalls.length && !textualRequest) {
        if (streamEnabled && live?.responseHadTokens) {
          live.finish();
        } else if (streamEnabled && live?.outputStarted) {
          live.finish();
          if (responseContent) stream.write(`${colors.brightGreen('Assistant')} ${colors.dim('›')}\n${renderMarkdown(responseContent)}\n`);
        } else if (responseContent) {
          spinner.clear();
          stream.write(`${colors.brightGreen('Assistant')} ${colors.dim('›')}\n${renderMarkdown(responseContent)}\n`);
        } else {
          spinner.stop('Empty response', 'warning');
          stream.write(`${colors.amber('⚠')} NVIDIA NIM returned an empty response.\n`);
        }
        if (responseContent) await appendConversationMessage({ role: 'assistant', content: responseContent }, memoryOptions);
        return;
      }

      if (live) live.finish();

      if (nativeCalls.length) {
        const assistantMessage = {
          role: 'assistant',
          content: responseContent || null,
          tool_calls: response.toolCalls,
        };
        messages.push(assistantMessage);
        for (const request of nativeCalls) {
          const result = await runAuthorizedTool(request, {
            authorizeTool,
            root,
            stream,
            spinner,
            toolResults,
          });
          messages.push({
            role: 'tool',
            tool_call_id: request.callId,
            content: result,
          });
        }
      } else {
        const result = await runAuthorizedTool(textualRequest, {
          authorizeTool,
          root,
          stream,
          spinner,
          toolResults,
        });
        messages.push({ role: 'assistant', content: responseContent });
        messages.push({ role: 'user', content: toolResultMessage(textualRequest, result) });
      }
    }

    spinner.stop('Tool limit reached', 'warning');
    stream.write(`${colors.amber('⚠')} The tool-call limit was reached before the model produced a final answer.\n`);
  } catch (error) {
    spinner.stop('Request failed', 'error');
    stream.write(`${colors.red('✗')} ${colors.slate(error.message)}\n`);
  }
}

export function analysisToolRequestsFromListing(result, basePath = '.', {
  maxFiles = 8,
  maxDirectories = 16,
} = {}) {
  if (typeof result !== 'string' || result.includes('\n(empty)')) return [];

  const files = [];
  const directories = [];
  for (const line of result.split('\n')) {
    const file = line.match(/^file\t(.+)$/)?.[1];
    const directory = line.match(/^directory\t(.+)$/)?.[1];
    if (file && files.length < maxFiles) files.push(file);
    if (directory && directories.length < maxDirectories) directories.push(directory);
  }

  const joinWorkspacePath = (name) => basePath === '.' ? name : `${basePath}/${name}`;
  return [
    ...files.map((file) => ({ tool: 'read_file', arguments: { path: joinWorkspacePath(file) } })),
    ...directories.map((directory) => ({ tool: 'list_files', arguments: { path: joinWorkspacePath(directory) } })),
  ];
}

export const analysisReadRequestsFromListing = analysisToolRequestsFromListing;

async function preflightEmptyWorkspace(config, stream, options = {}) {
  if (!isTrusted(config) || (hasNvidiaDataConsent(config) && isConfigured(config))) return false;

  const output = createTerminalRenderer(stream);
  const request = { tool: 'list_files', arguments: { path: '.' } };
  const authorizeTool = createToolAuthorizer({
    input: options.input,
    output,
    readlineInterface: options.readlineInterface,
    ask: options.ask,
  });
  const authorization = await authorizeTool(request);
  if (!authorization.approved) return false;

  try {
    const result = await executeTool(workspaceRoot(), request);
    output.toolCompleted(request, { eventId: `analyze-preflight-list-${randomUUID()}` });
    if (result.includes('\\n(empty)')) {
      output.write(`${colors.brightGreen('Assistant')} ${colors.dim('›')}\\nWorkspace is empty.\\n`);
      return true;
    }
  } catch (error) {
    output.toolFailed(request, error.message, { eventId: `analyze-preflight-list-${randomUUID()}` });
  }
  return false;
}

export async function runWorkspaceAnalysis(config, stream = process.stdout, options = {}) {
  if (await preflightEmptyWorkspace(config, stream, options)) return;

  const seenDirectories = new Set();
  const seenFiles = new Set();
  let directoryBudget = 16;
  let fileBudget = 8;
  const prompt = [
    'Analyze the current workspace as a real project, not as a demo.',
    'First use list_files on the workspace root. If it is empty, say exactly that the workspace is empty and do not invent files.',
    'If files exist, use read_file only on relevant, non-sensitive files after the normal user authorization flow.',
    'Base every claim on tool results. Do not invent paths, files, dependencies, or findings.',
    'Then provide a concise architecture and health analysis in Markdown.',
  ].join(' ');
  return runPrompt(prompt, config, stream, {
    ...options,
    initialToolRequests: [
      { tool: 'list_files', arguments: { path: '.' } },
    ],
    onInitialToolResult: ({ request, result, stream: output, spinner }) => {
      if (result.startsWith('Tool request rejected:')) {
        spinner.clear();
        output.write(`${colors.brightGreen('Assistant')} ${colors.dim('›')}\nAnalysis stopped because the required ${request.tool} operation was not authorized. No remote analysis was requested.\n`);
        return true;
      }
      if (request.tool !== 'list_files') return false;
      if (result.includes('\n(empty)')) {
        spinner.clear();
        output.write(`${colors.brightGreen('Assistant')} ${colors.dim('›')}\nWorkspace is empty.\n`);
        return true;
      }

      const directory = request.arguments?.path || '.';
      if (seenDirectories.has(directory)) return false;
      seenDirectories.add(directory);
      const requests = analysisToolRequestsFromListing(result, directory, {
        maxFiles: fileBudget,
        maxDirectories: directoryBudget,
      });
      const filtered = [];
      for (const next of requests) {
        const nextPath = next.arguments?.path;
        if (next.tool === 'read_file') {
          if (fileBudget <= 0 || seenFiles.has(nextPath)) continue;
          seenFiles.add(nextPath);
          fileBudget -= 1;
          filtered.push(next);
        } else if (next.tool === 'list_files') {
          if (directoryBudget <= 0 || seenDirectories.has(nextPath)) continue;
          directoryBudget -= 1;
          filtered.push(next);
        }
      }
      return filtered;
    },
  });
}

export { API_KEY_URL };
