import { colors, symbols } from './colors.js';
import { createTerminalRenderer } from './terminal-renderer.js';

const frames = ['◐', '◓', '◑', '◒'];

export class Spinner {
  constructor(stream = process.stdout) {
    this.stream = createTerminalRenderer(stream);
    this.timer = null;
    this.frame = 0;
    this.message = '';
    this.started = false;
    this.interactive = Boolean(this.stream.isTTY) && process.env.TERM !== 'dumb';
  }

  start(message = 'Working...') {
    if (this.started) return this;
    this.started = true;
    this.message = message;
    this.frame = 0;

    if (!this.interactive) {
      this.stream.write(`${colors.mint(symbols.working)} ${message}\n`);
      return this;
    }

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % frames.length;
      this.render();
    }, 110);
    this.timer.unref?.();
    return this;
  }

  render() {
    this.stream.write(`\r\u001b[2K${colors.mint(frames[this.frame])} ${this.message}`);
  }

  clear() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.stream.write('\r\u001b[2K');
    }
    this.started = false;
    return this;
  }

  stop(message = 'Done', state = 'success') {
    if (!this.started) return this;

    const wasInteractive = Boolean(this.timer);
    this.clear();

    const tone = state === 'success' ? 'green' : state === 'warning' ? 'amber' : 'red';
    if (wasInteractive || !this.interactive) {
      this.stream.write(`${colors[tone](symbols[state] ?? symbols.success)} ${message}\n`);
    }
    this.started = false;
    return this;
  }
}
