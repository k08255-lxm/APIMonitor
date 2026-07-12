#!/usr/bin/env node

/**
 * Safe Windows stop helper for API Monitor.
 *
 * This script never searches for or kills a process. It only asks the exact
 * monitor instance recorded in data/server-state.json to shut itself down.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 200;

function defaultStateFile() {
  return resolve(ROOT_DIR, 'data', 'server-state.json');
}

function parseArgs(argv) {
  const options = {
    stateFile: defaultStateFile(),
    waitMs: DEFAULT_WAIT_MS,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--state-file' && argv[index + 1]) {
      options.stateFile = resolve(ROOT_DIR, argv[++index]);
    } else if (arg.startsWith('--state-file=')) {
      options.stateFile = resolve(ROOT_DIR, arg.slice('--state-file='.length));
    } else if (arg === '--wait-ms' && argv[index + 1]) {
      options.waitMs = argv[++index];
    } else if (arg.startsWith('--wait-ms=')) {
      options.waitMs = arg.slice('--wait-ms='.length);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function positiveWait(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error('--wait-ms must be an integer between 1000 and 300000.');
  }
  return parsed;
}

function requiredSecret(value, fieldName, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid ${fieldName} in the monitor state file.`);
  }
  return value;
}

export function readMonitorState(stateFile) {
  if (!existsSync(stateFile)) {
    throw new Error(`No monitor state file was found at ${stateFile}. Refusing to stop an unverified process.`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    throw new Error(`The monitor state file is invalid: ${stateFile}. Refusing to stop an unverified process.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`The monitor state file is invalid: ${stateFile}. Refusing to stop an unverified process.`);
  }

  const port = Number(raw.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid port in the monitor state file. Refusing to stop an unverified process.');
  }

  return {
    instanceId: requiredSecret(raw.instanceId, 'instanceId', 512),
    controlToken: requiredSecret(raw.controlToken, 'controlToken', 4096),
    port,
  };
}

function monitorOrigin(port) {
  // Always target IPv4 loopback, regardless of the server bind address saved
  // in state. This makes the control request local-only by construction.
  return `http://127.0.0.1:${port}`;
}

async function probeInstance(origin, state, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    return { reachable: false, matches: false };
  }

  if (!response.ok) return { reachable: true, matches: false };

  try {
    const health = await response.json();
    const matches = health?.status === 'ok'
      && health.instanceId === state.instanceId
      && health.port === state.port;
    return { reachable: true, matches };
  } catch {
    return { reachable: true, matches: false };
  }
}

async function requestStop(origin, state, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}/api/control/stop`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'x-monitor-control-token': state.controlToken,
      },
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new Error('The verified monitor instance could not be reached for shutdown.');
  }

  if (!response.ok) {
    throw new Error(`The verified monitor instance refused the shutdown request (HTTP ${response.status}).`);
  }
}

async function waitForStop(origin, state, waitMs, fetchImpl) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const probe = await probeInstance(origin, state, fetchImpl);
    if (!probe.reachable) return 'stopped';
    if (!probe.matches) return 'replaced';
    await new Promise((resolveWait) => setTimeout(resolveWait, DEFAULT_POLL_MS));
  }

  const finalProbe = await probeInstance(origin, state, fetchImpl);
  if (!finalProbe.reachable) return 'stopped';
  if (!finalProbe.matches) return 'replaced';
  throw new Error(`The monitor is still running after ${Math.ceil(waitMs / 1000)} seconds.`);
}

function printHelp() {
  console.log([
    'API Monitor safe stop helper',
    '',
    'Double click the root "close monitor.cmd" file to ask the verified local monitor instance to stop.',
    'The helper never force-kills a process.',
    '',
    'Optional arguments: --state-file <path> --wait-ms 10000 --dry-run',
  ].join('\n'));
}

export async function stopMonitor(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { action: 'help' };
  }

  const waitMs = positiveWait(options.waitMs);
  const state = readMonitorState(options.stateFile);
  const origin = monitorOrigin(state.port);
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (options.dryRun) {
    console.log(JSON.stringify({ stateFile: options.stateFile, instanceId: state.instanceId, origin, waitMs }, null, 2));
    return { action: 'dry-run', stateFile: options.stateFile, instanceId: state.instanceId, origin, waitMs };
  }

  const initialProbe = await probeInstance(origin, state, fetchImpl);
  if (!initialProbe.matches) {
    if (initialProbe.reachable) {
      throw new Error('The local service does not match the saved monitor instance. Refusing to stop an unverified process.');
    }
    throw new Error('The saved monitor instance is not reachable. Refusing to stop an unverified process.');
  }

  await requestStop(origin, state, fetchImpl);
  const outcome = await waitForStop(origin, state, waitMs, fetchImpl);
  return { action: 'stopped', outcome, origin };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  stopMonitor().then((result) => {
    if (result.action === 'stopped') {
      console.log(result.outcome === 'replaced'
        ? 'The monitor stopped; another service is now responding on that port.'
        : 'API Monitor has stopped.');
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Monitor shutdown failed: ${message}`);
    process.exitCode = 1;
  });
}
