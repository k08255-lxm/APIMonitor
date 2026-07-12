import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  createWindowsAutostart,
  resolveAutostartMode,
} from '../scripts/windows-autostart.mjs';
import {
  createCcSwitchWatcher,
  createPresenceEdgeDetector,
  parseWatcherArgs,
  startMonitorWithLauncher,
  tasklistContainsCcSwitch,
} from '../scripts/watch-cc-switch.mjs';

function registryOutput(command) {
  return [
    WINDOWS_RUN_KEY,
    `    ${WINDOWS_RUN_VALUE}    REG_SZ    ${command}`,
    '',
  ].join('\r\n');
}

function fakeRegistry({ initialCommand = null } = {}) {
  let command = initialCommand;
  const calls = [];
  return {
    calls,
    async runCommand(file, args) {
      calls.push({ file, args: [...args] });
      assert.equal(file, 'reg.exe');
      if (args[0] === 'query') {
        return command === null
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: registryOutput(command), stderr: '' };
      }
      if (args[0] === 'add') {
        command = args[args.indexOf('/d') + 1];
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete') {
        command = null;
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected registry command: ${args[0]}`);
    },
  };
}

describe('Windows login startup registry wrapper', () => {
  it('normalises the compact and toggle API request forms without accepting commands', () => {
    assert.equal(resolveAutostartMode({ mode: 'always' }), 'always');
    assert.equal(resolveAutostartMode({ mode: 'cc-switch', enabled: true }), 'cc-switch');
    assert.equal(resolveAutostartMode({ mode: 'always', enabled: false }), 'off');
    assert.equal(resolveAutostartMode({ mode: 'off' }), 'off');
    assert.throws(() => resolveAutostartMode({ mode: 'off', enabled: true }), /cannot be true/u);
    assert.throws(() => resolveAutostartMode({ mode: 'always', command: 'calc.exe' }), /mode must be/u);
  });

  it('reports an absent Run value without invoking a shell', async () => {
    const registry = fakeRegistry();
    const manager = createWindowsAutostart({
      platform: 'win32',
      rootDir: '/api monitor',
      nodePath: '/node path/node.exe',
      runCommand: registry.runCommand,
    });

    const status = await manager.status();
    assert.equal(status.supported, true);
    assert.equal(status.enabled, false);
    assert.equal(status.mode, 'off');
    assert.equal(status.registry.state, 'missing');
    assert.equal(status.registry.key, WINDOWS_RUN_KEY);
    assert.equal(status.registry.valueName, WINDOWS_RUN_VALUE);
    assert.equal(typeof status.detail, 'string');
    assert.equal(registry.calls.length, 1);
    assert.deepEqual(registry.calls[0], {
      file: 'reg.exe',
      args: ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE],
    });
  });

  it('writes only fixed launcher or watcher commands for supported modes', async () => {
    const registry = fakeRegistry();
    const manager = createWindowsAutostart({
      platform: 'win32',
      rootDir: '/api monitor',
      nodePath: '/node path/node.exe',
      runCommand: registry.runCommand,
    });

    const expectedAlwaysCommand = manager.commandForMode('always');
    const always = await manager.configure('always');
    assert.equal(always.enabled, true);
    assert.equal(always.mode, 'always');
    assert.equal(always.registry.command, expectedAlwaysCommand);
    const addAlways = registry.calls.find(({ args }) => args[0] === 'add');
    assert.deepEqual(addAlways, {
      file: 'reg.exe',
      args: [
        'add', WINDOWS_RUN_KEY,
        '/v', WINDOWS_RUN_VALUE,
        '/t', 'REG_SZ',
        '/d', expectedAlwaysCommand,
        '/f',
      ],
    });
    assert.match(expectedAlwaysCommand, /launch-windows\.mjs/u);
    assert.match(expectedAlwaysCommand, /--no-browser/u);

    const expectedWatcherCommand = manager.commandForMode('cc-switch');
    const watcher = await manager.configure('cc-switch');
    assert.equal(watcher.enabled, true);
    assert.equal(watcher.mode, 'cc-switch');
    assert.equal(watcher.registry.command, expectedWatcherCommand);
    assert.match(expectedWatcherCommand, /watch-cc-switch\.mjs/u);
    assert.equal(expectedWatcherCommand.includes('launch-windows.mjs'), false);
  });

  it('removes only the fixed current-user value and rejects unrecognised modes', async () => {
    const registry = fakeRegistry({ initialCommand: '"C:\\Other\\node.exe" "C:\\Other\\tool.mjs"' });
    const manager = createWindowsAutostart({
      platform: 'win32',
      runCommand: registry.runCommand,
    });
    const before = await manager.status();
    assert.equal(before.enabled, true);
    assert.equal(before.mode, 'unknown');

    await assert.rejects(() => manager.configure('always & calc.exe'), /mode must be off, always, or cc-switch/u);
    const callsBeforeDisable = registry.calls.length;
    const disabled = await manager.configure('off');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.mode, 'off');
    assert.equal(registry.calls[callsBeforeDisable + 1].file, 'reg.exe');
    assert.deepEqual(registry.calls[callsBeforeDisable + 1].args, [
      'delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f',
    ]);
  });

  it('does not touch the registry outside Windows', async () => {
    let calls = 0;
    const manager = createWindowsAutostart({
      platform: 'linux',
      runCommand: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    });
    const status = await manager.status();
    assert.equal(status.supported, false);
    assert.equal(status.registry.state, 'unsupported');
    assert.equal((await manager.configure('always')).supported, false);
    assert.equal(calls, 0);
  });
});

describe('cc-switch watcher', () => {
  it('recognises tasklist output and waits for stable process edges', () => {
    assert.equal(tasklistContainsCcSwitch('"cc-switch.exe","1234","Console"'), true);
    assert.equal(tasklistContainsCcSwitch('INFO: No tasks are running'), false);

    const detector = createPresenceEdgeDetector({ confirmationSamples: 2 });
    const edges = [false, true, false, true, true, true, false, false].map((value) => detector.observe(value));
    assert.deepEqual(edges, [null, null, null, null, 'present', null, null, 'absent']);
    assert.equal(detector.snapshot().stablePresent, false);
  });

  it('starts the fixed launcher once per confirmed cc-switch start', async () => {
    const presence = [true, true, true, false, false, true, true];
    let starts = 0;
    const messages = [];
    const watcher = createCcSwitchWatcher({
      intervalMs: 1_000,
      confirmationSamples: 2,
      startImmediately: false,
      pollPresence: async () => presence.shift(),
      launch: async () => { starts += 1; },
      logger: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      },
    });
    try {
      for (let index = 0; index < 7; index += 1) await watcher.poll();
    } finally {
      watcher.stop();
    }
    assert.equal(starts, 2);
    assert.equal(messages.filter((message) => message.includes('detected')).length, 2);
    assert.equal(messages.filter((message) => message.includes('re-armed')).length, 1);
  });

  it('uses the existing launcher with no caller-provided command arguments', () => {
    let observed;
    const child = {
      unref() {},
    };
    startMonitorWithLauncher({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      launcherPath: 'C:\\API Monitor\\scripts\\launch-windows.mjs',
      rootDir: 'C:\\API Monitor',
      environment: { ONE: '1' },
      spawnProcess: (file, args, options) => {
        observed = { file, args, options };
        return child;
      },
    });
    assert.deepEqual(observed.file, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(observed.args, ['C:\\API Monitor\\scripts\\launch-windows.mjs', '--no-browser']);
    assert.equal(observed.options.shell, false);
    assert.equal(observed.options.detached, true);

    assert.throws(() => parseWatcherArgs(['--process', 'anything.exe']), /Unknown argument/u);
  });
});
