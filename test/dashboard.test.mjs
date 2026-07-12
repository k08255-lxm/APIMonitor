import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDashboard, mergeDashboardSources } from '../lib/dashboard.mjs';

function event(timestamp, overrides = {}) {
  return {
    id: `event-${timestamp}-${overrides.model ?? 'model'}`,
    timestamp: new Date(timestamp).toISOString(),
    type: 'request',
    service: 'proxy',
    model: 'gpt-a',
    tokens: 0,
    cost: 0,
    latencyMs: 0,
    status: 200,
    keyId: 'key-a',
    ...overrides,
  };
}

function storeFor(events) {
  return {
    async *readEvents() {
      yield* events;
    },
  };
}

describe('buildDashboard', () => {
  it('aggregates the local day, rolling minute, models, keys, and success rate', async () => {
    const now = new Date(2026, 6, 12, 12, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 6, 11, 23, 59, 0, 0).getTime();
    const events = [
      event(now - 30_000, {
        id: 'recent-success',
        model: 'gpt-a',
        tokens: 100,
        cost: 0.01,
        latencyMs: 100,
        status: 200,
        keyId: 'key-a',
      }),
      event(now - 50_000, {
        id: 'recent-failure',
        model: 'gpt-b',
        tokens: 50,
        cost: 0.02,
        latencyMs: 300,
        status: 500,
        keyId: 'key-b',
      }),
      event(now - 120_000, {
        id: 'older-today',
        model: 'gpt-a',
        tokens: 20,
        cost: 0.003,
        latencyMs: 200,
        status: 204,
        keyId: 'key-a',
      }),
      event(yesterday, {
        id: 'yesterday',
        model: 'gpt-old',
        tokens: 500,
        cost: 0.5,
        latencyMs: 999,
        status: 200,
      }),
      {
        id: 'health',
        timestamp: new Date(now - 1_000).toISOString(),
        type: 'health',
        service: 'cc-switch',
        status: 200,
        healthy: true,
      },
    ];

    const dashboard = await buildDashboard(storeFor(events), { now, recentLimit: 10 });

    assert.deepEqual(dashboard.summary, {
      tokens: 170,
      cost: 0.033,
      requests: 3,
      avgLatencyMs: 200,
      rpm: 2,
      tpm: 150,
      successRate: 66.67,
      servicesHealthy: 2,
      servicesTotal: 2,
      activeKeys: 2,
    });
    assert.deepEqual(
      dashboard.models.map(({ model, tokens, requests, share }) => ({ model, tokens, requests, share })),
      [
        { model: 'gpt-a', tokens: 120, requests: 2, share: 70.59 },
        { model: 'gpt-b', tokens: 50, requests: 1, share: 29.41 },
      ],
    );
    assert.deepEqual(dashboard.recent.map((item) => item.id), [
      'recent-success',
      'recent-failure',
      'older-today',
      'yesterday',
    ]);
    assert.deepEqual(dashboard.lifetime, { tokens: 670, cost: 0.533, requests: 4 });
  });

  it('returns an empty dashboard without NaN or a false failure rate', async () => {
    const now = new Date(2026, 6, 12, 0, 0, 0, 0).getTime();
    const dashboard = await buildDashboard(storeFor([]), { now });

    assert.equal(dashboard.summary.requests, 0);
    assert.equal(dashboard.summary.successRate, 100);
    assert.equal(dashboard.summary.avgLatencyMs, 0);
    assert.deepEqual(dashboard.models, []);
    assert.deepEqual(dashboard.recent, []);
    assert.equal(JSON.stringify(dashboard).includes('NaN'), false);
  });

  it('applies rolling 24-hour and 7-day windows to summary, models, and recent rows', async () => {
    const now = new Date(2026, 6, 12, 12, 0, 0, 0).getTime();
    const events = [
      event(now - 60 * 60 * 1_000, { id: 'inside-today', tokens: 10, model: 'recent' }),
      event(now - 23 * 60 * 60 * 1_000, { id: 'inside-24h', tokens: 20, model: 'recent' }),
      event(now - 25 * 60 * 60 * 1_000, { id: 'inside-7d', tokens: 30, model: 'weekly' }),
      event(now - 8 * 24 * 60 * 60 * 1_000, { id: 'outside-7d', tokens: 40, model: 'old' }),
    ];

    const daily = await buildDashboard(storeFor(events), { now, range: '24h' });
    assert.equal(daily.range, '24h');
    assert.equal(daily.summary.tokens, 30);
    assert.equal(daily.summary.requests, 2);
    assert.deepEqual(daily.models.map((model) => model.model), ['recent']);
    assert.deepEqual(daily.recent.map((item) => item.id), ['inside-today', 'inside-24h']);

    const weekly = await buildDashboard(storeFor(events), { now, range: '7d' });
    assert.equal(weekly.range, '7d');
    assert.equal(weekly.summary.tokens, 60);
    assert.equal(weekly.summary.requests, 3);
    assert.deepEqual(
      weekly.recent.map((item) => item.id),
      ['inside-today', 'inside-24h', 'inside-7d'],
    );
    assert.deepEqual(weekly.lifetime, { tokens: 100, cost: 0, requests: 4 });
  });
});

describe('mergeDashboardSources', () => {
  function snapshot(tokens, requests, model) {
    return {
      generatedAt: '2026-07-12T08:00:00.000Z',
      summary: {
        tokens,
        cost: tokens / 1_000,
        requests,
        avgLatencyMs: 100,
        rpm: requests,
        tpm: tokens,
        successRate: 100,
        activeKeys: 1,
      },
      lifetime: { tokens, cost: tokens / 1_000, requests },
      models: [{ model, tokens, cost: tokens / 1_000, requests }],
      timeline: [],
      recent: [],
    };
  }

  it('selects exactly one source in auto and explicit modes, and only sums in all mode', () => {
    const local = snapshot(10, 1, 'local-model');
    local.range = 'today';
    const bundle = {
      snapshots: [
        { sourceId: 'sub2api', ...snapshot(100, 2, 'sub-model') },
        { sourceId: 'cc-switch', ...snapshot(50, 3, 'cc-model') },
      ],
      sources: [
        { id: 'sub2api', name: 'Sub2API', type: 'sub2api', status: 'ok' },
        { id: 'cc-switch', name: 'cc-switch', type: 'cc-switch', status: 'ok' },
      ],
    };

    const automatic = mergeDashboardSources(local, bundle, { source: 'auto' });
    assert.equal(automatic.activeSource, 'sub2api');
    assert.equal(automatic.summary.tokens, 100);
    assert.deepEqual(automatic.models.map((model) => model.model), ['sub-model']);

    const ccSwitch = mergeDashboardSources(local, bundle, { source: 'cc-switch' });
    assert.equal(ccSwitch.activeSource, 'cc-switch');
    assert.equal(ccSwitch.summary.tokens, 50);
    assert.deepEqual(ccSwitch.models.map((model) => model.model), ['cc-model']);

    const localOnly = mergeDashboardSources(local, bundle, { source: 'local' });
    assert.equal(localOnly.summary.tokens, 10);

    const all = mergeDashboardSources(local, bundle, { source: 'all' });
    assert.equal(all.summary.tokens, 160);
    assert.equal(all.summary.requests, 6);
    assert.deepEqual(
      new Set(all.models.map((model) => model.model)),
      new Set(['local-model', 'sub-model', 'cc-model']),
    );
  });
});
