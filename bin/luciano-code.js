#!/usr/bin/env node

import { main } from '../src/index.js';
import { createTerminalRenderer } from '../src/ui/terminal-renderer.js';

main().catch((error) => {
  createTerminalRenderer(process.stderr).write(`\nLuciano Code AI stopped unexpectedly: ${error.message}\n`);
  process.exitCode = 1;
});
