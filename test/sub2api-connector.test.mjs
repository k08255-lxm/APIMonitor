import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSub2ApiConnector } from '../lib/connectors/sub2api.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function envelope(data) {
  return { code: 0, message: 'success', data };
}

describe('Sub2API connector', () => {
  it('maps the real admin snapshot and recent-log contracts without leaking the admin key', async (t) => {
    const adminKey = 'sub2api-admin-private-key';
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      calls.push({
        url,
        adminKey: options.headers?.['x-api-key'],
        authorization: options.headers?.Authorization,
      });

      if (url.pathname === '/api/v1/admin/dashboard/snapshot-v2') {
        return jsonResponse(envelope({
          generated_at: '2026-07-12T08:00:00.000Z',
          stats: {
            today_requests: 2,
            today_tokens: 150,
            today_cost: 0.03,
            total_requests: 20,
            total_tokens: 1_500,
            total_cost: 0.3,
            average_duration_ms: 250,
            rpm: 3,
            tpm: 400,
            active_api_keys: 4,
          },
          models: [{
            model: 'gpt-5.5',
            requests: 2,
            total_tokens: 150,
            cost: 0.03,
          }],
          trend: [{
            date: '2026-07-12T07:00:00.000Z',
            requests: 2,
            total_tokens: 150,
            cost: 0.03,
          }],
        }));
      }

      if (url.pathname === '/api/v1/admin/usage') {
        return jsonResponse(envelope({
          items: [{
            id: 91,
            request_id: 'req-91',
            model: 'gpt-5.5',
            input_tokens: 120,
            output_tokens: 30,
            total_cost: 0.04,
            actual_cost: 0.03,
            duration_ms: 250,
            stream: true,
            created_at: '2026-07-12T07:59:00.000Z',
            api_key: { id: 7, name: 'mobile' },
            account: { id: 4, name: 'OpenAI primary' },
          }],
          total: 1,
          page: 1,
          page_size: 5,
          pages: 1,
        }));
      }

      throw new Error(`Unexpected Sub2API URL: ${url}`);
    };

    const connector = createSub2ApiConnector({
      baseUrl: 'https://sub2api.example.com/api/v1',
      adminKey,
      timeoutMs: 5_000,
    });
    const result = await connector.refresh('today');

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.adminKey === adminKey));
    assert.ok(calls.every((call) => call.authorization === undefined));
    assert.ok(calls.every((call) => !call.url.href.includes(adminKey)));

    const snapshotCall = calls.find((call) => call.url.pathname.endsWith('/snapshot-v2'));
    assert.equal(snapshotCall.url.searchParams.get('include_stats'), 'true');
    assert.equal(snapshotCall.url.searchParams.get('include_model_stats'), 'true');
    const recentCall = calls.find((call) => call.url.pathname.endsWith('/usage'));
    assert.equal(recentCall.url.searchParams.get('page_size'), '5');

    assert.deepEqual(result.summary, {
      tokens: 150,
      cost: 0.03,
      requests: 2,
      avgLatencyMs: 250,
      rpm: 3,
      tpm: 400,
      successRate: 100,
      activeKeys: 4,
    });
    assert.deepEqual(result.lifetime, { tokens: 1_500, cost: 0.3, requests: 20 });
    assert.deepEqual(result.models, [{ model: 'gpt-5.5', tokens: 150, cost: 0.03, requests: 2 }]);
    assert.equal(result.recent[0].service, 'OpenAI primary');
    assert.equal(result.recent[0].keyId, 'mobile');
    assert.equal(result.recent[0].tokens, 150);
    assert.equal(result.recent[0].stream, true);
    assert.equal(JSON.stringify(result).includes(adminKey), false);
  });

  it('uses a Bearer token for user-scoped endpoints', async (t) => {
    const token = 'user-jwt-private-token';
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      calls.push({ url, headers: options.headers });
      if (url.pathname === '/api/v1/usage/dashboard/snapshot-v2') {
        return jsonResponse(envelope({
          generated_at: '2026-07-12T08:00:00.000Z',
          trend: [],
          models: [],
        }));
      }
      if (url.pathname === '/api/v1/usage/dashboard/stats') {
        return jsonResponse(envelope({
          today_requests: 4,
          today_tokens: 420,
          today_actual_cost: 0.042,
          total_requests: 40,
          total_tokens: 4_200,
          total_actual_cost: 0.42,
          average_duration_ms: 321,
          rpm: 2,
          tpm: 210,
          active_api_keys: 3,
        }));
      }
      if (url.pathname === '/api/v1/usage') {
        return jsonResponse(envelope({ items: [], total: 0, page: 1, page_size: 5, pages: 1 }));
      }
      throw new Error(`Unexpected user-scoped URL: ${url}`);
    };

    const connector = createSub2ApiConnector({
      scope: 'user',
      baseUrl: 'https://sub2api.example.com',
      token: `Bearer ${token}`,
      timeoutMs: 5_000,
    });
    const result = await connector.refresh('today');

    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers.Authorization === `Bearer ${token}`));
    assert.ok(calls.every((call) => call.headers['x-api-key'] === undefined));
    assert.ok(calls.every((call) => !call.url.href.includes(token)));
    assert.equal(result.summary.tokens, 420);
    assert.equal(result.summary.requests, 4);
    assert.equal(result.summary.cost, 0.042);
    assert.deepEqual(result.lifetime, { tokens: 4_200, cost: 0.42, requests: 40 });
  });
});
