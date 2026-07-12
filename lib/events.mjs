import { createHash, randomUUID } from 'node:crypto';

const MAX_TOKEN_COUNT = 1_000_000_000_000_000;

function finiteNumber(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, maximum);
}

function integer(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Math.round(finiteNumber(value, fallback, maximum));
}

function text(value, maximumLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximumLength) || fallback;
}

function eventTimestamp(value, now) {
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  } else {
    milliseconds = Date.parse(value);
  }

  // Do not let a bad producer poison future dashboard windows.
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > now + 86_400_000) {
    milliseconds = now;
  }
  return new Date(milliseconds).toISOString();
}

function statusCode(value, fallback = 200) {
  if (typeof value === 'string') {
    if (/^(ok|healthy|success)$/i.test(value)) return 200;
    if (/^(error|failed|unhealthy)$/i.test(value)) return 500;
  }
  const status = integer(value, fallback, 999);
  return status >= 100 ? status : fallback;
}

function usageFrom(source) {
  const usage = source && typeof source.usage === 'object' ? source.usage : {};
  const inputTokens = integer(
    source?.inputTokens ?? usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    0,
    MAX_TOKEN_COUNT,
  );
  const outputTokens = integer(
    source?.outputTokens ?? usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    0,
    MAX_TOKEN_COUNT,
  );
  const suppliedTotal = source?.tokens ?? source?.totalTokens ?? usage.totalTokens ?? usage.total_tokens;
  const totalTokens = integer(suppliedTotal, inputTokens + outputTokens, MAX_TOKEN_COUNT);

  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(totalTokens, inputTokens + outputTokens),
  };
}

function pricingFor(model, pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  if (pricing[model]) return pricing[model];

  let best = null;
  let bestLength = -1;
  for (const [pattern, value] of Object.entries(pricing)) {
    if (pattern === 'default') continue;
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
    if (prefix !== null && model.startsWith(prefix) && prefix.length > bestLength) {
      best = value;
      bestLength = prefix.length;
    }
  }
  return best ?? pricing.default ?? null;
}

function eventCost(source, model, usage, pricing) {
  const explicit = source?.cost ?? source?.usage?.cost ?? source?.usage?.cost_usd;
  if (explicit !== undefined && explicit !== null) {
    return finiteNumber(explicit, 0, 1_000_000_000);
  }

  const rate = pricingFor(model, pricing);
  if (!rate || typeof rate !== 'object') return 0;
  const inputRate = finiteNumber(rate.inputPerMillion ?? rate.input, 0, 1_000_000);
  const outputRate = finiteNumber(rate.outputPerMillion ?? rate.output, 0, 1_000_000);
  return (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000;
}

export function keyFingerprint(authorization) {
  if (typeof authorization !== 'string' || !authorization.trim()) return '';
  return `key-${createHash('sha256').update(authorization).digest('hex').slice(0, 10)}`;
}

export function normalizeEvent(source, options = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Each event must be a JSON object');
  }

  const now = options.now ?? Date.now();
  const usage = usageFrom(source);
  const type = source.type === 'health' ? 'health' : 'request';
  const model = text(source.model, 120, type === 'request' ? 'unknown' : 'health');
  const rawKeyId = source.keyId ?? source.keyName ?? source.apiKeyId;
  const keyId = text(rawKeyId, 64);
  const status = statusCode(source.status ?? source.statusCode, type === 'health' && source.healthy === false ? 503 : 200);
  const outcome = ['completed', 'aborted', 'timeout', 'upstream_error', 'rejected'].includes(source.outcome)
    ? source.outcome
    : 'completed';
  const usageKnown = typeof source.usageKnown === 'boolean'
    ? source.usageKnown
    : source.tokens !== undefined || source.totalTokens !== undefined || source.usage !== undefined;

  return {
    id: text(source.id, 80, randomUUID()),
    timestamp: eventTimestamp(source.timestamp ?? source.createdAt ?? source.time, now),
    type,
    service: text(source.service, 80, options.defaultService ?? 'upstream'),
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokens: usage.totalTokens,
    cost: eventCost(source, model, usage, options.pricing),
    latencyMs: integer(source.latencyMs ?? source.latency ?? source.durationMs, 0, 86_400_000),
    status,
    healthy: typeof source.healthy === 'boolean' ? source.healthy : status >= 200 && status < 400,
    stream: Boolean(source.stream),
    usageKnown,
    outcome,
    aborted: outcome === 'aborted',
    timeout: outcome === 'timeout',
    keyId,
    method: text(source.method, 12).toUpperCase(),
    path: text(source.path, 240),
  };
}

export function parsePricing(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('MODEL_PRICING_JSON must be valid JSON');
  }
}
