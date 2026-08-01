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
 * growing snapshot on every frame. The mode is deliberately conservative:
 * ordinary deltas are appended, while a growing snapshot switches the stream
 * to cumulative mode and only its suffix is returned. Once cumulative mode is
 * known, older snapshots are ignored instead of being printed again. Before
 * confirmation, an ambiguous shorter frame is treated as a stale snapshot;
 * this prioritizes the safety requirement of never duplicating provider frames.
 * Providers that emit true deltas should use distinct delta chunks or rely on
 * the NVIDIA client normalizer before they reach this presentation boundary.
 */
export function createStreamTextAccumulator() {
  let fullText = '';
  let mode = 'unknown';
  let pendingSnapshot = '';

  const flushPendingAsDelta = () => {
    if (!pendingSnapshot) return '';
    const delta = pendingSnapshot;
    fullText += delta;
    pendingSnapshot = '';
    mode = 'delta';
    return delta;
  };

  return {
    push(value) {
      const chunk = safeStreamToken(value);
      if (!chunk) return '';
      if (mode === 'cumulative') {
        if (chunk === fullText || fullText.startsWith(chunk)) return '';
        if (chunk.startsWith(fullText)) {
          const delta = chunk.slice(fullText.length);
          fullText = chunk;
          return delta;
        }
        fullText += chunk;
        return chunk;
      }

      if (!fullText) {
        fullText = chunk;
        return chunk;
      }

      if (pendingSnapshot) {
        if (chunk === fullText || fullText.startsWith(chunk) || pendingSnapshot.startsWith(chunk)) {
          // A repeated or shorter frame is a stale snapshot while the format is
          // still being determined; keep waiting for a confirming growth.
          return '';
        }
        if (chunk === pendingSnapshot || chunk.startsWith(pendingSnapshot)) {
          mode = 'cumulative';
          const delta = chunk.slice(fullText.length);
          fullText = chunk;
          pendingSnapshot = '';
          return delta;
        }

        const previousDelta = flushPendingAsDelta();
        const nextDelta = this.push(chunk);
        return previousDelta + nextDelta;
      }

      if (chunk.startsWith(fullText) && chunk.length > fullText.length) {
        // Hold the first ambiguous growth. A second consecutive growth confirms
        // cumulative snapshots; otherwise the held chunk is a normal delta.
        pendingSnapshot = chunk;
        return '';
      }

      mode = 'delta';
      fullText += chunk;
      return chunk;
    },
    finish() {
      if (!pendingSnapshot) return '';
      if (pendingSnapshot.startsWith(fullText)) {
        const delta = pendingSnapshot.slice(fullText.length);
        fullText = pendingSnapshot;
        pendingSnapshot = '';
        mode = 'cumulative';
        return delta;
      }
      return flushPendingAsDelta();
    },
    get text() {
      return fullText + pendingSnapshot;
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
  const terminal = supportsInPlaceUpdates(stream);
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
      writeResponseDelta(textAccumulator.push(token));
    },
    finish() {
      const finalDelta = textAccumulator.finish();
      if (finalDelta) writeResponseDelta(finalDelta);
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
