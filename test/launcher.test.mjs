import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = resolve(ROOT, 'scripts', 'launch-windows.mjs');
const WINDOWS_WRAPPER = resolve(ROOT, '启动监控.cmd');

function runLauncher(args, env = {}) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOST: '',
      PORT: '',
      DASHBOARD_PASSWORD: '',
      ...env,
    },
  });
}

describe('Windows launcher', () => {
  it('prints the resolved probe URL in dry-run mode without starting a service', () => {
    const result = runLauncher(
      ['--dry-run', '--port', '8791', '--host', '0.0.0.0'],
      { DASHBOARD_PASSWORD: 'launcher-test-password' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"url":\s*"http:\/\/127\.0\.0\.1:8791\/"/u);
    assert.equal(result.stderr, '');
  });

  it('rejects LAN mode without a dashboard password', () => {
    const result = runLauncher(['--dry-run', '--lan', '--port', '8792']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /DASHBOARD_PASSWORD/u);
  });

  it('shows the LAN bind address in dry-run mode when password protected', () => {
    const result = runLauncher(
      ['--dry-run', '--lan', '--port', '8792'],
      { DASHBOARD_PASSWORD: 'launcher-test-password' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"host":\s*"0\.0\.0\.0"/u);
    assert.match(result.stdout, /"url":\s*"http:\/\/127\.0\.0\.1:8792\/"/u);
    assert.equal(result.stderr, '');
  });

  it('rejects an invalid port before touching the server', () => {
    const result = runLauncher(['--dry-run', '--port', '70000']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /端口/u);
  });

  it('runs through the double-click wrapper on Windows', { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('cmd.exe', [
      '/d', '/c', 'call', WINDOWS_WRAPPER,
      '--dry-run', '--host', '127.0.0.1', '--port', '8787',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOST: '',
        PORT: '',
        DASHBOARD_PASSWORD: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"url":\s*"http:\/\/127\.0\.0\.1:8787\/"/u);
  });
});
