import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function childEnvironment(overrides = {}) {
  return {
    ...process.env,
    SUB2API_BASE_URL: '',
    SUB2API_ADMIN_KEY: '',
    SUB2API_TOKEN: '',
    CC_SWITCH_DB_PATH: '',
    UPSTREAM_API_KEY: '',
    PROXY_TOKEN: '',
    ...overrides,
  };
}

async function waitForListening(child, timeoutMs = 10_000) {
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });

  const deadline = Date.now() + timeoutMs;
  while (!output.includes('[monitor] listening')) {
    if (child.exitCode !== null) {
      throw new Error(`Monitor exited before listening (${child.exitCode}): ${output}${errors}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for monitor: ${output}${errors}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill(), 5_000);
  timeout.unref();
  await once(child, 'exit').catch(() => undefined);
  clearTimeout(timeout);
}

async function waitForReplacement(origin, previousInstanceId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json();
        if (health?.status === 'ok' && health.instanceId && health.instanceId !== previousInstanceId) {
          return health;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for a replacement monitor instance: ${lastError}`);
}

async function waitForOffline(origin, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the monitor to stop');
}

function basicAuthorization(password) {
  return `Basic ${Buffer.from(`monitor:${password}`).toString('base64')}`;
}

describe('server integration', () => {
  it('enforces auth, ingests only normalized metadata, and serves dashboard SSE', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-server-'));
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const password = 'dashboard-private-password';
    const ingestToken = 'ingest-private-token';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        DASHBOARD_PASSWORD: password,
        INGEST_TOKEN: ingestToken,
        HOME: directory,
        USERPROFILE: directory,
        DASHBOARD_SOURCE: 'local',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const origin = `http://127.0.0.1:${port}`;
    const dashboardHeaders = { Authorization: basicAuthorization(password) };
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/`)).status, 401);
    assert.equal((await fetch(`${origin}/`, { headers: dashboardHeaders })).status, 200);
    assert.equal((await fetch(`${origin}/api/dashboard?range=bogus`, { headers: dashboardHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/api/dashboard?source=bogus`, { headers: dashboardHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401);

    const initialSettingsResponse = await fetch(`${origin}/api/settings`, { headers: dashboardHeaders });
    assert.equal(initialSettingsResponse.status, 200);
    const initialSettings = await initialSettingsResponse.json();
    assert.equal(initialSettings.sub2api.hasAdminKey, false);
    assert.equal(initialSettings.ccSwitch.enabled, true);

    const settingsSecret = 'sub2api-setting-secret';
    const savedSettingsResponse = await fetch(`${origin}/api/settings`, {
      method: 'PUT',
      headers: { ...dashboardHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        sub2api: {
          enabled: false,
          baseUrl: 'https://sub2api.example.com',
          scope: 'admin',
          adminKey: settingsSecret,
          timezone: 'Asia/Hong_Kong',
        },
        ccSwitch: { enabled: false, dbPath: '' },
      }),
    });
    assert.equal(savedSettingsResponse.status, 200);
    const savedSettings = await savedSettingsResponse.json();
    assert.equal(savedSettings.sub2api.hasAdminKey, true);
    assert.equal(savedSettings.sub2api.adminKey, undefined);
    assert.equal(JSON.stringify(savedSettings).includes(settingsSecret), false);
    assert.equal(savedSettings.ccSwitch.enabled, false);

    const secret = 'sk-never-persist-this-value';
    const prompt = 'never persist this private prompt';
    const event = {
      id: 'integration-event',
      timestamp: Date.now(),
      service: 'integration-upstream',
      model: 'gpt-integration',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      latencyMs: 123,
      status: 200,
      keyId: 'safe-key-label',
      authorization: `Bearer ${secret}`,
      messages: [{ role: 'user', content: prompt }],
    };

    assert.equal((await fetch(`${origin}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    })).status, 401);
    const accepted = await fetch(`${origin}/api/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
    });
    assert.equal(accepted.status, 202);

    const dashboardResponse = await fetch(`${origin}/api/dashboard?range=today&source=local`, {
      headers: dashboardHeaders,
    });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.activeSource, 'local');
    assert.equal(dashboard.summary.requests, 1);
    assert.equal(dashboard.summary.tokens, 15);
    assert.equal(dashboard.recent[0].id, 'integration-event');

    const controller = new AbortController();
    const streamResponse = await fetch(`${origin}/api/stream?range=today&source=local`, {
      headers: dashboardHeaders,
      signal: controller.signal,
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const firstChunk = await reader.read();
    const streamText = new TextDecoder().decode(firstChunk.value);
    assert.match(streamText, /event: update\n/);
    assert.match(streamText, /data: \{"generatedAt":/);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    const persisted = await readFile(join(dataDirectory, 'events.jsonl'), 'utf8');
    assert.equal(persisted.includes(secret), false);
    assert.equal(persisted.includes(prompt), false);
    assert.equal(persisted.includes('safe-key-label'), true);
    const persistedSettings = await readFile(join(dataDirectory, 'settings.json'), 'utf8');
    assert.equal(persistedSettings.includes(settingsSecret), true);
  });

  it('refuses a LAN-visible server-side upstream key without a proxy token', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-refusal-'));
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '0.0.0.0',
        PORT: String(await freePort()),
        DATA_DIR: join(directory, 'data'),
        UPSTREAM_API_KEY: 'sk-server-side-secret',
        PROXY_TOKEN: '',
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });

    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [exitCode] = await once(child, 'exit');

    assert.equal(exitCode, 1);
    assert.match(output, /refusing non-loopback proxy/i);
    assert.equal(output.includes('sk-server-side-secret'), false);
  });

  it('blocks runtime settings on a non-loopback bind without dashboard auth', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-settings-lan-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '0.0.0.0',
        PORT: String(port),
        DATA_DIR: join(directory, 'data'),
        DASHBOARD_PASSWORD: '',
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal(response.status, 403);
  });

  it('reports authenticated backend status and accepts dashboard-authorized shutdown', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-backend-status-'));
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const password = 'backend-status-password';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        DASHBOARD_PASSWORD: password,
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const origin = `http://127.0.0.1:${port}`;
    const headers = { Authorization: basicAuthorization(password) };
    assert.equal((await fetch(`${origin}/api/backend`)).status, 401);

    const statusResponse = await fetch(`${origin}/api/backend`, { headers });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    const state = JSON.parse(await readFile(join(dataDirectory, 'server-state.json'), 'utf8'));
    assert.equal(status.status, 'running');
    assert.equal(status.instanceId, state.instanceId);
    assert.equal(status.processId, child.pid);
    assert.equal(status.bindHost, '127.0.0.1');
    assert.equal(status.port, port);
    assert.equal(typeof status.startedAt, 'string');
    assert.equal(status.control.enabled, true);
    assert.deepEqual(status.control.availableActions, ['stop', 'restart']);
    assert.equal(status.control.startSupported, false);
    assert.equal(JSON.stringify(status).includes(state.controlToken), false);

    const missingContentType = await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'stop' }),
    });
    assert.equal(missingContentType.status, 415);
    const invalidAction = await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    assert.equal(invalidAction.status, 400);

    const stopping = await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    assert.equal(stopping.status, 202);
    assert.deepEqual(await stopping.json(), { accepted: true, action: 'stop', status: 'stopping' });
    await once(child, 'exit');
  });

  it('restarts through the launcher only after the prior instance has closed', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-backend-restart-'));
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const password = 'backend-restart-password';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        DASHBOARD_PASSWORD: password,
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const origin = `http://127.0.0.1:${port}`;
    const headers = { Authorization: basicAuthorization(password) };
    t.after(async () => {
      try {
        await fetch(`${origin}/api/backend`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          signal: AbortSignal.timeout(2_000),
        });
        await waitForOffline(origin, 5_000);
      } catch {
        // The original or replacement process may already be gone.
      }
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const priorHealth = await (await fetch(`${origin}/health`)).json();
    const restarting = await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    assert.equal(restarting.status, 202);
    assert.deepEqual(await restarting.json(), { accepted: true, action: 'restart', status: 'restarting' });
    await once(child, 'exit');

    const replacement = await waitForReplacement(origin, priorHealth.instanceId);
    const state = JSON.parse(await readFile(join(dataDirectory, 'server-state.json'), 'utf8'));
    assert.equal(state.instanceId, replacement.instanceId);
    assert.equal(state.port, port);
  });

  it('restarts after forcing a hanging proxy request closed', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-backend-hanging-restart-'));
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const password = 'backend-hanging-restart-password';
    let upstreamRequestStarted;
    const upstreamRequest = new Promise((resolve) => {
      upstreamRequestStarted = resolve;
    });
    const upstream = createHttpServer((request) => {
      request.resume();
      upstreamRequestStarted();
    });
    await new Promise((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const upstreamPort = upstream.address().port;
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        DASHBOARD_PASSWORD: password,
        UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const origin = `http://127.0.0.1:${port}`;
    const headers = { Authorization: basicAuthorization(password) };
    t.after(async () => {
      try {
        await fetch(`${origin}/api/backend`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          signal: AbortSignal.timeout(2_000),
        });
        await waitForOffline(origin, 5_000);
      } catch {
        // The replacement may already have stopped.
      }
      await stopChild(child);
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const priorHealth = await (await fetch(`${origin}/health`)).json();
    void fetch(`${origin}/v1/slow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);
    await Promise.race([
      upstreamRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the proxy request')), 2_000)),
    ]);

    const restarting = await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    assert.equal(restarting.status, 202);
    await once(child, 'exit');

    const replacement = await waitForReplacement(origin, priorHealth.instanceId, 15_000);
    const state = JSON.parse(await readFile(join(dataDirectory, 'server-state.json'), 'utf8'));
    assert.equal(state.instanceId, replacement.instanceId);
    assert.equal(state.port, port);
  });

  it('writes verifiable local control state and shuts down only with its token', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-control-'));
    const dataDirectory = join(directory, 'data');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: childEnvironment({
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDirectory,
        HOME: directory,
        USERPROFILE: directory,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForListening(child);

    const origin = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${origin}/health`)).json();
    const state = JSON.parse(await readFile(join(dataDirectory, 'server-state.json'), 'utf8'));
    assert.equal(state.instanceId, health.instanceId);
    assert.equal(state.port, port);
    assert.equal(typeof state.controlToken, 'string');

    const backend = await (await fetch(`${origin}/api/backend`)).json();
    assert.equal(backend.control.enabled, false);
    assert.deepEqual(backend.control.availableActions, []);
    assert.equal((await fetch(`${origin}/api/backend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    })).status, 403);

    const denied = await fetch(`${origin}/api/control/stop`, { method: 'POST' });
    assert.equal(denied.status, 403);
    const accepted = await fetch(`${origin}/api/control/stop`, {
      method: 'POST',
      headers: { 'x-monitor-control-token': state.controlToken },
    });
    assert.equal(accepted.status, 202);
    await once(child, 'exit');
  });
});
