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

  const { config, exists, migratedFromModel } = await loadConfig();
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
    if (migratedFromModel) {
      activeConfig = await saveConfig(activeConfig);
      output.write(`Your previous model is no longer available, switched to ${activeConfig.model}\n`);
    }
    const manualModel = activeConfig.model;
    const accountSession = await initializeAccountSession({ output });
    const syncedDeprecatedModel = accountSession.config?.model === 'deepseek-ai/deepseek-v4-flash'
      || accountSession.config?.model === 'deepseek-ai/deepseek-v4-pro';
    const shouldSetup = args.has('--setup') || (!exists && interactive && !accountSession.active);
    if (accountSession.config) {
      activeConfig = await saveConfig(normalizeConfig({ ...activeConfig, ...accountSession.config }));
      if (syncedDeprecatedModel) {
        output.write(`Your previous model is no longer available, switched to ${activeConfig.model}\n`);
      }
    }

    if (shouldSetup) {
      activeConfig = await runSetup({
        currentConfig: activeConfig,
        output,
        isFirstRun: !exists,
        readlineInterface: startupReadline,
      });
    }

    for (let i = 0; i < 50; i++) output.write('\n');
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
      configExists: exists,
      manualModel,
      output,
      readlineInterface: startupReadline,
    }).start();
    cliOwnsReadline = true;
  } finally {
    if (!cliOwnsReadline) startupReadline?.close();
  }
}
