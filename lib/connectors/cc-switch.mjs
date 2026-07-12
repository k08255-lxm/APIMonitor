import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';

import { finiteNumber, integer, isoTimestamp, localDateString, safeText } from './common.mjs';

function tokenExpression(alias = '') {
  const field = (name) => `${alias}${name}`;
  return `(
    CASE
      WHEN ${field('app_type')} IN ('codex', 'gemini')
        AND COALESCE(${field('input_tokens')}, 0) >= COALESCE(${field('cache_read_tokens')}, 0)
      THEN COALESCE(${field('input_tokens')}, 0) - COALESCE(${field('cache_read_tokens')}, 0)
      ELSE COALESCE(${field('input_tokens')}, 0)
    END
    + COALESCE(${field('output_tokens')}, 0)
    + COALESCE(${field('cache_read_tokens')}, 0)
    + COALESCE(${field('cache_creation_tokens')}, 0)
  )`;
}

function recentRow(row) {
  const inputTokens = integer(row.input_tokens);
  const outputTokens = integer(row.output_tokens);
  const cacheReadTokens = integer(row.cache_read_tokens);
  const cacheCreationTokens = integer(row.cache_creation_tokens);
  const freshInputTokens = ['codex', 'gemini'].includes(row.app_type) && inputTokens >= cacheReadTokens
    ? inputTokens - cacheReadTokens
    : inputTokens;
  const status = integer(row.status_code, 500);
  const success = status >= 200 && status < 300;
  const timestamp = isoTimestamp(Number(row.created_at));
  return {
    id: safeText(String(row.request_id ?? ''), 80),
    timestamp,
    time: new Date(timestamp).toLocaleTimeString([], { hour12: false }),
    source: 'cc-switch',
    service: safeText(row.provider_name ?? row.provider_id, 80, 'cc-switch'),
    keyId: safeText(String(row.provider_id ?? ''), 64),
    model: safeText(row.model ?? row.request_model, 120, 'unknown'),
    inputTokens,
    outputTokens,
    tokens: freshInputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cost: finiteNumber(row.total_cost_usd),
    latencyMs: integer(row.duration_ms ?? row.latency_ms),
    status,
    success,
    stream: Boolean(row.is_streaming),
    usageKnown: row.input_tokens !== null || row.output_tokens !== null,
    outcome: success ? 'completed' : 'upstream_error',
    aborted: false,
    timeout: false,
    method: 'POST',
    path: '',
  };
}

function queryRecent(database, startSeconds, endSeconds) {
  const effectiveLogs = effectiveLogsSql();
  const joined = `
    SELECT l.request_id, l.provider_id, l.app_type, l.model, l.request_model,
      l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens,
      l.total_cost_usd, l.is_streaming,
      l.latency_ms, l.duration_ms, l.status_code, l.created_at, p.name AS provider_name
    FROM ${effectiveLogs} l
    LEFT JOIN providers p ON p.id = l.provider_id AND p.app_type = l.app_type
    WHERE l.created_at >= ? AND l.created_at <= ?
    ORDER BY l.created_at DESC LIMIT 5`;
  try {
    return database.prepare(joined).all(startSeconds, endSeconds);
  } catch {
    return database.prepare(`
      SELECT request_id, provider_id, app_type, model, request_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_cost_usd, is_streaming,
        latency_ms, duration_ms, status_code, created_at
      FROM ${effectiveLogs}
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC LIMIT 5`).all(startSeconds, endSeconds);
  }
}

