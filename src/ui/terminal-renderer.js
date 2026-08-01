import { colors } from './colors.js';

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
