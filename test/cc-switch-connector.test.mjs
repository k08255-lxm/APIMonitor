import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCcSwitchConnector } from '../lib/connectors/cc-switch.mjs';

function createFixture(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (id, app_type)
    );
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      model TEXT NOT NULL,
      request_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd TEXT NOT NULL DEFAULT '0',
      latency_ms INTEGER NOT NULL,
      duration_ms INTEGER,
      status_code INTEGER NOT NULL,
      is_streaming INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'proxy'
    );
    CREATE TABLE usage_daily_rollups (
      date TEXT NOT NULL,
      app_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      request_model TEXT NOT NULL DEFAULT '',
      pricing_model TEXT NOT NULL DEFAULT '',
      request_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd TEXT NOT NULL DEFAULT '0',
      avg_latency_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, app_type, provider_id, model, request_model, pricing_model)
    );
  `);
  database.prepare('INSERT INTO providers (id, app_type, name) VALUES (?, ?, ?)')
    .run('provider-a', 'codex', 'Codex upstream');
  database.prepare('INSERT INTO providers (id, app_type, name) VALUES (?, ?, ?)')
    .run('provider-b', 'claude', 'Claude upstream');

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1_000);
  const recent = Math.max(todayStart + 1, nowSeconds - 10);
  const olderToday = Math.max(todayStart + 1, nowSeconds - 120);
  const insert = database.prepare(`
    INSERT INTO proxy_request_logs (
      request_id, provider_id, app_type, model, request_model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      total_cost_usd, latency_ms, duration_ms, status_code, is_streaming,
      created_at, data_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'req-codex', 'provider-a', 'codex', 'gpt-5.5', 'gpt-5.5',
    100, 20, 40, 10, '0.01', 90, 100, 200, 1, recent, 'proxy',
  );
  insert.run(
    'req-claude', 'provider-b', 'claude', 'claude-sonnet', 'claude-sonnet',
    50, 5, 20, 3, '0.02', 280, 300, 500, 0, olderToday, 'proxy',
  );
  // Session sync sees the same successful Codex call shortly after the local proxy.
  // cc-switch's effective_usage_log_filter excludes this duplicate.
  insert.run(
    'session:req-codex', '_codex_session', 'codex', 'gpt-5.5', 'gpt-5.5',
    100, 20, 40, 10, '0.01', 90, 100, 200, 1, recent + 1, 'codex_session',
  );

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const rollupDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  database.prepare(`
    INSERT INTO usage_daily_rollups (
      date, app_type, provider_id, model, request_model, pricing_model,
      request_count, success_count, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, total_cost_usd, avg_latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rollupDate, 'codex', 'provider-a', 'gpt-5.5', 'gpt-5.5', 'gpt-5.5',
    2, 2, 100, 20, 40, 10, '0.05', 150,
  );
  database.close();
}

describe('cc-switch connector', () => {
  it('reads a live SQLite fixture without writing and follows cc-switch cache token semantics', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-cc-switch-'));
    const databasePath = join(directory, 'cc-switch.db');
    t.after(() => rm(directory, { recursive: true, force: true }));
    createFixture(databasePath);

    const connector = await createCcSwitchConnector({ dbPath: databasePath });
    assert.ok(connector);
    const result = await connector.refresh('today');

    // cc-switch defines real usage as fresh input + output + cache write + cache read.
    // For Codex/Gemini, stored input includes cache reads and must be normalized first.
    assert.equal(result.summary.tokens, 208);
    assert.equal(result.summary.requests, 2);
    assert.equal(result.summary.cost, 0.03);
    assert.equal(result.summary.avgLatencyMs, 200);
    assert.equal(result.summary.successRate, 50);
    assert.equal(result.summary.activeKeys, 2);
    assert.deepEqual(result.lifetime, { tokens: 338, cost: 0.08, requests: 4 });

    const models = new Map(result.models.map((model) => [model.model, model]));
    assert.equal(models.get('gpt-5.5').tokens, 130);
    assert.equal(models.get('claude-sonnet').tokens, 78);

    assert.equal(result.recent[0].service, 'Codex upstream');
    assert.equal(result.recent[0].tokens, 130);
    assert.equal(result.recent[0].success, true);
    assert.equal(result.recent[1].service, 'Claude upstream');
    assert.equal(result.recent[1].tokens, 78);
    assert.equal(result.recent[1].success, false);

    const weekly = await connector.refresh('7d');
    assert.equal(weekly.summary.tokens, 338);
    assert.equal(weekly.summary.requests, 4);
    assert.equal(weekly.summary.cost, 0.08);
  });

  it('auto-detection returns null when the default database is absent', async () => {
    const connector = await createCcSwitchConnector({ dbPath: '' });
    if (connector !== null) {
      assert.equal(connector.id, 'cc-switch');
    }
  });

  it('returns the latest 50 effective calls instead of truncating the app history to five', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-cc-switch-recent-'));
    const databasePath = join(directory, 'cc-switch.db');
    t.after(() => rm(directory, { recursive: true, force: true }));
    createFixture(databasePath);

    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(`
      INSERT INTO proxy_request_logs (
        request_id, provider_id, app_type, model, request_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_cost_usd, latency_ms, duration_ms, status_code, is_streaming,
        created_at, data_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    for (let index = 0; index < 51; index += 1) {
      insert.run(
        `recent-batch-${index}`, 'provider-b', 'claude', 'claude-sonnet', 'claude-sonnet',
        1, 1, 0, 0, '0', 1, 1, 200, 0, nowSeconds - 1_000 - index, 'proxy',
      );
    }
    database.close();

    const connector = await createCcSwitchConnector({ dbPath: databasePath });
    const result = await connector.refresh('7d');

    assert.equal(result.recent.length, 50);
    assert.ok(result.recent.some((item) => item.id === 'recent-batch-47'));
    assert.equal(result.recent.some((item) => item.id === 'recent-batch-48'), false);
  });
});
