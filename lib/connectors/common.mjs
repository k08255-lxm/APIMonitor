import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function integer(value, fallback = 0) {
  return Math.round(finiteNumber(value, fallback));
}

export function safeText(value, maximum = 120, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum) || fallback;
}

export function isoTimestamp(value, fallback = Date.now()) {
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  } else {
    milliseconds = Date.parse(value);
  }
  return new Date(Number.isFinite(milliseconds) ? milliseconds : fallback).toISOString();
}

function isPrivateIp(address) {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return false;
}

export async function validateConnectorBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Connector base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Connector base URL is invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.protocol === 'https:') return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || isPrivateIp(hostname)) return url;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Plain HTTP connector host could not be verified as private');
  }
  if (!addresses.length || addresses.some(({ address }) => !isPrivateIp(address))) {
    throw new Error('Plain HTTP connectors are limited to localhost or private LAN hosts');
  }
  return url;
}

export async function responseJson(response, maximumBytes = 5 * 1024 * 1024) {
  if (!response.ok) throw new Error('Connector request failed');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('Connector response is too large');

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Connector returned an empty response');
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error('Connector response is too large');
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Error('Connector returned invalid JSON');
  }
}

export function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
