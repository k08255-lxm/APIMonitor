import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WSCRIPT_PATH = process.platform === 'win32'
  ? resolve(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')
  : 'wscript.exe';

export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE = 'APIMonitor';
export const AUTOSTART_MODES = Object.freeze(['off', 'always', 'cc-switch']);

const MODE_DETAILS = Object.freeze({
  off: Object.freeze({
    id: 'off',
    label: 'Off',
    description: 'Do not start API Monitor when the current user signs in.',
  }),
  always: Object.freeze({
    id: 'always',
    label: 'Always at sign-in',
    description: 'Start API Monitor when the current user signs in.',
  }),
  'cc-switch': Object.freeze({
    id: 'cc-switch',
    label: 'When cc-switch starts',
    description: 'Run a lightweight watcher at sign-in and start API Monitor after cc-switch is detected.',
  }),
});

function escapeExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normaliseWindowsPath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function quoteWindowsArgument(value) {
  // The command only contains application-controlled executable and script
  // paths. Quoting still protects spaces in a user profile or Node install.
  const text = String(value);
  if (text.includes('"')) throw new RangeError('Windows startup paths must not contain quotes');
  return `"${text}"`;
}

function commandForMode(mode, { nodePath, hiddenLauncherPath, wscriptPath }) {
  if (mode === 'always' || mode === 'cc-switch') {
    return [
      quoteWindowsArgument(wscriptPath),
      '//B',
      '//NoLogo',
      quoteWindowsArgument(hiddenLauncherPath),
      quoteWindowsArgument(nodePath),
      mode,
    ].join(' ');
  }
  throw new RangeError('mode must be off, always, or cc-switch');
}

function legacyCommandForMode(mode, { nodePath, launcherPath, watcherPath }) {
  if (mode === 'always') {
    return [quoteWindowsArgument(nodePath), quoteWindowsArgument(launcherPath), '--no-browser'].join(' ');
  }
  if (mode === 'cc-switch') {
    return [quoteWindowsArgument(nodePath), quoteWindowsArgument(watcherPath)].join(' ');
  }
  throw new RangeError('mode must be always or cc-switch');
}

function sameWindowsCommand(left, right) {
  return normaliseWindowsPath(left).trim() === normaliseWindowsPath(right).trim();
}

function classifyCommand(command, paths) {
  if (!command) return 'unknown';
  for (const mode of ['always', 'cc-switch']) {
    if (sameWindowsCommand(command, commandForMode(mode, paths))
        || sameWindowsCommand(command, legacyCommandForMode(mode, paths))) {
      return mode;
    }
  }
  return 'unknown';
}

function parseRegistryValue(output, valueName) {
  const expression = new RegExp(`^\\s*${escapeExpression(valueName)}\\s+REG_[A-Z0-9_]+\\s*(.*)$`, 'imu');
  const match = expression.exec(String(output || ''));
  return match ? match[1].trim() : null;
}

async function runProcess(file, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(file, args, {
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
    child.once('close', (code, signal) => {
      resolveCommand({
        code: Number.isInteger(code) ? code : -1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function registryDetails({ state, present, command = null, writable }) {
  return {
    key: WINDOWS_RUN_KEY,
    valueName: WINDOWS_RUN_VALUE,
    state,
    present,
    writable,
    command,
  };
}

function descriptionFor(mode, registryState) {
  if (registryState === 'error') return 'The current-user Windows startup registry entry could not be read.';
  if (mode === 'off') return 'API Monitor will not be started automatically after sign-in.';
  if (mode === 'always') return 'API Monitor will start after the current user signs in.';
  if (mode === 'cc-switch') return 'A sign-in watcher will start API Monitor after cc-switch is detected.';
  return 'An existing APIMonitor startup entry is not managed by this version.';
}

function supportedStatus() {
  const detail = 'Windows login startup is only supported on Windows.';
  return {
    supported: false,
    enabled: false,
    mode: 'off',
    registry: registryDetails({
      state: 'unsupported',
      present: false,
      writable: false,
    }),
    description: detail,
    detail,
    availableModes: AUTOSTART_MODES.map((mode) => ({ ...MODE_DETAILS[mode] })),
  };
}

function assertMode(mode) {
  if (!AUTOSTART_MODES.includes(mode)) {
    throw new RangeError('mode must be off, always, or cc-switch');
  }
}

/**
 * Creates a narrow wrapper around the current user's Windows Run registry
 * value. The command runner is injectable so tests never need the registry.
 */
export function createWindowsAutostart({
  platform = process.platform,
  runCommand = runProcess,
  rootDir = ROOT_DIR,
  nodePath = process.execPath,
  wscriptPath = DEFAULT_WSCRIPT_PATH,
} = {}) {
  const launcherPath = resolve(rootDir, 'scripts', 'launch-windows.mjs');
  const watcherPath = resolve(rootDir, 'scripts', 'watch-cc-switch.mjs');
  const hiddenLauncherPath = resolve(rootDir, 'scripts', 'launch-autostart-hidden.vbs');
  const commandPaths = { nodePath, launcherPath, watcherPath, hiddenLauncherPath, wscriptPath };
  const supported = platform === 'win32';

  async function readEntry() {
    const result = await runCommand('reg.exe', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE]);
    if (result?.code === 1) {
      return registryDetails({ state: 'missing', present: false, writable: true });
    }
    if (result?.code !== 0) {
      return registryDetails({ state: 'error', present: false, writable: false });
    }
    const command = parseRegistryValue(result.stdout, WINDOWS_RUN_VALUE);
    if (command === null) {
      return registryDetails({ state: 'malformed', present: true, writable: true });
    }
    return registryDetails({ state: 'present', present: true, writable: true, command });
  }

  async function status() {
    if (!supported) return supportedStatus();

    let registry;
    try {
      registry = await readEntry();
    } catch {
      registry = registryDetails({ state: 'error', present: false, writable: false });
    }
    const mode = registry.present ? classifyCommand(registry.command, commandPaths) : 'off';
    const detail = descriptionFor(mode, registry.state);
    return {
      supported: true,
      enabled: registry.present,
      mode,
      registry,
      description: detail,
      detail,
      availableModes: AUTOSTART_MODES.map((item) => ({ ...MODE_DETAILS[item] })),
    };
  }

  async function configure(mode) {
    assertMode(mode);
    if (!supported) return supportedStatus();

    const existing = await readEntry();
    if (existing.state === 'error') {
      throw new Error('Unable to read the current-user Windows startup registry entry');
    }
    if (mode === 'off') {
      if (existing.present) {
        const result = await runCommand('reg.exe', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']);
        if (result?.code !== 0) throw new Error('Unable to remove the current-user Windows startup registry entry');
      }
    } else {
      const command = commandForMode(mode, commandPaths);
      const result = await runCommand('reg.exe', [
        'add', WINDOWS_RUN_KEY,
        '/v', WINDOWS_RUN_VALUE,
        '/t', 'REG_SZ',
        '/d', command,
        '/f',
      ]);
      if (result?.code !== 0) throw new Error('Unable to update the current-user Windows startup registry entry');
    }
    return status();
  }

  async function migrateLegacyEntry() {
    if (!supported) return supportedStatus();
    const existing = await readEntry();
    if (existing.state === 'error') {
      throw new Error('Unable to read the current-user Windows startup registry entry');
    }
    if (existing.present) {
      const mode = classifyCommand(existing.command, commandPaths);
      if (mode === 'always' || mode === 'cc-switch') {
        const currentCommand = commandForMode(mode, commandPaths);
        if (!sameWindowsCommand(existing.command, currentCommand)) {
          const result = await runCommand('reg.exe', [
            'add', WINDOWS_RUN_KEY,
            '/v', WINDOWS_RUN_VALUE,
            '/t', 'REG_SZ',
            '/d', currentCommand,
            '/f',
          ]);
          if (result?.code !== 0) throw new Error('Unable to migrate the Windows startup registry entry');
        }
      }
    }
    return status();
  }

  return Object.freeze({
    supported,
    status,
    configure,
    migrateLegacyEntry,
    commandForMode: (mode) => {
      assertMode(mode);
      return mode === 'off' ? null : commandForMode(mode, commandPaths);
    },
  });
}

export function isAutostartMode(mode) {
  return AUTOSTART_MODES.includes(mode);
}

/**
 * Accept both the compact API form ({ mode }) and UI toggle form
 * ({ enabled, mode }) without ever accepting a startup command from callers.
 */
export function resolveAutostartMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('Expected a JSON object');
  }
  if (Object.keys(value).some((key) => key !== 'mode' && key !== 'enabled') || !isAutostartMode(value.mode)) {
    throw new RangeError('mode must be off, always, or cc-switch');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new RangeError('enabled must be a boolean');
  }
  if (value.mode === 'off') {
    if (value.enabled === true) throw new RangeError('enabled cannot be true when mode is off');
    return 'off';
  }
  return value.enabled === false ? 'off' : value.mode;
}
