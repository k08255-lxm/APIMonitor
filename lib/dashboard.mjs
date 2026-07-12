function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function round(value, places = 2) {
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRequest(event) {
  return event.type !== 'health';
}

function successful(event) {
  return number(event.status) >= 200 && number(event.status) < 400;
}

function recentView(event) {
  const date = new Date(timestamp(event.timestamp));
  const service = String(event.service ?? 'upstream');
  const keyId = String(event.keyId ?? '');
  const tokens = number(event.tokens);
  return {
    id: String(event.id ?? ''),
    timestamp: date.toISOString(),
    time: date.toLocaleTimeString([], { hour12: false }),
    source: String(event.source ?? 'local'),
    service,
    project: service,
    keyId,
    keyLabel: keyId,
    model: String(event.model ?? 'unknown'),
    inputTokens: number(event.inputTokens),
    outputTokens: number(event.outputTokens),
    tokens,
    totalTokens: tokens,
    cost: round(number(event.cost), 6),
    latencyMs: number(event.latencyMs),
    status: number(event.status),
    success: successful(event),
    stream: Boolean(event.stream),
    usageKnown: Boolean(event.usageKnown),
    outcome: String(event.outcome ?? 'completed'),
    aborted: Boolean(event.aborted),
    timeout: Boolean(event.timeout),
    method: String(event.method ?? ''),
    path: String(event.path ?? ''),
  };
}

export async function buildDashboard(store, options = {}) {
  const now = options.now ?? Date.now();
  const nowDate = new Date(now);
  const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const range = ['today', '24h', '7d'].includes(options.range) ? options.range : 'today';
  const windowStart = range === 'today'
    ? dayStart
    : now - (range === '24h' ? 24 : 24 * 7) * 3_600_000;
  const firstHour = Math.floor(windowStart / 3_600_000) * 3_600_000;
  const lastHour = Math.floor(now / 3_600_000) * 3_600_000;
  const hourCount = Math.floor((lastHour - firstHour) / 3_600_000) + 1;
  const recentLimit = options.recentLimit ?? 20;

  const summary = {
    tokens: 0,
    cost: 0,
    requests: 0,
    latencyTotal: 0,
    latencySamples: 0,
    successful: 0,
    minuteTokens: 0,
    minuteRequests: 0,
  };
  const lifetime = { tokens: 0, cost: 0, requests: 0 };
  const recent = [];
  const models = new Map();
  const services = new Map();
  const activeKeys = new Set();
  const hours = Array.from({ length: hourCount }, (_, offset) => {
    const bucketDate = new Date(firstHour + offset * 3_600_000);
    const hourLabel = `${String(bucketDate.getHours()).padStart(2, '0')}:00`;
    return {
    timestamp: bucketDate.toISOString(),
    label: range === '7d'
      ? `${String(bucketDate.getMonth() + 1).padStart(2, '0')}-${String(bucketDate.getDate()).padStart(2, '0')} ${hourLabel}`
      : hourLabel,
    tokens: 0,
    requests: 0,
    cost: 0,
    latencyTotal: 0,
    latencySamples: 0,
  };
  });

  for await (const event of store.readEvents()) {
    const occurredAt = timestamp(event.timestamp);
    if (!occurredAt) continue;

    const serviceName = String(event.service ?? 'upstream');
    const knownService = services.get(serviceName);
    if (!knownService || occurredAt >= knownService.timestamp) {
      services.set(serviceName, {
        timestamp: occurredAt,
        healthy: typeof event.healthy === 'boolean' ? event.healthy : successful(event),
      });
    }

    if (!isRequest(event)) continue;

    const tokens = number(event.tokens);
    const cost = number(event.cost);
    lifetime.tokens += tokens;
    lifetime.cost += cost;
    lifetime.requests += 1;

    const withinWindow = occurredAt >= windowStart && occurredAt <= now + 5_000;
    if (range === 'today' || withinWindow) {
      recent.push(event);
      recent.sort((left, right) => timestamp(right.timestamp) - timestamp(left.timestamp));
      if (recent.length > recentLimit) recent.length = recentLimit;
    }

    if (!withinWindow) continue;

    summary.tokens += tokens;
    summary.cost += cost;
    summary.requests += 1;
    summary.successful += successful(event) ? 1 : 0;
    const latency = number(event.latencyMs);
    summary.latencyTotal += latency;
    summary.latencySamples += 1;

    if (occurredAt >= now - 60_000) {
      summary.minuteTokens += tokens;
      summary.minuteRequests += 1;
    }

    if (event.keyId) activeKeys.add(String(event.keyId));

    const modelName = String(event.model || 'unknown');
    const model = models.get(modelName) ?? { model: modelName, tokens: 0, cost: 0, requests: 0 };
    model.tokens += tokens;
    model.cost += cost;
    model.requests += 1;
    models.set(modelName, model);

    const hour = Math.floor((occurredAt - firstHour) / 3_600_000);
    const bucket = hours[hour];
    if (bucket) {
      bucket.tokens += tokens;
      bucket.cost += cost;
      bucket.requests += 1;
      bucket.latencyTotal += latency;
      bucket.latencySamples += 1;
    }
  }

  const modelList = [...models.values()]
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests)
    .map((model) => ({
      ...model,
      cost: round(model.cost, 6),
      share: summary.tokens ? round((model.tokens / summary.tokens) * 100, 2) : 0,
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    range,
    summary: {
      tokens: summary.tokens,
      cost: round(summary.cost, 6),
      requests: summary.requests,
      avgLatencyMs: summary.latencySamples ? Math.round(summary.latencyTotal / summary.latencySamples) : 0,
      rpm: summary.minuteRequests,
      tpm: summary.minuteTokens,
      successRate: summary.requests ? round((summary.successful / summary.requests) * 100, 2) : 100,
      servicesHealthy: [...services.values()].filter((service) => service.healthy).length,
      servicesTotal: services.size,
      activeKeys: activeKeys.size,
    },
    recent: recent.map(recentView),
    models: modelList,
    timeline: hours.map((bucket) => ({
      timestamp: bucket.timestamp,
      label: bucket.label,
      time: bucket.label,
      tokens: bucket.tokens,
      requests: bucket.requests,
      cost: round(bucket.cost, 6),
      avgLatencyMs: bucket.latencySamples ? Math.round(bucket.latencyTotal / bucket.latencySamples) : 0,
    })),
    lifetime: {
      tokens: lifetime.tokens,
      cost: round(lifetime.cost, 6),
      requests: lifetime.requests,
    },
  };
}

function timelineKey(point) {
  const date = new Date(point.timestamp);
  if (Number.isFinite(date.getTime())) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
  }
  return String(point.time ?? point.label ?? '');
}

function normalizedRecent(item, sourceId) {
  const tokens = number(item.totalTokens ?? item.tokens) || number(item.inputTokens) + number(item.outputTokens);
  const service = String(item.project ?? item.service ?? sourceId);
  const keyId = String(item.keyLabel ?? item.keyId ?? '');
  return {
    ...item,
    source: String(item.source ?? sourceId),
    service,
    project: service,
    keyId,
    keyLabel: keyId,
    tokens,
    totalTokens: tokens,
  };
}

export function mergeDashboardSources(localDashboard, connectorBundle = {}, options = {}) {
  const allSnapshots = Array.isArray(connectorBundle.snapshots) ? connectorBundle.snapshots : [];
  const connectorSources = Array.isArray(connectorBundle.sources) ? connectorBundle.sources : [];
  const requestedSource = ['auto', 'local', 'sub2api', 'cc-switch', 'all'].includes(options.source)
    ? options.source
    : 'auto';
  let activeSource = requestedSource;
  let snapshots;
  if (requestedSource === 'all') {
    snapshots = allSnapshots;
  } else if (requestedSource === 'local') {
    snapshots = [];
    activeSource = 'local';
  } else if (requestedSource === 'auto') {
    const priority = ['sub2api', 'cc-switch'];
    const selected = priority
      .map((id) => allSnapshots.find((snapshot) => snapshot.sourceId === id))
      .find(Boolean);
    snapshots = selected ? [selected] : [];
    activeSource = selected?.sourceId ?? 'local';
  } else {
    const selected = allSnapshots.find((snapshot) => snapshot.sourceId === requestedSource);
    snapshots = selected ? [selected] : [];
    activeSource = selected ? requestedSource : 'local';
  }
  const includeLocal = requestedSource === 'all' || activeSource === 'local';
  const pieces = [
    ...(includeLocal ? [{ sourceId: 'local', ...localDashboard }] : []),
    ...snapshots,
  ];

  const summary = {
    tokens: 0,
    cost: 0,
    requests: 0,
    latencyWeighted: 0,
    successWeighted: 0,
    rpm: 0,
    tpm: 0,
    activeKeys: 0,
  };
  const lifetime = { tokens: 0, cost: 0, requests: 0 };
  const models = new Map();
  const timeline = new Map();
  const recent = [];

  for (const piece of pieces) {
    const itemSummary = piece.summary ?? {};
    const requests = number(itemSummary.requests);
    summary.tokens += number(itemSummary.tokens);
    summary.cost += number(itemSummary.cost);
    summary.requests += requests;
    summary.latencyWeighted += number(itemSummary.avgLatencyMs) * requests;
    summary.successWeighted += number(itemSummary.successRate) * requests;
    summary.rpm += number(itemSummary.rpm);
    summary.tpm += number(itemSummary.tpm);
    summary.activeKeys += number(itemSummary.activeKeys);

    lifetime.tokens += number(piece.lifetime?.tokens);
    lifetime.cost += number(piece.lifetime?.cost);
    lifetime.requests += number(piece.lifetime?.requests);

    for (const model of piece.models ?? []) {
      const name = String(model.model || 'unknown');
      const merged = models.get(name) ?? { model: name, tokens: 0, cost: 0, requests: 0 };
      merged.tokens += number(model.tokens);
      merged.cost += number(model.cost);
      merged.requests += number(model.requests);
      models.set(name, merged);
    }

    for (const point of piece.timeline ?? []) {
      const key = timelineKey(point);
      const pointRequests = number(point.requests);
      const merged = timeline.get(key) ?? {
        timestamp: point.timestamp,
        label: String(point.time ?? point.label ?? ''),
        tokens: 0,
        requests: 0,
        cost: 0,
        latencyWeighted: 0,
      };
      merged.tokens += number(point.tokens);
      merged.requests += pointRequests;
      merged.cost += number(point.cost);
      merged.latencyWeighted += number(point.avgLatencyMs) * pointRequests;
      timeline.set(key, merged);
    }

    for (const item of piece.recent ?? []) recent.push(normalizedRecent(item, piece.sourceId));
  }

  const modelList = [...models.values()]
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests)
    .map((model) => ({
      ...model,
      cost: round(model.cost, 6),
      share: summary.tokens ? round((model.tokens / summary.tokens) * 100, 2) : 0,
    }));
  const sources = [{
    id: 'local',
    name: 'API Monitor',
    type: 'local',
    status: 'ok',
    message: '',
    lastSyncAt: localDashboard.generatedAt,
  }, ...connectorSources];

  return {
    generatedAt: new Date().toISOString(),
    range: localDashboard.range ?? 'today',
    activeSource,
    summary: {
      tokens: summary.tokens,
      cost: round(summary.cost, 6),
      requests: summary.requests,
      avgLatencyMs: summary.requests ? Math.round(summary.latencyWeighted / summary.requests) : 0,
      rpm: summary.rpm,
      tpm: summary.tpm,
      successRate: summary.requests ? round(summary.successWeighted / summary.requests, 2) : 100,
      servicesHealthy: sources.filter((source) => source.status === 'ok').length,
      servicesTotal: sources.length,
      activeKeys: summary.activeKeys,
    },
    recent: recent
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      .slice(0, 20),
    models: modelList,
    timeline: [...timeline.values()]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .map((point) => ({
        timestamp: point.timestamp,
        label: point.label,
        time: point.label,
        tokens: point.tokens,
        requests: point.requests,
        cost: round(point.cost, 6),
        avgLatencyMs: point.requests ? Math.round(point.latencyWeighted / point.requests) : 0,
      })),
    lifetime: {
      tokens: lifetime.tokens,
      cost: round(lifetime.cost, 6),
      requests: lifetime.requests,
    },
    sources,
  };
}
