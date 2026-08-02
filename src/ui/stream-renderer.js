import { colors, stripAnsi } from './colors.js';
import { renderMarkdown } from './markdown.js';
import { createTerminalRenderer } from './terminal-renderer.js';

const RESPONSE_PREFIX = `${colors.brightGreen('Assistant')} ${colors.dim('›')} `;
const CONTINUATION_PREFIX = ' '.repeat(stripAnsi(RESPONSE_PREFIX).length);

export function supportsInPlaceUpdates(stream, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!stream?.isTTY || env.TERM === 'dumb' || env.NO_COLOR !== undefined) return false;
  if (platform !== 'win32') return true;

  return Boolean(
    env.WT_SESSION
      || env.ANSICON
      || env.ConEmuANSI === 'ON'
      || env.TERM_PROGRAM === 'vscode'
      || env.TERM_PROGRAM === 'Windows_Terminal'
      || env.TERM === 'xterm-256color',
  );
}

export function safeStreamToken(token) {
  return stripAnsi(String(token))
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[^\n]*/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * Normalizes provider chunks at the presentation boundary.
 *
 * Providers normally emit deltas, but some OpenAI-compatible endpoints emit a
 * growing snapshot on every frame. This accumulator handles both cases:
 * - **Delta mode** (default): each chunk is appended directly.
 * - **Cumulative mode**: only the suffix of a growing snapshot is returned.
 *
 * The mode is detected on the fly: if a chunk starts with the current full text
 * and is longer, it's treated as a cumulative snapshot and only the new suffix
 * is emitted. If a chunk does NOT start with the full text, it's treated as a
 * delta and appended normally. This eliminates the fragile `pendingSnapshot`
 * logic that caused duplicate output.
 */
export function createStreamTextAccumulator() {
  let fullText = '';
  let mode = 'delta';

  return {
    push(value) {
      const chunk = safeStreamToken(value);
      if (!chunk) return '';

      if (!fullText) {
        fullText = chunk;
        return chunk;
      }

      // If the new chunk starts with what we already have, it's a cumulative
      // snapshot — emit only the suffix.
      if (chunk.startsWith(fullText) && chunk.length > fullText.length) {
        mode = 'cumulative';
        const delta = chunk.slice(fullText.length);
        fullText = chunk;
        return delta;
      }

      // Otherwise treat it as a delta and append.
      mode = 'delta';
      fullText += chunk;
      return chunk;
    },
    finish() {
      return '';
    },
    get text() {
      return fullText;
    },
    get mode() {
      return mode;
    },
  };
}

export function createLiveRenderer(stream, spinner) {
  stream = createTerminalRenderer(stream);
  let reasoningStarted = false;
  let responseStarted = false;
  let responseHadTokens = false;
  let lineCommitted = false;
  let pendingLine = '';
  let renderedLine = '';
  let codeBlockActive = false;
  const terminal = false;
  const textAccumulator = createStreamTextAccumulator();

  const clearProgress = () => {
    if (spinner.started) spinner.clear();
  };

  const beginResponse = () => {
    if (responseStarted) return;
    if (reasoningStarted) stream.write('\n');
    stream.write(RESPONSE_PREFIX);
    responseStarted = true;
  };

  const renderStreamingLine = (line, commit = false) => {
    const fence = line.match(/^\s*```\s*([^\s]*)\s*$/);
    let formatted;
    if (codeBlockActive) {
      formatted = fence
        ? colors.dim('╰' + '─'.repeat(58))
        : `${colors.dim('│')} ${colors.mint(line)}`;
    } else {
      formatted = fence
        ? colors.dim(`╭─ ${fence[1] || 'code'} ${'─'.repeat(Math.max(1, 54 - (fence[1] || 'code').length))}`)
        : renderMarkdown(line);
    }

    if (commit && fence) codeBlockActive = !codeBlockActive;
    return formatted;
  };

  const renderCurrentLine = () => {
    const formatted = renderStreamingLine(pendingLine);
    if (terminal) {
      const prefix = lineCommitted ? CONTINUATION_PREFIX : RESPONSE_PREFIX;
      stream.write(`\r\u001b[2K${prefix}${formatted}`);
      renderedLine = formatted;
    } else if (formatted !== renderedLine) {
      renderedLine = formatted;
    }
  };

  const commitLine = () => {
    const formatted = renderStreamingLine(pendingLine, true);
    if (terminal) {
      const prefix = lineCommitted ? CONTINUATION_PREFIX : RESPONSE_PREFIX;
      stream.write(`\r\u001b[2K${prefix}${formatted}\n`);
    } else {
      stream.write('\n');
    }
    pendingLine = '';
    renderedLine = '';
    lineCommitted = true;
  };

  const writeResponseDelta = (delta) => {
    if (!delta) return;
    clearProgress();
    beginResponse();
    responseHadTokens = true;

    if (!terminal) {
      stream.write(colors.white(delta));
      return;
    }

    const parts = delta.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      pendingLine += parts[index];
      if (index < parts.length - 1) {
        commitLine();
      } else if (pendingLine.length > 0) {
        lineCommitted = false;
        renderCurrentLine();
      } else {
        lineCommitted = true;
      }
    }
  };

  return {
    writeReasoning(token) {
      const safeToken = safeStreamToken(token);
      if (!safeToken) return;
      clearProgress();
      if (!reasoningStarted) {
        stream.write(`${colors.dim('Thinking')} ${colors.slate('›')} `);
        reasoningStarted = true;
      }
      stream.write(colors.slate(safeToken));
    },
    writeResponse(token) {
  console.error('[STREAM TOKEN]', JSON.stringify(token));
  writeResponseDelta(safeStreamToken(token));
},
    finish() {
  if (pendingLine.length > 0) commitLine();
  else if ((reasoningStarted || responseStarted) && !lineCommitted) stream.write('\n');
},
    get responseHadTokens() {
      return responseHadTokens;
    },
    get outputStarted() {
      return reasoningStarted || responseStarted;
    },
    get text() {
      return textAccumulator.text;
    },
  };
}
