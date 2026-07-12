#!/usr/bin/env node

/**
 * Windows-friendly launcher for the API Monitor.
 *
 * It intentionally lives outside server.mjs so the server remains a normal
 * foreground Node process for development and service managers. Double
 * clicking the root .cmd file invokes this script, reuses a healthy instance
 * when one is already listening, and opens the dashboard when ready.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 250;

function parseArgs(argv) {
  const options = {
    port: undefined,
    host: undefined,
    waitMs: DEFAULT_WAIT_MS,
    noBrowser: false,
    dryRun: false,
    lan: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port' && argv[index + 1]) {
      options.port = argv[++index];
    } else if (arg.startsWith('--port=')) {
      options.port = arg.slice('--port='.length);
    } else if (arg === '--host' && argv[index + 1]) {
      options.host = argv[++index];
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--wait-ms' && argv[index + 1]) {
      options.waitMs = argv[++index];
    } else if (arg.startsWith('--wait-ms=')) {
      options.waitMs = arg.slice('--wait-ms='.length);
    } else if (arg === '--no-browser') {
      options.noBrowser = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--lan') {
      options.lan = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function readDotEnv() {
  const filePath = resolve(ROOT_DIR, '.env');
  if (!existsSync(filePath)) return {};
  const values = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^\uFEFF/u, '');
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    if (value === undefined || value === '') return fallback;
    throw new Error(`${name} 必须是 1 到 65535 之间的整数`);
  }
  return parsed;
}

function waitMilliseconds(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error('--wait-ms 必须是 1000 到 300000 之间的整数');
  }
  return parsed;
}

function resolveConfig(options) {
  const dotEnv = readDotEnv();
  const port = positiveInteger(options.port ?? process.env.PORT ?? dotEnv.PORT, DEFAULT_PORT, '端口');
  const host = options.lan
    ? '0.0.0.0'
    : String(options.host ?? process.env.HOST ?? dotEnv.HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const dashboardPassword = String(process.env.DASHBOARD_PASSWORD ?? dotEnv.DASHBOARD_PASSWORD ?? '').trim();
  if (!isLoopbackHost(host) && !dashboardPassword) {
    throw new Error('手机/局域网启动要求在 .env 中设置 DASHBOARD_PASSWORD');
  }
  return {
    port,
    host,
    waitMs: waitMilliseconds(options.waitMs),
    dashboardPassword,
  };
}

function isLoopbackHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

function probeHost(host) {
  const value = String(host || DEFAULT_HOST).trim();
  if (value === '0.0.0.0' || value === '::' || value === '::0') return '127.0.0.1';
  return value;
}

function browserHost(host) {
  const value = probeHost(host);
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

function dashboardUrl(config) {
  return `http://${browserHost(config.host)}:${config.port}/`;
}

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && (
    parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
  );
}

function lanDashboardUrl(config) {
  if (isLoopbackHost(config.host)) return null;
  const entries = Object.values(networkInterfaces()).flat().filter((entry) => (
    entry && entry.family === 'IPv4' && !entry.internal && privateIpv4(entry.address)
  ));
  const address = entries[0]?.address;
  return address ? `http://${address}:${config.port}/` : null;
}

function logPath() {
  const dataDir = resolve(ROOT_DIR, 'data');
  mkdirSync(dataDir, { recursive: true });
  return resolve(dataDir, 'launcher.log');
}

function logMessage(message, logFile = logPath()) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(logFile, line, 'utf8');
}

async function healthCheck(url) {
  try {
    const response = await fetch(new URL('/health', url), {
      signal: AbortSignal.timeout(1_500),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.status === 'ok' ? body : null;
  } catch {
    return null;
  }
}

async function waitForHealth(url, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(url)) return true;
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, DEFAULT_POLL_MS));
  }
  return healthCheck(url);
}

function startServer(config, logFile) {
  const outputFd = openSync(logFile, 'a');
  const nodeArgs = [];
  if (existsSync(resolve(ROOT_DIR, '.env'))) nodeArgs.push('--env-file=.env');
  nodeArgs.push('server.mjs');
  const child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outputFd, outputFd],
    // Explicit values keep launcher flags and the probe target in sync with
    // Node's env-file precedence rules (process.env wins over .env).
    env: { ...process.env, HOST: config.host, PORT: String(config.port) },
  });
  closeSync(outputFd);
  child.unref();
  return child;
}

function openBrowser(url) {
  if (process.platform !== 'win32') return false;
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '', url], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  browser.unref();
  return true;
}

function printHelp() {
  console.log([
    'API Monitor Windows 启动器',
    '',
    '双击根目录的“启动监控.cmd”即可自动复用或启动服务并打开浏览器。',
    '“启动手机监控.cmd”使用 --lan 模式，并要求 DASHBOARD_PASSWORD。',
    '可选参数: --port 8787 --host 127.0.0.1 --lan --no-browser --dry-run',
  ].join('\n'));
}

function sameBindHost(runningHost, requestedHost) {
  const current = String(runningHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  const requested = String(requestedHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  return current === requested;
}

function printReady(config, url) {
  if (isLoopbackHost(config.host)) return;
  const lanUrl = lanDashboardUrl(config);
  if (lanUrl) {
    console.log(`手机访问地址: ${lanUrl}`);
    console.log('登录用户名: monitor；密码为 .env 中的 DASHBOARD_PASSWORD');
  } else {
    console.log('未找到私有 IPv4 地址，请在命令行运行 ipconfig 后使用电脑的局域网 IPv4。');
  }
  console.log(`本机访问地址: ${url}`);
}

export async function launch(argv = process.argv.slice(2)) {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
    throw new Error(`需要 Node.js 22.5 或更高版本，当前为 ${process.versions.node}`);
  }
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { action: 'help' };
  }
  const config = resolveConfig(options);
  const url = dashboardUrl(config);
  const mobileUrl = lanDashboardUrl(config);
  const logFile = logPath();

  if (options.dryRun) {
    console.log(JSON.stringify({ root: ROOT_DIR, url, mobileUrl, host: config.host, port: config.port, logFile }, null, 2));
    return { action: 'dry-run', config, url, logFile };
  }

  const healthy = await healthCheck(url);
  if (healthy) {
    if (healthy.bindHost && !sameBindHost(healthy.bindHost, config.host)) {
      throw new Error(`当前服务监听 ${healthy.bindHost}，与请求的 ${config.host} 不一致。请先双击“关闭监控.cmd”，再重新启动。`);
    }
    if (!healthy.bindHost && !isLoopbackHost(config.host)) {
      throw new Error('当前服务版本无法确认局域网监听状态。请先双击“关闭监控.cmd”，再重新启动。');
    }
    logMessage(`复用已运行服务: ${url}`, logFile);
    console.log(`监控服务已在运行，正在打开 ${url}`);
  } else {
    logMessage(`未发现健康服务，后台启动 server.mjs: ${url}`, logFile);
    console.log('正在后台启动监控服务，请稍候...');
    const child = startServer(config, logFile);
    const ready = await waitForHealth(url, config.waitMs, child);
    if (!ready) {
      logMessage(`启动失败或健康检查超时 (pid=${child.pid ?? 'unknown'})`, logFile);
      throw new Error(`服务未能在 ${Math.ceil(config.waitMs / 1000)} 秒内就绪，请查看 ${logFile}`);
    }
    logMessage(`服务已就绪 (pid=${child.pid ?? 'unknown'}): ${url}`, logFile);
    console.log(`监控服务已启动，正在打开 ${url}`);
  }

  printReady(config, url);
  if (!options.noBrowser) openBrowser(url);
  return { action: 'ready', config, url, logFile };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  launch().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      logMessage(`启动器错误: ${message}`);
    } catch {
      // Logging must not hide the actionable terminal error.
    }
    console.error(`启动失败: ${message}`);
    process.exitCode = 1;
  });
}
