import readline from 'node:readline';
import { createCli } from './cli.js';
import { loadConfig, normalizeConfig, saveConfig } from './config.js';
import { runDemo } from './demo.js';
import { runSetup } from './setup.js';
import { runTrustGate } from './trust.js';
import { runConsentGate } from './consent.js';
import { renderBanner, renderHelp } from './ui/banner.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';
import { VERSION } from './version.js';
import { initializeAccountSession } from './auth.js';

const args = new Set(process.argv.slice(2));

function printUsage(output) {
  output.write(`${renderHelp()}\n`);
}

export async function main() {
  const output = createTerminalRenderer(process.stdout);

  if (args.has('--help') || args.has('-h')) {
    printUsage(output);
    return;
  }

  if (args.has('--version') || args.has('-v')) {
    output.write(`Luciano Code AI v${VERSION}\n`);
    return;
  }

  const { config, exists } = await loadConfig();
  const shouldCheckTrust = !args.has('--help') && !args.has('-h')
    && !args.has('--version') && !args.has('-v');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const startupReadline = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : undefined;
  let cliOwnsReadline = false;
  try {
    const trustResult = shouldCheckTrust
      ? await runTrustGate({ config, output, readlineInterface: startupReadline })
      : { config, trusted: false, skipped: true };
    if (!trustResult.trusted && !trustResult.skipped) return;

    const consentResult = await runConsentGate({
      config: trustResult.config,
      output,
      readlineInterface: startupReadline,
    });
    if (!consentResult.decided && !consentResult.config.nvidiaDataConsent) {
      // The CLI can still start so local-only commands remain available.
    }

    if (args.has('--setup') && !interactive) {
      output.write('Luciano Code AI setup requires an interactive terminal. Run `npm start` directly.\n');
      return;
    }

    let activeConfig = consentResult.config;
    const manualModel = activeConfig.model;
    const accountSession = await initializeAccountSession({ output });
    const shouldSetup = args.has('--setup') || (!exists && interactive && !accountSession.active);
    if (accountSession.config) {
      activeConfig = await saveConfig(normalizeConfig({ ...activeConfig, ...accountSession.config }));
    }

    if (shouldSetup) {
      activeConfig = await runSetup({
        currentConfig: activeConfig,
        output,
        isFirstRun: !exists,
        readlineInterface: startupReadline,
      });
    }

    output.write(`${renderBanner(activeConfig, output.columns)}\n`);

    if (args.has('--demo')) {
      await runDemo(output, {
        config: activeConfig,
        input: process.stdin,
        readlineInterface: startupReadline,
        memoryBaseDir: undefined,
      });
      return;
    }

    createCli({
      config: activeConfig,
      manualModel,
      output,
      readlineInterface: startupReadline,
    }).start();
    cliOwnsReadline = true;
  } finally {
    if (!cliOwnsReadline) startupReadline?.close();
  }
}