// Session sync can mirror a proxy row. Prefer the proxy row when the same
// provider/model/usage appears within the session-sync reconciliation window.
function effectiveLogsSql() {
  return `(SELECT l.* FROM proxy_request_logs l
    WHERE NOT (
      COALESCE(l.data_source, 'proxy') IN ('session_log', 'codex_session', 'gemini_session', 'opencode_session')
      AND EXISTS (
        SELECT 1 FROM proxy_request_logs p
        WHERE COALESCE(p.data_source, 'proxy') = 'proxy'
          AND p.app_type = l.app_type
          AND p.status_code >= 200 AND p.status_code < 300
          AND COALESCE(p.input_tokens, 0) = COALESCE(l.input_tokens, 0)
          AND COALESCE(p.output_tokens, 0) = COALESCE(l.output_tokens, 0)
          AND COALESCE(p.cache_read_tokens, 0) = COALESCE(l.cache_read_tokens, 0)
          AND (
            COALESCE(p.cache_creation_tokens, 0) = COALESCE(l.cache_creation_tokens, 0)
            OR (
              COALESCE(l.cache_creation_tokens, 0) = 0
              AND COALESCE(l.data_source, 'proxy') IN ('codex_session', 'gemini_session', 'opencode_session')
            )
          )
          AND p.created_at BETWEEN l.created_at - 600 AND l.created_at + 600
          AND (
            LOWER(p.model) = LOWER(l.model)
            OR LOWER(p.model) = 'unknown'
            OR LOWER(l.model) = 'unknown'
          )
      )
    ))`;
}

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(database, table, name) {
  return database.prepare(`PRAGMA table_info("${table}")`).all().some((column) => column.name === name);
}

function effectiveModelExpression(database, table, alias = '') {
  const values = [];
  if (hasColumn(database, table, 'pricing_model')) values.push(`NULLIF(${alias}pricing_model, '')`);
  values.push(`NULLIF(${alias}model, '')`);
  if (hasColumn(database, table, 'request_model')) values.push(`NULLIF(${alias}request_model, '')`);
  values.push("'unknown'");
  return `COALESCE(${values.join(', ')})`;
}

function offsetLocalDate(value, days) {
  return localDateString(new Date(value.getFullYear(), value.getMonth(), value.getDate() + days));
}

// Daily rollups cannot be sliced. Include only local calendar days that are
// fully covered by a rolling range, matching cc-switch's own query semantics.
function fullRollupDateBounds(startSeconds, endSeconds) {
  const start = new Date(startSeconds * 1_000);
  const end = new Date(endSeconds * 1_000);
  const startAtMidnight = start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0;
  const endAtLastMinute = end.getHours() === 23 && end.getMinutes() === 59;
  const startDate = startAtMidnight ? localDateString(start) : offsetLocalDate(start, 1);
  const endDate = endAtLastMinute ? localDateString(end) : offsetLocalDate(end, -1);
  return startDate <= endDate ? { startDate, endDate } : null;
}

function addModelRows(target, rows) {
  for (const row of rows) {
    const name = safeText(row.model, 120, 'unknown');
    const model = target.get(name) ?? { model: name, tokens: 0, cost: 0, requests: 0 };
    model.tokens += integer(row.tokens);
    model.cost += finiteNumber(row.cost);
    model.requests += integer(row.requests);
    target.set(name, model);
  }
}

