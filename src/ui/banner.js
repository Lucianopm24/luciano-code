import { box } from './box.js';
import { colors, symbols, stripAnsi, visibleLength } from './colors.js';
import { statusLine } from './status.js';
import { getApiKey, isConfigured, maskApiKey, normalizeConfig, runtimeConfig } from '../config.js';

const CODER_MIN_WIDTH = 20;
const DEFAULT_TERMINAL_WIDTH = 80;

const CODER_ASCII = [
  '    ████████████',
  '    ██        ██',
  '    ██  ██  ██ ██',
  '    ██  ██  ██ ██',
  '    ██        ██',
  '    ██  ██████ ██',
  '    ██        ██',
  '    ████████████',
  '        ██  ██',
  '        ██  ██',
  '        ██  ██',
];

export function getTerminalWidth(stream = process.stdout) {
  const streamWidth = Number(stream?.columns);
  if (Number.isFinite(streamWidth) && streamWidth > 0) return Math.floor(streamWidth);

  const environmentWidth = Number(process.env.COLUMNS);
  if (Number.isFinite(environmentWidth) && environmentWidth > 0) return Math.floor(environmentWidth);

  return DEFAULT_TERMINAL_WIDTH;
}

function truncate(value, maxWidth) {
  const text = String(value);
  if (maxWidth <= 0) return '';
  if (visibleLength(text) <= maxWidth) return text;
  const plain = stripAnsi(text);
  if (maxWidth <= 1) return '…'.slice(0, maxWidth);
  // Tiny terminals should never receive a sliced ANSI escape sequence. The
  // compact fallback intentionally drops styling when truncation is needed.
  return `${plain.slice(0, maxWidth - 1)}…`;
}

function centered(value, width) {
  const text = truncate(value, width);
  const left = Math.max(0, Math.floor((width - visibleLength(text)) / 2));
  const right = Math.max(0, width - visibleLength(text) - left);
  return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
}

function compactStatus(label, state, width) {
  const prefix = `${symbols[state] ?? symbols.success} `;
  return `${colors[state === 'warning' ? 'amber' : 'green'](prefix)}${colors.white(truncate(label, Math.max(1, width - prefix.length)))}`;
}

function renderCoder(width) {
  const coderWidth = CODER_ASCII.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
  if (width < coderWidth) return '';
  const left = Math.max(0, Math.floor((width - coderWidth) / 2));
  const indent = ' '.repeat(left);
  return CODER_ASCII.map((line) => `${indent}${colors.green(line)}`).join('\n');
}

export function renderBanner(config = normalizeConfig(), columns = getTerminalWidth()) {
  const width = Number.isFinite(Number(columns)) ? Math.floor(Number(columns)) : getTerminalWidth();
  if (width < CODER_MIN_WIDTH) return '';
  return renderCoder(width);
}

export function renderHelp() {
  return box([
    `${colors.green('/login')}      Sign in with your Luciano Code account`,
    `${colors.green('/sync')}       Sync the account API key and model`,
    `${colors.green('/whoami')}     Show the signed-in account identity`,
    `${colors.green('/logout')}     Sign out and remove the local account session`,
    `${colors.green('/setup')}      Configure provider and preferences`,
    `${colors.green('/key set')}  Replace the NVIDIA API key`,
    `${colors.green('/model set')} Choose or change the active NIM model`,
    `${colors.green('/models')}    List available NVIDIA NIM models`,
    `${colors.green('/prompts')}   Search, publish, view, or delete prompts`,
    `${colors.green('/skills')}    Search, publish, view, or delete skills`,
    `${colors.green('/cloud repos')}    List connected Cloud repositories`,
    `${colors.green('/cloud threads')} <repo>  List Cloud sessions for a repository`,
    `${colors.green('/cloud continue')} <repo>  Continue a Cloud session locally`,
    `${colors.green('/cloud use')} <repo>       Use a Cloud session with web sync`,
    `${colors.green('/tools')}     Explain file tools and authorization`,
    `${colors.green('/nothink')}   Toggle model reasoning on or off`,
    `${colors.green('/tokens')}    Show or set max output tokens`,
    `${colors.green('/config')}    Show current configuration`,
    `${colors.green('/config prompt')} Show or set the local system prompt`,
    `${colors.green('/config search set')} <url>  Set the SearXNG web search endpoint`,
    `${colors.green('/trust')}     Show folder trust status`,
    `${colors.green('/trust reset')} Revoke trust for this folder`,
    `${colors.green('/status')}    Show workspace and provider status`,
    `${colors.green('/demo')}      Run a clearly labeled visual demo`,
    `${colors.green('/analyze')}   Analyze the real workspace with the configured agent`,
    `${colors.green('/history')}   Show recent local conversations`,
    `${colors.green('/clear')}     Archive and clear the current conversation`,
    `${colors.green('/new')}       Start a new local conversation`,
    `${colors.green('/resume')}    Resume the latest local conversation`,
    `${colors.green('/consent')}   Show or change NVIDIA data consent`,
    `${colors.green('/screen')}    Clear terminal display only`,
    `${colors.green('/help')}      Show available commands`,
    `${colors.green('/exit')}      Close Luciano Code AI`,
    '',
    `${colors.dim('Tip:')} use ${colors.green('/model set')} to choose GLM 5.2, MiniMax M3, or a custom model ID.`,
  ], { title: 'Commands', width: 62, tone: 'green' });
}

