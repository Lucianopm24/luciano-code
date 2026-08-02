import { appendCommandExecution, resumeLatestConversation } from './memory.js';
import { hasNvidiaDataConsent, isConfigured, isTrusted } from './config.js';
import { runPrompt } from './agent.js';
import { createToolAuthorizer, executeTool, workspaceRoot } from './tools.js';
import { box, divider, tree } from './ui/box.js';
import { colors, symbols } from './ui/colors.js';
import { renderStatus } from './ui/banner.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const DEMO_DELAYS = {
  intro: 5_000,
  status: 5_000,
  memory: 4_500,
  analysis: 5_000,
  command: 5_000,
  outro: 4_000,
};

function demoWidth(stream) {
  const columns = Number(stream?.columns);
  const terminalWidth = Number.isFinite(columns) && columns > 0 ? columns : 80;
  return Math.max(16, terminalWidth - 6);
}

function listingTree(listing) {
  const entries = String(listing)
    .split('\n')
    .filter((line) => /^(file|directory)\t/.test(line))
    .slice(0, 8)
    .map((line) => {
      const [kind, name] = line.split('\t');
      return `${colors.dim(kind === 'directory' ? '├──' : '└──')} ${colors.white(name)} ${colors.green(symbols.success)}`;
    });
  if (!entries.length) return colors.dim('(workspace empty)');
  const total = String(listing).split('\n').filter((line) => /^(file|directory)\t/.test(line)).length;
  if (total > entries.length) entries.push(colors.dim(`└── … ${total - entries.length} more entries`));
  return tree(entries);
}

function demoConfig(config) {
  return {
    ...config,
    preferences: {
      ...(config.preferences || {}),
      stream: true,
      noThink: true,
    },
  };
}

export async function runDemo(
  stream = process.stdout,
  {
    config,
    input = process.stdin,
    readlineInterface,
    ask,
    memoryBaseDir,
    delay = wait,
    runPromptFn = runPrompt,
  } = {},
) {
  stream = createTerminalRenderer(stream);
  const activeConfig = config || {};
  const width = demoWidth(stream);
  const memoryOptions = memoryBaseDir ? { baseDir: memoryBaseDir } : {};
  const authorizeTool = createToolAuthorizer({ input, output: stream, readlineInterface, ask });
  const root = workspaceRoot();

  stream.write(`\n${colors.green('luciano-code')} ${colors.dim('>')} ${colors.white('/demo')}\n`);
  stream.write(`${colors.amber('LIVE DEMO')} ${colors.slate('Real workspace · real authorization · no simulated results')}\n`);
  await delay(DEMO_DELAYS.intro);

  stream.write(`\n${divider('Provider status', width)}\n`);
  stream.write(`${box(renderStatus(activeConfig).split('\n').slice(2), { title: 'Status', width, maxWidth: width - 4 })}\n`);
  await delay(DEMO_DELAYS.status);

  stream.write(`\n${divider('Local memory · /resume', width)}\n`);
  const conversation = await resumeLatestConversation(memoryOptions);
  stream.write(`${box([
    `${colors.green('✓')} ${conversation.messages.length ? 'Latest local conversation available' : 'No saved conversation yet'}`,
    `${colors.dim('messages:')} ${conversation.messages.length}`,
    colors.slate('The demo reads the same local memory used by /resume.'),
  ], { title: 'Memory', width, maxWidth: width - 4 })}\n`);
  await delay(DEMO_DELAYS.memory);

  stream.write(`\n${divider('Real project analysis', width)}\n`);
  const listingRequest = { tool: 'list_files', arguments: { path: '.' } };
  const trusted = isTrusted(activeConfig);
  if (!trusted) {
    stream.write(`${colors.amber('Demo paused:')} ${colors.slate('trust this folder at startup before running real workspace tools.')}\n`);
  }

  let listing = '';
  const listingAuthorization = trusted
    ? await authorizeTool(listingRequest)
    : { approved: false, reason: 'This folder is not trusted.' };
  if (listingAuthorization.approved) {
    try {
      listing = await executeTool(root, listingRequest, { authorized: true });
      stream.toolCompleted(listingRequest, { eventId: `demo-list-${Date.now()}` });
      stream.write(`${box([
        listingTree(listing),
        '',
        colors.slate('Observed directly from the trusted workspace.'),
      ], { title: 'Workspace', width, maxWidth: width - 4 })}\n`);
    } catch (error) {
      stream.toolFailed(listingRequest, error.message, { eventId: `demo-list-failed-${Date.now()}` });
      stream.write(`${colors.amber('Analysis stopped because the workspace could not be listed.')}\n`);
    }
  } else {
    stream.write(`${colors.amber('Workspace listing skipped:')} ${colors.slate(listingAuthorization.reason)}\n`);
  }
  await delay(DEMO_DELAYS.analysis);

  stream.write(`\n${divider('Command authorization', width)}\n`);
  const commandRequest = { tool: 'execute_command', arguments: { command: 'node --version' } };
  const commandAuthorization = trusted
    ? await authorizeTool(commandRequest)
    : { approved: false, reason: 'This folder is not trusted.' };
  if (commandAuthorization.approved) {
    try {
      await executeTool(root, commandRequest, {
        authorized: true,
        onCommandResult: async (result) => {
          try {
            await appendCommandExecution(result, memoryOptions);
          } catch (error) {
            stream.write(`${colors.amber('⚠')} Command result was not saved to local memory: ${colors.slate(error.message)}\n`);
          }
          stream.commandCompleted(commandRequest, result, { eventId: `demo-command-${Date.now()}` });
        },
      });
    } catch (error) {
      stream.toolFailed(commandRequest, error.message, { eventId: `demo-command-failed-${Date.now()}` });
    }
  } else {
    stream.write(`${colors.amber('Command not executed:')} ${colors.slate(commandAuthorization.reason)}\n`);
  }
  await delay(DEMO_DELAYS.command);

  stream.write(`\n${divider('Streaming response', width)}\n`);
  if (isTrusted(activeConfig) && isConfigured(activeConfig) && hasNvidiaDataConsent(activeConfig) && listing) {
    await runPromptFn(
      `Using only this real workspace listing, give a concise three-bullet project analysis. Do not call tools during this demo and do not invent files:\n\n${listing}`,
      demoConfig(activeConfig),
      stream,
      { input, readlineInterface, ask, memoryBaseDir, enableTools: false },
    );
  } else {
    stream.write(`${colors.amber('Live provider streaming unavailable.')} ${colors.slate('Configure trust, consent, and an API key to run this step for real; no response is simulated.')}\n`);
  }

  await delay(6_500);
  stream.write(`\n${box([
    colors.brightGreen(colors.bold('Luciano Code')),
    colors.white('Open Source'),
    '',
    colors.green('npm install -g luciano-code'),
  ], { title: 'Build with Luciano', width, maxWidth: width - 4 })}\n`);
}