export async function createCcSwitchConnector(configuration) {
  const explicitPath = Boolean(configuration.dbPath);
  const databasePath = resolve(configuration.dbPath || join(homedir(), '.cc-switch', 'cc-switch.db'));
  try {
    await access(databasePath);
  } catch {
    if (!explicitPath) return null;
  }

  return {
    id: 'cc-switch',
    name: 'cc-switch',
    type: 'cc-switch',
    async refresh(range = 'today') {
      let DatabaseSync;
      try {
        ({ DatabaseSync } = await import('node:sqlite'));
      } catch {
        throw new Error('This Node.js version does not provide node:sqlite');
      }

      let database;
      try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        const effectiveLogs = effectiveLogsSql();
        const nowMilliseconds = typeof configuration.now === 'function' ? configuration.now() : Date.now();
        const nowSeconds = Math.floor(nowMilliseconds / 1000);
        const now = new Date(nowMilliseconds);
        const dayStartSeconds = range === 'today'
          ? Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
          : nowSeconds - (range === '24h' ? 24 : 24 * 7) * 3600;
        const firstHourSeconds = Math.floor(dayStartSeconds / 3600) * 3600;
        const detailModel = effectiveModelExpression(database, 'proxy_request_logs');
        const aggregate = database.prepare(`
          SELECT COUNT(*) AS requests,
            COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
            COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost,
            COALESCE(AVG(COALESCE(duration_ms, latency_ms, 0)), 0) AS avg_latency,
            COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0) AS successful
          FROM ${effectiveLogs} WHERE created_at >= ? AND created_at <= ?`).get(dayStartSeconds, nowSeconds);
        const minute = database.prepare(`
          SELECT COUNT(*) AS requests,
            COALESCE(SUM(${tokenExpression()}), 0) AS tokens
          FROM ${effectiveLogs} WHERE created_at >= ? AND created_at <= ?`).get(nowSeconds - 60, nowSeconds);
        const lifetime = database.prepare(`
          SELECT COUNT(*) AS requests,
            COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
            COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost
          FROM ${effectiveLogs}`).get();
        const modelRows = database.prepare(`
          SELECT ${detailModel} AS model,
            COUNT(*) AS requests,
            COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
            COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost
          FROM ${effectiveLogs} WHERE created_at >= ? AND created_at <= ?
          GROUP BY ${detailModel}`).all(dayStartSeconds, nowSeconds);
        const timelineRows = database.prepare(`
          SELECT CAST((created_at - ?) / 3600 AS INTEGER) AS hour,
            COUNT(*) AS requests,
            COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
            COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost,
            COALESCE(AVG(COALESCE(duration_ms, latency_ms, 0)), 0) AS avg_latency
          FROM ${effectiveLogs} WHERE created_at >= ? AND created_at <= ?
          GROUP BY CAST((created_at - ?) / 3600 AS INTEGER)
          ORDER BY hour`).all(firstHourSeconds, dayStartSeconds, nowSeconds, firstHourSeconds);
        const recent = queryRecent(database, dayStartSeconds, nowSeconds);
        const unknownSources = database.prepare(`
          SELECT COUNT(*) AS count FROM proxy_request_logs
          WHERE COALESCE(data_source, 'proxy') NOT IN (
            'proxy', 'session_log', 'codex_session', 'gemini_session', 'opencode_session'
          )`).get();

        let rollupAggregate = {};
        let rollupLifetime = {};
        let rollupModels = [];
        let rollupTimeline = [];
        if (hasTable(database, 'usage_daily_rollups')) {
          const earliest = database.prepare(`SELECT MIN(created_at) AS timestamp FROM ${effectiveLogs}`).get().timestamp;
          const cutoffDate = earliest ? localDateString(new Date(Number(earliest) * 1000)) : '9999-12-31';
          const rollupBounds = fullRollupDateBounds(dayStartSeconds, nowSeconds);
          const rollupRangeClause = rollupBounds ? 'date >= ? AND date <= ? AND date < ?' : '1 = 0';
          const rollupRangeParameters = rollupBounds
            ? [rollupBounds.startDate, rollupBounds.endDate, cutoffDate]
            : [];
          const rollupModel = effectiveModelExpression(database, 'usage_daily_rollups');
          rollupAggregate = database.prepare(`
            SELECT COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
              COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost,
              COALESCE(SUM(success_count), 0) AS successful,
              COALESCE(SUM(avg_latency_ms * request_count), 0) AS latency_weighted
            FROM usage_daily_rollups WHERE ${rollupRangeClause}`)
            .get(...rollupRangeParameters);
          rollupLifetime = database.prepare(`
            SELECT COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
              COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost
            FROM usage_daily_rollups WHERE date < ?`).get(cutoffDate);
          rollupModels = database.prepare(`
            SELECT ${rollupModel} AS model,
              COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
              COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost
            FROM usage_daily_rollups WHERE ${rollupRangeClause}
            GROUP BY ${rollupModel}`)
            .all(...rollupRangeParameters);
          rollupTimeline = database.prepare(`
            SELECT date, COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(${tokenExpression()}), 0) AS tokens,
              COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0) AS cost,
              COALESCE(SUM(avg_latency_ms * request_count), 0) AS latency_weighted
            FROM usage_daily_rollups WHERE ${rollupRangeClause} GROUP BY date ORDER BY date`)
            .all(...rollupRangeParameters);

          const activeProviders = new Set(database.prepare(`
            SELECT DISTINCT provider_id FROM ${effectiveLogs}
            WHERE created_at >= ? AND created_at <= ?`).all(dayStartSeconds, nowSeconds)
            .map((row) => String(row.provider_id)));
          for (const row of database.prepare(`
            SELECT DISTINCT provider_id FROM usage_daily_rollups WHERE ${rollupRangeClause}`)
            .all(...rollupRangeParameters)) {
            activeProviders.add(String(row.provider_id));
          }
          rollupAggregate.active_keys = activeProviders.size;
        }

        const requests = integer(aggregate.requests) + integer(rollupAggregate.requests);
        const successful = integer(aggregate.successful) + integer(rollupAggregate.successful);
        const latencyWeighted = finiteNumber(aggregate.avg_latency) * integer(aggregate.requests)
          + finiteNumber(rollupAggregate.latency_weighted);
        const combinedModels = new Map();
        addModelRows(combinedModels, modelRows);
        addModelRows(combinedModels, rollupModels);
        const combinedTimeline = timelineRows.map((row) => ({ ...row }));
        for (const row of rollupTimeline) {
          const pointDate = new Date(`${row.date}T00:00:00`);
          combinedTimeline.push({
            hour: Math.floor((pointDate.getTime() / 1000 - firstHourSeconds) / 3600),
            requests: row.requests,
            tokens: row.tokens,
            cost: row.cost,
            avg_latency: integer(row.requests) ? finiteNumber(row.latency_weighted) / integer(row.requests) : 0,
          });
        }
        return {
          degraded: integer(unknownSources.count) > 0,
          message: integer(unknownSources.count) > 0
            ? 'Some cc-switch log sources use an unknown data format'
            : '',
          summary: {
            tokens: integer(aggregate.tokens) + integer(rollupAggregate.tokens),
            cost: finiteNumber(aggregate.cost) + finiteNumber(rollupAggregate.cost),
            requests,
            avgLatencyMs: requests ? Math.round(latencyWeighted / requests) : 0,
            rpm: integer(minute.requests),
            tpm: integer(minute.tokens),
            successRate: requests ? (successful / requests) * 100 : 100,
            activeKeys: hasTable(database, 'usage_daily_rollups')
              ? integer(rollupAggregate.active_keys)
              : integer(database.prepare(`SELECT COUNT(DISTINCT provider_id) AS count FROM ${effectiveLogs}
                WHERE created_at >= ? AND created_at <= ?`).get(dayStartSeconds, nowSeconds).count),
          },
          lifetime: {
            tokens: integer(lifetime.tokens) + integer(rollupLifetime.tokens),
            cost: finiteNumber(lifetime.cost) + finiteNumber(rollupLifetime.cost),
            requests: integer(lifetime.requests) + integer(rollupLifetime.requests),
          },
          models: [...combinedModels.values()],
          timeline: combinedTimeline.sort((left, right) => integer(left.hour) - integer(right.hour)).map((row) => {
            const hour = integer(row.hour);
            const pointDate = new Date((firstHourSeconds + hour * 3600) * 1000);
            const timeLabel = pointDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            return {
              timestamp: pointDate.toISOString(),
              label: range === '7d'
                ? `${String(pointDate.getMonth() + 1).padStart(2, '0')}-${String(pointDate.getDate()).padStart(2, '0')} ${timeLabel}`
                : timeLabel,
              tokens: integer(row.tokens),
              requests: integer(row.requests),
              cost: finiteNumber(row.cost),
              avgLatencyMs: integer(row.avg_latency),
            };
          }),
          recent: recent.map(recentRow),
          generatedAt: new Date().toISOString(),
        };
      } catch {
        throw new Error('cc-switch database is unavailable or incompatible');
      } finally {
        database?.close();
      }
    },
  };
}
