import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import { stopMonitor } from '../scripts/stop-windows.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WINDOWS_WRAPPER = join(ROOT, '关闭监控.cmd');

async function makeDirectory() {
  return mkdtemp(join(tmpdir(), 'api-monitor-stop-'));
}

async function writeState(directory, state) {
  const stateFile = join(directory, 'server-state.json');
  await writeFile(stateFile, JSON.stringify(state), 'utf8');
  return stateFile;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolveClose) => reservation.close(resolveClose));
  return port;
}

async function waitForMonitor(child, timeoutMs = 10_000) {
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + timeoutMs;
  while (!output.includes('[monitor] listening')) {
    if (child.exitCode !== null) throw new Error(`Monitor exited before listening: ${output}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for monitor: ${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => undefined);
}

describe('safe Windows stop helper', () => {
  it('only stops an instance whose health identity matches its saved state', async (t) => {
    const directory = await makeDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));

    const instanceId = 'monitor-instance-a';
    const controlToken = 'control-token-a';
    let stopRequests = 0;
    let receivedToken = '';
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', instanceId, port: server.address().port }));
        return;
      }
      if (request.url === '/api/control/stop' && request.method === 'POST') {
        stopRequests += 1;
        receivedToken = request.headers['x-monitor-control-token'];
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: true }));
        setTimeout(() => server.close(), 10).unref();
        return;
      }
      response.writeHead(404).end();
    });
    t.after(() => server.close());

    const port = await listen(server);
    const stateFile = await writeState(directory, { instanceId, controlToken, port });
    const result = await stopMonitor(['--state-file', stateFile, '--wait-ms', '1000']);

    assert.equal(result.action, 'stopped');
    assert.equal(result.outcome, 'stopped');
    assert.equal(stopRequests, 1);
    assert.equal(receivedToken, controlToken);
  });

  it('refuses a state file when the local health identity does not match', async (t) => {
    const directory = await makeDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));

    let stopRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', instanceId: 'a-different-instance', port: server.address().port }));
        return;
      }
      if (request.url === '/api/control/stop') stopRequests += 1;
      response.writeHead(404).end();
    });
    t.after(() => server.close());

    const port = await listen(server);
    const stateFile = await writeState(directory, {
      instanceId: 'saved-instance',
      controlToken: 'control-token',
      port,
    });

    await assert.rejects(
      () => stopMonitor(['--state-file', stateFile, '--wait-ms', '1000']),
      /does not match the saved monitor instance/u,
    );
    assert.equal(stopRequests, 0);
  });

  it('refuses to take action when no server state file exists', async () => {
    const directory = await makeDirectory();
    try {
      await assert.rejects(
        () => stopMonitor(['--state-file', join(directory, 'missing.json'), '--wait-ms', '1000']),
        /No monitor state file/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops a real monitor instance through its generated local control state', async (t) => {
    const directory = await makeDirectory();
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        SUB2API_BASE_URL: '',
        SUB2API_ADMIN_KEY: '',
        SUB2API_TOKEN: '',
        CC_SWITCH_DB_PATH: '',
        UPSTREAM_API_KEY: '',
        PROXY_TOKEN: '',
        HOME: directory,
        USERPROFILE: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });

    await waitForMonitor(child);
    const result = await stopMonitor([
      '--state-file',
      join(dataDirectory, 'server-state.json'),
      '--wait-ms',
      '2000',
    ]);
    assert.equal(result.action, 'stopped');
    if (child.exitCode === null) await once(child, 'exit');
  });

  it('runs through the double-click wrapper on Windows', { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('cmd.exe', ['/d', '/c', 'call', WINDOWS_WRAPPER, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /safe stop helper/u);
  });
});
