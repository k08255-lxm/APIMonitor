#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_PATH = resolve(ROOT_DIR, 'scripts', 'launch-windows.mjs');
const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_CONFIRMATION_SAMPLES = 2;

function positiveInteger(value, fallback, name, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseWatcherArgs(argv) {
  const options = {
    intervalMs: DEFAULT_INTERVAL_MS,
    confirmationSamples: DEFAULT_CONFIRMATION_SAMPLES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--interval-ms' && argv[index + 1]) {
      options.intervalMs = positiveInteger(argv[++index], DEFAULT_INTERVAL_MS, '--interval-ms', 1_000, 60_000);
    } else if (argument.startsWith('--interval-ms=')) {
      options.intervalMs = positiveInteger(argument.slice('--interval-ms='.length), DEFAULT_INTERVAL_MS, '--interval-ms', 1_000, 60_000);
    } else if (argument === '--confirm-samples' && argv[index + 1]) {
      options.confirmationSamples = positiveInteger(argv[++index], DEFAULT_CONFIRMATION_SAMPLES, '--confirm-samples', 2, 10);
    } else if (argument.startsWith('--confirm-samples=')) {
      options.confirmationSamples = positiveInteger(argument.slice('--confirm-samples='.length), DEFAULT_CONFIRMATION_SAMPLES, '--confirm-samples', 2, 10);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function runTasklist() {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn('tasklist.exe', [
      '/FI', 'IMAGENAME eq cc-switch.exe',
      '/FO', 'CSV',
      '/NH',
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectCommand(new Error(`tasklist.exe exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolveCommand(stdout);
    });
  });
}

export function tasklistContainsCcSwitch(output) {
  return String(output || '').toLowerCase().includes('cc-switch.exe');
}

export function createPresenceEdgeDetector({ confirmationSamples = DEFAULT_CONFIRMATION_SAMPLES } = {}) {
  const threshold = positiveInteger(confirmationSamples, DEFAULT_CONFIRMATION_SAMPLES, 'confirmationSamples', 2, 10);
  let stablePresent = false;
  let candidate = false;
  let consecutiveSamples = 0;

  return {
    observe(value) {
      const present = Boolean(value);
      if (present === candidate) {
        consecutiveSamples += 1;
      } else {
        candidate = present;
        consecutiveSamples = 1;
      }
      if (candidate === stablePresent || consecutiveSamples < threshold) return null;
      stablePresent = candidate;
      return stablePresent ? 'present' : 'absent';
    },
    snapshot() {
      return { stablePresent, candidate, consecutiveSamples, confirmationSamples: threshold };
    },
  };
}

export function startMonitorWithLauncher({
  spawnProcess = spawn,
  nodePath = process.execPath,
  launcherPath = LAUNCHER_PATH,
  rootDir = ROOT_DIR,
  environment = process.env,
  onError = (error) => console.warn(`[monitor] unable to start API Monitor: ${error.message}`),
} = {}) {
  const child = spawnProcess(nodePath, [launcherPath, '--no-browser'], {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    env: { ...environment },
  });
  child.once?.('error', onError);
  child.unref?.();
  return child;
}

export function createCcSwitchWatcher({
  pollPresence = async () => tasklistContainsCcSwitch(await runTasklist()),
  launch = () => startMonitorWithLauncher(),
  intervalMs = DEFAULT_INTERVAL_MS,
  confirmationSamples = DEFAULT_CONFIRMATION_SAMPLES,
  logger = console,
  startImmediately = true,
} = {}) {
  const interval = positiveInteger(intervalMs, DEFAULT_INTERVAL_MS, 'intervalMs', 1_000, 60_000);
  const detector = createPresenceEdgeDetector({ confirmationSamples });
  let stopped = false;
  let polling = false;
  let timer = null;

  const poll = async () => {
    if (stopped || polling) return null;
    polling = true;
    try {
      const edge = detector.observe(await pollPresence());
      if (edge === 'present') {
        logger.info?.('[monitor] cc-switch detected; starting API Monitor');
        await launch();
      } else if (edge === 'absent') {
        logger.info?.('[monitor] cc-switch stopped; watcher is re-armed');
      }
      return edge;
    } catch (error) {
      logger.warn?.(`[monitor] unable to inspect cc-switch process: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      polling = false;
    }
  };

  timer = setInterval(() => { void poll(); }, interval);
  if (startImmediately) void poll();
  return {
    poll,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    snapshot: () => ({ stopped, polling, ...detector.snapshot() }),
  };
}

function printHelp() {
  console.log([
    'API Monitor cc-switch watcher',
    '',
    'Starts API Monitor after a stable cc-switch.exe process start is detected.',
    'Options: --interval-ms 3000 --confirm-samples 2',
  ].join('\n'));
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The cc-switch watcher is only supported on Windows');
  const options = parseWatcherArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  console.log(`[monitor] watching cc-switch.exe every ${options.intervalMs}ms`);
  const watcher = createCcSwitchWatcher(options);
  const stop = () => {
    watcher.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[monitor] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
