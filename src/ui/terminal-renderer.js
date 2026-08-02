import { colors, stripAnsi } from './colors.js';
import { box } from './box.js';

function safeCommandOutput(value) {
  return stripAnsi(String(value ?? ''))
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[^\n]*/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const TERMINAL_RENDERER = Symbol('terminalRenderer');
const TERMINAL_STREAM = Symbol('terminalStream');

function toolKey(request, { eventId } = {}) {
  if (eventId) return `event:${eventId}`;
  if (request?.callId) return `call:${request.callId}`;
  let argumentsText = '';
  try {
    argumentsText = JSON.stringify(request?.arguments ?? {});
  } catch {
    argumentsText = String(request?.arguments ?? '');
  }
  return `request:${request?.tool ?? 'unknown'}:${argumentsText}`;
}

/**
 * The only output boundary used by the application after startup.
 * Components may render into this sink, but must not write to the underlying
 * stdout stream directly. The wrapper intentionally exposes stream-like
 * properties so readline and the existing TTY renderers remain compatible.
 */
export function createTerminalRenderer(stream = process.stdout) {
  if (stream?.[TERMINAL_RENDERER]) return stream;

  const claimedToolEvents = new Set();
  const renderer = {
    [TERMINAL_RENDERER]: true,
    [TERMINAL_STREAM]: stream,
    get isTTY() {
      return Boolean(stream?.isTTY);
    },
    get columns() {
      return stream?.columns;
    },
    write(value) {
      return stream.write(String(value));
    },
    claimTool(request, options = {}) {
      const key = toolKey(request, options);
      if (key.startsWith('request:')) return true;
      if (claimedToolEvents.has(key)) return false;
      claimedToolEvents.add(key);
      return true;
    },
    toolCompleted(request, options = {}) {
      if (!options.claimed && !renderer.claimTool(request, options)) return false;
      renderer.write(`${colors.green('✓')} ${request.tool} completed.\n`);
      return true;
    },
    toolFailed(request, message, options = {}) {
      if (!options.claimed && !renderer.claimTool(request, options)) return false;
      renderer.write(`${colors.red('✗')} ${message}\n`);
      return true;
    },
    toolRejected(reason, request, options = {}) {
      if (request && !options.claimed && !renderer.claimTool(request, options)) return false;
      renderer.write(`${colors.amber('⚠')} ${reason}\n`);
      return true;
    },
    commandCompleted(request, result, options = {}) {
      if (!options.claimed && !renderer.claimTool(request, options)) return false;
      const limit = 2_000;
      const trimOutput = (value) => {
        const text = safeCommandOutput(value).trim() || '(no output)';
        const clipped = text.length > limit ? `${text.slice(0, limit)}\n… output truncated for display` : text;
        return clipped.split(/\r?\n/).map((line) => colors.slate(line));
      };
      const stdout = trimOutput(result?.stdout);
      const stderr = trimOutput(result?.stderr);
      const terminalWidth = Number(renderer.columns);
      const maxWidth = Number.isFinite(terminalWidth) && terminalWidth > 0 ? Math.max(12, terminalWidth - 4) : 46;
      const width = Math.min(72, maxWidth);
      renderer.write(`${box([
        `${colors.green('✓')} ${colors.white('execute_command')} · exit code ${result?.exitCode ?? 1}`,
        `${colors.dim('cwd:')} ${colors.slate(result?.cwd || '.')}`,
        '',
        colors.dim('stdout'),
        ...stdout,
        '',
        colors.dim('stderr'),
        ...stderr,
      ], { title: 'Command result', width, maxWidth: width, tone: result?.exitCode === 0 ? 'green' : 'amber' })}\n`);
      return true;
    },
    clear() {
      if (renderer.isTTY) renderer.write('\u001b[2J\u001b[H');
      else renderer.write('\n'.repeat(3));
    },
  };
  return renderer;
}

export function isTerminalRenderer(value) {
  return Boolean(value?.[TERMINAL_RENDERER]);
}

export function getTerminalStream(value) {
  return value?.[TERMINAL_STREAM] ?? value;
}