export function renderStatus(config = normalizeConfig()) {
  const runtime = runtimeConfig(config);
  const configured = isConfigured(runtime);
  return [
    colors.bold('Workspace status'),
    '',
    statusLine('Connected to local workspace', 'success'),
    statusLine(configured ? 'NVIDIA NIM provider configured' : 'NVIDIA NIM provider not configured', configured ? 'success' : 'warning'),
    `${colors.dim(symbols.bullet)} ${colors.slate(`Model: ${config.model}`)}`,
    `${colors.dim(symbols.bullet)} ${colors.slate(`Key: ${maskApiKey(getApiKey(runtime))}${runtime.keySource === 'environment' ? ' · environment override' : runtime.keySource === 'account' ? ' · account session' : ''}`)}`,
    `${colors.dim(symbols.bullet)} ${colors.slate(`Language: ${config.preferences.language} · stream: ${config.preferences.stream ? 'on' : 'off'} · no-think: ${config.preferences.noThink ? 'on' : 'off'}`)}`,
    `${colors.dim(symbols.bullet)} ${colors.slate(`Max output tokens: ${config.preferences.maxTokens} · web search: ${config.preferences.searxngUrl}`)}`,
    `${colors.dim(symbols.bullet)} ${colors.slate('Tools: list/read/write/edit/command · authorization per operation or session')}`,
  ].join('\n');
}

export function renderConfig(config = normalizeConfig()) {
  const runtime = runtimeConfig(config);
  return box([
    `${colors.dim('Provider')}  ${colors.white('NVIDIA NIM')}`,
    `${colors.dim('Endpoint')}  ${colors.slate(config.baseUrl)}`,
    `${colors.dim('Model')}     ${colors.white(config.model)}`,
    `${colors.dim('API key')}   ${colors.slate(maskApiKey(getApiKey(runtime)))}${runtime.keySource === 'environment' ? colors.dim(' (environment)') : runtime.keySource === 'account' ? colors.dim(' (account)') : ''}`,
    `${colors.dim('Language')}  ${colors.white(config.preferences.language)}`,
    `${colors.dim('Stream')}    ${colors.white(config.preferences.stream ? 'enabled' : 'disabled')}`,
    `${colors.dim('No-think')}  ${colors.white(config.preferences.noThink ? 'enabled' : 'disabled')}`,
    `${colors.dim('Context')}   ${colors.white(`${config.preferences.contextMessages} messages`)}`,
    `${colors.dim('Max tokens')} ${colors.white(config.preferences.maxTokens)}`,
    `${colors.dim('Search')}    ${colors.slate(config.preferences.searxngUrl)}`,
    `${colors.dim('Consent')}   ${colors.white(config.nvidiaDataConsent || 'not decided')}`,
    `${colors.dim('Prompt')}    ${colors.white(config.systemPrompt ? 'configured locally' : 'not configured')}`,
    '',
    colors.dim('Stored locally with restricted permissions.'),
  ], { title: 'Configuration', width: 62, tone: 'green' });
}
