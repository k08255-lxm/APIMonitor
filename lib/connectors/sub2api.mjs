import {
  finiteNumber,
  integer,
  isoTimestamp,
  responseJson,
  safeText,
  validateConnectorBaseUrl,
} from './common.mjs';

function endpoint(base, pathname, query = {}) {
  const url = new URL(base.href);
  const basePath = base.pathname.endsWith('/api/v1') ? base.pathname.slice(0, -7) : base.pathname;
  url.pathname = `${basePath}${pathname}`.replace(/\/{2,}/g, '/');
  url.search = new URLSearchParams(query).toString();
  return url;
}

function envelopeData(value) {
  if (!value || typeof value !== 'object' || value.code !== 0 || !value.data || typeof value.data !== 'object') {
    throw new Error('Sub2API returned an unexpected response');
  }
  return value.data;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeRecent(item) {
  const inputTokens = integer(item.input_tokens);
  const outputTokens = integer(item.output_tokens);
  const cacheTokens = integer(item.cache_creation_tokens) + integer(item.cache_read_tokens);
  const timestamp = isoTimestamp(item.created_at);
  const key = item.api_key && typeof item.api_key === 'object' ? item.api_key : {};
  const group = item.group && typeof item.group === 'object' ? item.group : {};
  const account = item.account && typeof item.account === 'object' ? item.account : {};
  return {
    id: safeText(String(item.id ?? item.request_id ?? ''), 80),
    timestamp,
    time: new Date(timestamp).toLocaleTimeString([], { hour12: false }),
    source: 'sub2api',
    service: safeText(account.name ?? group.name, 80, 'Sub2API'),
    keyId: safeText(key.name ?? String(key.id ?? ''), 64),
    model: safeText(item.model, 120, 'unknown'),
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens + cacheTokens,
    cost: finiteNumber(item.actual_cost ?? item.total_cost),
    latencyMs: integer(item.duration_ms),
    status: 200,
    success: true,
    stream: Boolean(item.stream),
    usageKnown: true,
    outcome: 'completed',
    aborted: false,
    timeout: false,
    method: 'POST',
    path: '',
  };
}

export function createSub2ApiConnector(configuration) {
  const scope = configuration.scope === 'user' ? 'user' : 'admin';
  const credential = scope === 'user' ? configuration.token : configuration.adminKey;
  const snapshotPath = scope === 'user'
    ? '/api/v1/usage/dashboard/snapshot-v2'
    : '/api/v1/admin/dashboard/snapshot-v2';
  const recentPath = scope === 'user' ? '/api/v1/usage' : '/api/v1/admin/usage';
  const dashboardStatsPath = '/api/v1/usage/dashboard/stats';
  const statsPath = scope === 'user' ? '/api/v1/usage/stats' : '/api/v1/admin/usage/stats';

  return {
    id: 'sub2api',
    name: 'Sub2API',
    type: 'sub2api',
    async refresh(range = 'today') {
      if (!configuration.baseUrl || !credential) throw new Error('Sub2API connector configuration is incomplete');
      const base = await validateConnectorBaseUrl(configuration.baseUrl);
      const now = new Date();
      const timezone = configuration.timezone || 'Asia/Hong_Kong';
      const today = dateInTimeZone(now, timezone);
      const lookbackHours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 0;
      const startDate = dateInTimeZone(new Date(now.getTime() - lookbackHours * 3_600_000), timezone);
      const headers = { Accept: 'application/json' };
      if (scope === 'user') headers.Authorization = `Bearer ${String(credential).replace(/^Bearer\s+/i, '')}`;
      else headers['x-api-key'] = credential;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), configuration.timeoutMs ?? 5_000);
      timer.unref();
      try {
        const fetchOptions = { headers, redirect: 'error', signal: controller.signal };
        const snapshotRequest = fetch(endpoint(base, snapshotPath, {
          start_date: startDate,
          end_date: today,
          granularity: 'hour',
          include_stats: 'true',
          include_model_stats: 'true',
          include_group_stats: 'false',
          include_users_trend: 'false',
          timezone,
        }), fetchOptions).then(responseJson).then(envelopeData);
        const recentRequest = fetch(endpoint(base, recentPath, {
          page: '1',
          page_size: '5',
          sort_by: 'created_at',
          sort_order: 'desc',
          start_date: startDate,
          end_date: today,
          timezone,
        }), fetchOptions).then(responseJson).then(envelopeData);
        const dashboardStatsRequest = scope === 'user'
          ? fetch(endpoint(base, dashboardStatsPath, { timezone }), fetchOptions)
            .then(responseJson).then(envelopeData)
          : Promise.resolve(null);
        const rangeStatsRequest = range !== 'today'
          ? fetch(endpoint(base, statsPath, {
            start_date: startDate,
            end_date: today,
            timezone,
          }), fetchOptions).then(responseJson).then(envelopeData)
          : Promise.resolve(null);
        const [snapshotResult, recentResult, dashboardStatsResult, rangeStatsResult] = await Promise.allSettled([
          snapshotRequest,
          recentRequest,
          dashboardStatsRequest,
          rangeStatsRequest,
        ]);
        if (snapshotResult.status === 'rejected') throw new Error('Sub2API snapshot is unavailable');

        const data = snapshotResult.value;
        const snapshotStats = data.stats && typeof data.stats === 'object' ? data.stats : {};
        const userStats = dashboardStatsResult.status === 'fulfilled' && dashboardStatsResult.value
          ? dashboardStatsResult.value
          : null;
        const stats = userStats ?? snapshotStats;
        const rangeStats = rangeStatsResult.status === 'fulfilled' && rangeStatsResult.value
          ? rangeStatsResult.value
          : stats;
        const rawModels = Array.isArray(data.models) ? data.models : [];
        const rawTrend = Array.isArray(data.trend) ? data.trend : [];
        const recentItems = recentResult.status === 'fulfilled' && Array.isArray(recentResult.value.items)
          ? recentResult.value.items
          : [];
        const requests = integer((range === 'today' ? rangeStats?.today_requests : rangeStats?.total_requests)
          ?? rangeStats?.total_requests
          ?? rangeStats?.today_requests
          ?? stats.today_requests);
        return {
          degraded: recentResult.status === 'rejected'
            || (scope === 'user' && dashboardStatsResult.status === 'rejected')
            || (range !== 'today' && rangeStatsResult.status === 'rejected'),
          summary: {
            tokens: integer((range === 'today' ? rangeStats?.today_tokens : rangeStats?.total_tokens)
              ?? rangeStats?.today_tokens
              ?? rangeStats?.total_tokens
              ?? stats.today_tokens),
            cost: finiteNumber(
              (range === 'today' ? rangeStats?.today_actual_cost : rangeStats?.total_actual_cost)
              ?? rangeStats?.today_actual_cost
              ?? rangeStats?.total_actual_cost
              ?? rangeStats?.today_cost
              ?? rangeStats?.total_cost
              ?? stats.today_actual_cost
              ?? stats.today_cost,
            ),
            requests,
            avgLatencyMs: integer(rangeStats?.average_duration_ms ?? stats.average_duration_ms),
            rpm: integer(rangeStats?.rpm ?? stats.rpm),
            tpm: integer(rangeStats?.tpm ?? stats.tpm),
            successRate: 100,
            activeKeys: integer(rangeStats?.active_api_keys ?? stats.active_api_keys),
          },
          lifetime: {
            tokens: integer(stats.total_tokens ?? rangeStats?.total_tokens),
            cost: finiteNumber(
              stats.total_actual_cost
              ?? stats.total_cost
              ?? rangeStats?.total_actual_cost
              ?? rangeStats?.total_cost,
            ),
            requests: integer(stats.total_requests ?? rangeStats?.total_requests),
          },
          models: rawModels.map((model) => ({
            model: safeText(model.model, 120, 'unknown'),
            tokens: integer(model.total_tokens),
            cost: finiteNumber(model.actual_cost ?? model.cost),
            requests: integer(model.requests),
          })),
          timeline: rawTrend.map((point) => ({
            timestamp: isoTimestamp(point.date),
            label: new Date(isoTimestamp(point.date)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            tokens: integer(point.total_tokens),
            requests: integer(point.requests),
            cost: finiteNumber(point.actual_cost ?? point.cost),
            avgLatencyMs: 0,
          })),
          recent: recentItems.map(normalizeRecent),
          generatedAt: isoTimestamp(data.generated_at),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
