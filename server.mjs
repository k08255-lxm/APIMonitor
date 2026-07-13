import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { buildDashboard, mergeDashboardSources } from './lib/dashboard.mjs';
import { createConnectorManager } from './lib/connectors/index.mjs';
import { EventStore } from './lib/event-store.mjs';
import { keyFingerprint, normalizeEvent, parsePricing } from './lib/events.mjs';
import { inspectRequestJson, ProxyCapture } from './lib/proxy-capture.mjs';
import { RuntimeSettingsStore } from './lib/runtime-settings.mjs';
import { createWindowsAutostart, resolveAutostartMode } from './scripts/windows-autostart.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(ROOT, 'public');
const AUTOSTART = createWindowsAutostart({ rootDir: ROOT });
const DATA_FILE = resolveDataFile(process.env.DATA_DIR || 'data');
const SETTINGS_FILE = join(dirname(DATA_FILE), 'settings.json');
const SERVER_STATE_FILE = join(dirname(DATA_FILE), 'server-state.json');
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const PORT = boundedInteger(process.env.PORT, 8787, 1, 65_535);
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'monitor';
const DEFAULT_DASHBOARD_SOURCE = ['auto', 'local', 'sub2api', 'cc-switch', 'all'].includes(process.env.DASHBOARD_SOURCE)
  ? process.env.DASHBOARD_SOURCE
  : 'auto';
const UPSTREAM_TIMEOUT_MS = boundedInteger(process.env.UPSTREAM_TIMEOUT_MS, 300_000, 1_000, 1_800_000);
const MAX_EVENT_BODY_BYTES = boundedInteger(process.env.MAX_EVENT_BODY_BYTES, 1_048_576, 1_024, 10_485_760);
const MAX_SETTINGS_BODY_BYTES = 65_536;
const MAX_BACKEND_CONTROL_BODY_BYTES = 4_096;
const MAX_PROXY_BODY_BYTES = boundedInteger(process.env.MAX_PROXY_BODY_BYTES, 26_214_400, 1_024, 104_857_600);
const CONNECTOR_CACHE_MS = boundedInteger(process.env.CONNECTOR_CACHE_SECONDS, 10, 1, 3_600) * 1_000;
const CONNECTOR_TIMEOUT_MS = boundedInteger(process.env.CONNECTOR_TIMEOUT_MS, 5_000, 500, 60_000);
const PRICING = parsePricing(process.env.MODEL_PRICING_JSON);
const UPSTREAM = parseUpstream(process.env.UPSTREAM_BASE_URL || 'https://api.openai.com');
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PRIVATE_REQUEST_HEADERS = new Set(['cookie', 'origin', 'referer']);
const RESPONSE_REWRITE_HEADERS = new Set(['content-length', 'content-encoding']);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Numeric environment setting must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function resolveDataFile(value) {
  const dataDirectory = isAbsolute(value) ? resolve(value) : resolve(ROOT, value);
  if (!isAbsolute(value)) {
    const relativeDirectory = relative(ROOT, dataDirectory);
    if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
      throw new Error('Relative DATA_DIR must remain inside the application directory');
    }
  }
  return join(dataDirectory, 'events.jsonl');
}

function parseUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('UPSTREAM_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('UPSTREAM_BASE_URL must be an HTTP(S) URL without embedded credentials');
  }
  if (url.search || url.hash) {
    throw new Error('UPSTREAM_BASE_URL cannot include a query string or fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendMethodNotAllowed(response, allow) {
  sendJson(response, 405, { error: 'Method not allowed' }, { Allow: allow.join(', ') });
}

function authorizedForIngest(request) {
  if (!INGEST_TOKEN) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const supplied = createHash('sha256').update(authorization).digest();
  const expected = createHash('sha256').update(`Bearer ${INGEST_TOKEN}`).digest();
  return timingSafeEqual(supplied, expected);
}

function authorizedForDashboard(request) {
  if (!DASHBOARD_PASSWORD) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const supplied = createHash('sha256').update(authorization).digest();
  const expectedValue = `Basic ${Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASSWORD}`).toString('base64')}`;
  const expected = createHash('sha256').update(expectedValue).digest();
  return timingSafeEqual(supplied, expected);
}

function authorizedForProxy(request) {
  if (!PROXY_TOKEN) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const supplied = createHash('sha256').update(authorization).digest();
  const expected = createHash('sha256').update(`Bearer ${PROXY_TOKEN}`).digest();
  return timingSafeEqual(supplied, expected);
}

function requireDashboardAuthorization(request, response) {
  if (authorizedForDashboard(request)) return true;
  sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Basic realm="API Monitor", charset="UTF-8"' });
  return false;
}

function requestIsLoopback(request) {
  const address = String(request.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  return isLoopbackHost(address);
}

function requireSettingsAuthorization(request, response) {
  if (!DASHBOARD_PASSWORD && (!isLoopbackHost(HOST) || !requestIsLoopback(request))) {
    sendJson(response, 403, { error: 'Remote settings require DASHBOARD_PASSWORD' });
    return false;
  }
  return requireDashboardAuthorization(request, response);
}

function requireBackendControlAuthorization(request, response) {
  // The local state-file token is intentionally never returned to a browser.
  // Remote lifecycle actions therefore require an explicitly configured
  // dashboard password, even when the dashboard itself is bound to loopback.
  if (!DASHBOARD_PASSWORD) {
    sendJson(response, 403, { error: 'Backend controls require DASHBOARD_PASSWORD' });
    return false;
  }
  return requireDashboardAuthorization(request, response);
}

function backendControlAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  if (!['stop', 'restart'].includes(value.action)) {
    throw new HttpError(400, 'action must be stop or restart');
  }
  return value.action;
}

function autostartMode(value) {
  try {
    return resolveAutostartMode(value);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid autostart mode');
  }
}

function tokenMatches(value, expected) {
  if (typeof value !== 'string' || !expected) return false;
  const supplied = createHash('sha256').update(value).digest();
  const target = createHash('sha256').update(expected).digest();
  return timingSafeEqual(supplied, target);
}

async function writeServerState(value) {
  await writeFile(SERVER_STATE_FILE, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function dashboardRange(requestUrl) {
  const range = requestUrl.searchParams.get('range') || 'today';
  if (!['today', '24h', '7d'].includes(range)) throw new HttpError(400, 'range must be today, 24h, or 7d');
  return range;
}

function dashboardSource(requestUrl) {
  const source = requestUrl.searchParams.get('source') || DEFAULT_DASHBOARD_SOURCE;
  if (!['auto', 'local', 'sub2api', 'cc-switch', 'all'].includes(source)) {
    throw new HttpError(400, 'source must be auto, local, sub2api, cc-switch, or all');
  }
  return source;
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

async function readRequestBody(request, limit) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new HttpError(413, 'Request body too large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function proxyPathIsSafe(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded !== '/v1' && !decoded.startsWith('/v1/')) return false;
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return false;
  return !decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

function makeUpstreamUrl(requestUrl) {
  const target = new URL(UPSTREAM.href);
  target.pathname = `${UPSTREAM.pathname}${requestUrl.pathname}`.replace(/\/{2,}/g, '/');
  target.search = requestUrl.search;
  return target;
}

function requestHeadersForUpstream(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)
      || PRIVATE_REQUEST_HEADERS.has(lowerName)
      || lowerName === 'host'
      || lowerName === 'content-length'
      || lowerName === 'accept-encoding'
      || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  headers.set('accept-encoding', 'identity');
  if (UPSTREAM_API_KEY) {
    const apiKey = UPSTREAM_API_KEY.replace(/^Bearer\s+/i, '');
    headers.set('authorization', `Bearer ${apiKey}`);
  }
  return headers;
}

function copyUpstreamHeaders(upstreamResponse, response) {
  for (const [name, value] of upstreamResponse.headers) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || RESPONSE_REWRITE_HEADERS.has(lowerName)) continue;
    response.setHeader(name, value);
  }
}

function responseClosedBeforeEnd(response) {
  return response.destroyed && !response.writableEnded;
}

async function waitForDrain(response) {
  if (responseClosedBeforeEnd(response)) return false;
  const drain = once(response, 'drain').then(() => true);
  const close = once(response, 'close').then(() => false);
  return Promise.race([drain, close]);
}

async function relayResponseBody(upstreamResponse, response, capture, state) {
  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      capture.inspect(value);
      if (state.clientDisconnected || responseClosedBeforeEnd(response)) break;
      if (!response.write(Buffer.from(value)) && !await waitForDrain(response)) break;
    }
    if (!state.clientDisconnected && !response.writableEnded) response.end();
  } finally {
    if (state.clientDisconnected) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function handleProxy(request, response, requestUrl, store) {
  if (!proxyPathIsSafe(requestUrl.pathname)) {
    sendJson(response, 400, { error: 'Invalid proxy path' });
    return;
  }
  if (request.method === 'CONNECT' || request.method === 'TRACE') {
    sendMethodNotAllowed(response, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    return;
  }
  if (!authorizedForProxy(request)) {
    sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    return;
  }

  const startedAt = Date.now();
  const state = { clientDisconnected: false, timedOut: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  timeout.unref();

  const onRequestAborted = () => {
    state.clientDisconnected = true;
    controller.abort();
  };
  const onResponseClosed = () => {
    if (!response.writableEnded) {
      state.clientDisconnected = true;
      controller.abort();
    }
  };
  request.once('aborted', onRequestAborted);
  response.once('close', onResponseClosed);

  let requestMeta = {};
  let capture = null;
  let status = 500;
  let outcome = 'upstream_error';
  let recorded = false;
  const authorization = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : UPSTREAM_API_KEY;

  const recordOnce = async () => {
    if (recorded) return;
    recorded = true;
    if (capture) capture.finish();

    const event = normalizeEvent({
      type: 'request',
      timestamp: startedAt,
      service: UPSTREAM.hostname,
      model: capture?.model || requestMeta.model || 'unknown',
      usage: capture?.usage,
      usageKnown: Boolean(capture?.usageKnown),
      cost: capture?.cost,
      latencyMs: Date.now() - startedAt,
      status,
      stream: Boolean(requestMeta.stream),
      keyId: keyFingerprint(authorization),
      method: request.method,
      path: requestUrl.pathname,
      outcome,
    }, { pricing: PRICING, defaultService: UPSTREAM.hostname });

    try {
      await store.append(event);
    } catch {
      console.error('[monitor] unable to persist a proxy event');
    }
  };

  try {
    const hasBody = !['GET', 'HEAD'].includes(request.method || 'GET');
    const body = hasBody ? await readRequestBody(request, MAX_PROXY_BODY_BYTES) : Buffer.alloc(0);
    requestMeta = inspectRequestJson(body, String(request.headers['content-type'] || ''));

    const upstreamResponse = await fetch(makeUpstreamUrl(requestUrl), {
      method: request.method,
      headers: requestHeadersForUpstream(request),
      body: hasBody && body.length ? body : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });

    status = upstreamResponse.status;
    outcome = 'completed';
    const contentType = upstreamResponse.headers.get('content-type') || '';
    capture = new ProxyCapture(contentType);
    if (contentType.toLowerCase().includes('text/event-stream')) requestMeta.stream = true;

    response.statusCode = upstreamResponse.status;
    copyUpstreamHeaders(upstreamResponse, response);
    await relayResponseBody(upstreamResponse, response, capture, state);

    if (state.clientDisconnected) {
      status = 499;
      outcome = 'aborted';
    }
  } catch (error) {
    if (error instanceof HttpError) {
      status = error.status;
      outcome = 'rejected';
      if (!response.headersSent && !state.clientDisconnected) sendJson(response, error.status, { error: error.message });
    } else if (state.timedOut) {
      status = 504;
      outcome = 'timeout';
      if (!response.headersSent && !state.clientDisconnected) sendJson(response, 504, { error: 'Upstream request timed out' });
    } else if (state.clientDisconnected) {
      status = 499;
      outcome = 'aborted';
    } else {
      status = 502;
      outcome = 'upstream_error';
      if (!response.headersSent) sendJson(response, 502, { error: 'Upstream request failed' });
      else response.destroy();
    }
  } finally {
    clearTimeout(timeout);
    request.off('aborted', onRequestAborted);
    response.off('close', onResponseClosed);
    await recordOnce();
  }
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Malformed URL path');
  }
  if (decoded.includes('\\') || decoded.includes('\0') || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new HttpError(400, 'Invalid URL path');
  }
  if (decoded.split('/').some((segment) => segment === '..')) {
    throw new HttpError(400, 'Invalid URL path');
  }

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_ROOT, relativePath);
  const relativeToRoot = relative(PUBLIC_ROOT, filePath);
  if (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === '..' || isAbsolute(relativeToRoot)) {
    throw new HttpError(403, 'Forbidden');
  }
  return filePath;
}

async function serveStatic(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    sendMethodNotAllowed(response, ['GET', 'HEAD']);
    return;
  }

  let rootRealPath;
  let filePath;
  try {
    rootRealPath = await realpath(PUBLIC_ROOT);
    filePath = safeStaticPath(pathname);
    let fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = join(filePath, 'index.html');
      fileStats = await stat(filePath);
    }
    if (!fileStats.isFile()) throw new Error('Not a file');

    const fileRealPath = await realpath(filePath);
    const relativeRealPath = relative(rootRealPath, fileRealPath);
    if (relativeRealPath.startsWith(`..${sep}`) || relativeRealPath === '..' || isAbsolute(relativeRealPath)) {
      throw new HttpError(403, 'Forbidden');
    }

    const contentType = CONTENT_TYPES.get(extname(fileRealPath).toLowerCase()) || 'application/octet-stream';
    const extension = extname(fileRealPath).toLowerCase();
    const cacheControl = extension === '.html' || fileRealPath.endsWith(`${sep}sw.js`)
      ? 'no-cache'
      : 'public, max-age=3600';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStats.size,
      'Cache-Control': cacheControl,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(fileRealPath), response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
    } else {
      sendJson(response, 404, { error: 'Not found' });
    }
  }
}

function writeSse(response, dashboard) {
  if (response.destroyed || response.writableEnded) return false;
  const payload = JSON.stringify(dashboard);
  response.write(`id: ${dashboard.generatedAt}\nevent: update\ndata: ${payload}\n\n`);
  return true;
}

async function main() {
  if (!isLoopbackHost(HOST) && UPSTREAM_API_KEY && !PROXY_TOKEN) {
    console.error('[monitor] refusing non-loopback proxy with UPSTREAM_API_KEY and no PROXY_TOKEN');
    process.exitCode = 1;
    return;
  }

  if (process.env.APIMONITOR_SKIP_AUTOSTART_MIGRATION !== '1') {
    try {
      await AUTOSTART.migrateLegacyEntry();
    } catch {
      console.warn('[monitor] unable to migrate the Windows login startup entry');
    }
  }

  const store = new EventStore(DATA_FILE);
  await store.init();
  const instanceId = randomUUID();
  const controlToken = randomUUID();
  const startedAt = new Date().toISOString();
  let requestShutdown = null;
  const runtimeSettings = new RuntimeSettingsStore(SETTINGS_FILE, {
    sub2api: {
      enabled: Boolean(process.env.SUB2API_BASE_URL || process.env.SUB2API_ADMIN_KEY || process.env.SUB2API_TOKEN),
      baseUrl: process.env.SUB2API_BASE_URL || '',
      adminKey: process.env.SUB2API_ADMIN_KEY || '',
      token: process.env.SUB2API_TOKEN || '',
      scope: process.env.SUB2API_SCOPE || 'admin',
      timezone: process.env.SUB2API_TIMEZONE || 'Asia/Hong_Kong',
    },
    ccSwitch: {
      enabled: process.env.CC_SWITCH_ENABLED !== 'false',
      dbPath: process.env.CC_SWITCH_DB_PATH || '',
    },
  });
  await runtimeSettings.init();
  const connectorOptions = () => runtimeSettings.connectorOptions({
    cacheMs: CONNECTOR_CACHE_MS,
    timeoutMs: CONNECTOR_TIMEOUT_MS,
  });
  let connectorManager = await createConnectorManager(connectorOptions());
  const dashboardSnapshot = async (range = 'today', source = DEFAULT_DASHBOARD_SOURCE) => {
    const activeConnectorManager = connectorManager;
    const [localDashboard, connectors] = await Promise.all([
      buildDashboard(store, { range, recentLimit: 50 }),
      activeConnectorManager.snapshot(range),
    ]);
    return mergeDashboardSources(localDashboard, connectors, { source });
  };

  const sseClients = new Map();
  let broadcastRunning = false;
  let broadcastPending = false;

  const broadcastDashboard = async () => {
    broadcastPending = true;
    if (broadcastRunning) return;
    broadcastRunning = true;
    try {
      while (broadcastPending) {
        broadcastPending = false;
        const subscriptions = new Set([...sseClients.values()].map(({ range, source }) => `${range}\u0000${source}`));
        for (const subscription of subscriptions) {
          const [range, source] = subscription.split('\u0000');
          const dashboard = await dashboardSnapshot(range, source);
          for (const [client, clientRange] of sseClients) {
            if (clientRange.range === range && clientRange.source === source && !writeSse(client, dashboard)) {
              sseClients.delete(client);
            }
          }
        }
      }
    } catch {
      console.error('[monitor] unable to refresh dashboard stream');
    } finally {
      broadcastRunning = false;
    }
  };
  const unsubscribe = store.onAppend(() => {
    setTimeout(() => void broadcastDashboard(), 50).unref();
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients.keys()) {
      if (client.destroyed || client.writableEnded) {
        sseClients.delete(client);
      } else {
        client.write(`: keepalive ${Date.now()}\n\n`);
      }
    }
  }, 15_000);
  heartbeat.unref();
  const connectorRefresh = setInterval(() => {
    if (sseClients.size) void broadcastDashboard();
  }, CONNECTOR_CACHE_MS);
  connectorRefresh.unref();

  let stopping = false;
  let shutdownRequested = false;
  const backendStatus = () => {
    const dashboardPasswordConfigured = Boolean(DASHBOARD_PASSWORD);
    const isStopping = stopping || shutdownRequested;
    const controlsAvailable = dashboardPasswordConfigured && !isStopping;
    return {
      status: isStopping ? 'stopping' : 'running',
      instanceId,
      processId: process.pid,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      bindHost: HOST,
      port: PORT,
      control: {
        enabled: dashboardPasswordConfigured,
        availableActions: controlsAvailable ? ['stop', 'restart'] : [],
        startSupported: false,
      },
    };
  };

  const server = createServer((request, response) => {
    securityHeaders(response);
    void (async () => {
      let requestUrl;
      try {
        requestUrl = new URL(request.url || '/', 'http://monitor.local');
      } catch {
        sendJson(response, 400, { error: 'Malformed request URL' });
        return;
      }

      const { pathname } = requestUrl;
      if (pathname === '/health') {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET']);
        return sendJson(response, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor(process.uptime()),
          instanceId,
          bindHost: HOST,
          port: PORT,
        });
      }

      if (pathname === '/api/backend') {
        if (!['GET', 'POST'].includes(request.method || 'GET')) return sendMethodNotAllowed(response, ['GET', 'POST']);
        if (request.method === 'GET') {
          if (!requireDashboardAuthorization(request, response)) return;
          return sendJson(response, 200, backendStatus());
        }
        if (!requireBackendControlAuthorization(request, response)) return;
        if (stopping || shutdownRequested) return sendJson(response, 409, { error: 'Backend is already stopping' });
        if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          return sendJson(response, 415, { error: 'Content-Type must be application/json' });
        }
        const body = await readRequestBody(request, MAX_BACKEND_CONTROL_BODY_BYTES);
        let value;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON body');
        }
        const action = backendControlAction(value);
        if (!requestShutdown) return sendJson(response, 503, { error: 'Backend control is not ready' });
        shutdownRequested = true;
        sendJson(response, 202, {
          accepted: true,
          action,
          status: action === 'restart' ? 'restarting' : 'stopping',
        });
        setTimeout(() => requestShutdown({ restart: action === 'restart' }), 10).unref();
        return;
      }

      if (pathname === '/api/autostart') {
        if (!['GET', 'POST', 'PUT'].includes(request.method || 'GET')) {
          return sendMethodNotAllowed(response, ['GET', 'POST', 'PUT']);
        }
        // Changing a login entry affects future local sessions. Apply the
        // same explicit password requirement as lifecycle controls even on a
        // loopback-only dashboard.
        if (!requireBackendControlAuthorization(request, response)) return;
        if (request.method === 'GET') return sendJson(response, 200, await AUTOSTART.status());
        if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          return sendJson(response, 415, { error: 'Content-Type must be application/json' });
        }
        const body = await readRequestBody(request, MAX_BACKEND_CONTROL_BODY_BYTES);
        let value;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON body');
        }
        const mode = autostartMode(value);
        let status;
        try {
          status = await AUTOSTART.configure(mode);
        } catch {
          throw new HttpError(503, 'Unable to update Windows login startup');
        }
        if (!status.supported) {
          return sendJson(response, 409, {
            error: 'Windows login startup is only supported on Windows',
            ...status,
          });
        }
        return sendJson(response, 200, {
          updated: true,
          requestedMode: mode,
          ...status,
        });
      }

      if (pathname === '/api/control/stop') {
        if (request.method !== 'POST') return sendMethodNotAllowed(response, ['POST']);
        if (!requestIsLoopback(request)) return sendJson(response, 403, { error: 'Loopback access required' });
        if (!tokenMatches(request.headers['x-monitor-control-token'], controlToken)) {
          return sendJson(response, 403, { error: 'Invalid control token' });
        }
        if (stopping || shutdownRequested) return sendJson(response, 409, { error: 'Backend is already stopping' });
        if (!requestShutdown) return sendJson(response, 503, { error: 'Backend control is not ready' });
        shutdownRequested = true;
        sendJson(response, 202, { stopping: true });
        setTimeout(() => requestShutdown(), 10).unref();
        return;
      }

      if (pathname === '/api/dashboard') {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET']);
        if (!requireDashboardAuthorization(request, response)) return;
        return sendJson(response, 200, await dashboardSnapshot(dashboardRange(requestUrl), dashboardSource(requestUrl)));
      }

      if (pathname === '/api/stream') {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET']);
        if (!requireDashboardAuthorization(request, response)) return;
        const range = dashboardRange(requestUrl);
        const source = dashboardSource(requestUrl);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        sseClients.set(response, { range, source });
        response.once('close', () => sseClients.delete(response));
        writeSse(response, await dashboardSnapshot(range, source));
        return;
      }

      if (pathname === '/api/settings') {
        if (!['GET', 'PUT'].includes(request.method || 'GET')) return sendMethodNotAllowed(response, ['GET', 'PUT']);
        if (!requireSettingsAuthorization(request, response)) return;
        if (request.method === 'GET') return sendJson(response, 200, runtimeSettings.publicView());
        if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          return sendJson(response, 415, { error: 'Content-Type must be application/json' });
        }
        const body = await readRequestBody(request, MAX_SETTINGS_BODY_BYTES);
        let value;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON body');
        }
        try {
          const settings = await runtimeSettings.update(value);
          connectorManager = await createConnectorManager(connectorOptions());
          void broadcastDashboard();
          return sendJson(response, 200, settings);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid settings');
        }
      }

      if (pathname === '/api/events') {
        if (request.method !== 'POST') return sendMethodNotAllowed(response, ['POST']);
        if (!authorizedForIngest(request)) {
          return sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        }
        if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          return sendJson(response, 415, { error: 'Content-Type must be application/json' });
        }

        const body = await readRequestBody(request, MAX_EVENT_BODY_BYTES);
        let value;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON body');
        }
        const inputEvents = Array.isArray(value) ? value : [value];
        if (inputEvents.length === 0 || inputEvents.length > 1_000) {
          throw new HttpError(400, 'Expected between 1 and 1000 events');
        }
        let events;
        try {
          events = inputEvents.map((event) => normalizeEvent(event, { pricing: PRICING }));
        } catch {
          throw new HttpError(400, 'Each event must be a JSON object');
        }
        await store.append(events);
        return sendJson(response, 202, { accepted: events.length, generatedAt: new Date().toISOString() });
      }

      if (pathname === '/v1' || pathname.startsWith('/v1/')) {
        return handleProxy(request, response, requestUrl, store);
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return sendJson(response, 404, { error: 'API endpoint not found' });
      }
      if (!requireDashboardAuthorization(request, response)) return;
      return serveStatic(request, response, pathname);
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        console.error('[monitor] request handling failed');
        sendJson(response, 500, { error: 'Internal server error' });
      }
    });
  });

  server.requestTimeout = Math.max(UPSTREAM_TIMEOUT_MS + 30_000, 330_000);
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(PORT, HOST, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  try {
    await writeServerState({
      version: 1,
      instanceId,
      controlToken,
      host: HOST,
      port: PORT,
      startedAt,
    });
  } catch {
    console.error('[monitor] unable to persist server control state');
  }
  console.log(`[monitor] listening on http://${HOST}:${PORT}`);
  if (!isLoopbackHost(HOST) && !DASHBOARD_PASSWORD) {
    console.warn('[monitor] warning: dashboard is exposed beyond loopback without DASHBOARD_PASSWORD');
  }

  const restartMonitor = () => {
    try {
      const child = spawn(process.execPath, [
        join(ROOT, 'scripts', 'launch-windows.mjs'),
        '--no-browser',
        '--host',
        HOST,
        '--port',
        String(PORT),
      ], {
        cwd: ROOT,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, HOST, PORT: String(PORT) },
      });
      child.once('error', () => {
        console.error('[monitor] unable to relaunch after restart request');
      });
      child.unref();
    } catch {
      console.error('[monitor] unable to relaunch after restart request');
    }
  };

  const shutdown = ({ restart = false } = {}) => {
    if (stopping) return;
    stopping = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearInterval(connectorRefresh);
    for (const client of sseClients.keys()) client.end();
    sseClients.clear();

    let finished = false;
    const forceCloseTimer = setTimeout(() => {
      // A long-running proxy response keeps server.close() pending. Closing the
      // remaining sockets lets the close callback release the port before a
      // replacement instance is launched.
      console.error('[monitor] forcing active connections closed during shutdown');
      server.closeAllConnections();
    }, 10_000);
    forceCloseTimer.unref();

    server.close(() => {
      if (finished) return;
      finished = true;
      clearTimeout(forceCloseTimer);
      void Promise.all([
        store.flush(),
        unlink(SERVER_STATE_FILE).catch(() => undefined),
      ]).finally(() => {
        if (restart) restartMonitor();
        process.exit(0);
      });
    });
  };
  requestShutdown = shutdown;
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(() => {
  console.error('[monitor] failed to start');
  process.exitCode = 1;
});
