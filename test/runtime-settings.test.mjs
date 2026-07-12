import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';

describe('RuntimeSettingsStore', () => {
  it('masks credentials, persists updates, and preserves blank secret fields', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-settings-'));
    const filePath = join(directory, 'settings.json');
    t.after(() => rm(directory, { recursive: true, force: true }));

    const store = new RuntimeSettingsStore(filePath, {
      sub2api: {
        enabled: true,
        baseUrl: 'https://sub2api.example.com',
        scope: 'admin',
        adminKey: 'environment-admin-secret',
        timezone: 'Asia/Hong_Kong',
      },
      ccSwitch: { enabled: true, dbPath: '' },
    });
    await store.init();

    const initial = store.publicView();
    assert.equal(initial.sub2api.hasAdminKey, true);
    assert.equal(initial.sub2api.adminKey, undefined);
    assert.equal(JSON.stringify(initial).includes('environment-admin-secret'), false);

    const saved = await store.update({
      sub2api: {
        enabled: true,
        baseUrl: 'https://new-sub2api.example.com/',
        scope: 'admin',
        adminKey: '',
        timezone: 'Asia/Shanghai',
      },
      ccSwitch: { enabled: false, dbPath: 'C:\\monitor\\cc-switch.db' },
    });
    assert.equal(saved.sub2api.baseUrl, 'https://new-sub2api.example.com');
    assert.equal(saved.sub2api.hasAdminKey, true);
    assert.equal(saved.ccSwitch.enabled, false);

    const options = store.connectorOptions({ cacheMs: 2_000, timeoutMs: 3_000 });
    assert.equal(options.sub2api.adminKey, 'environment-admin-secret');
    assert.equal(options.sub2api.timeoutMs, 3_000);
    assert.equal(options.ccSwitch.dbPath, 'C:\\monitor\\cc-switch.db');

    const persisted = await readFile(filePath, 'utf8');
    assert.equal(persisted.includes('environment-admin-secret'), true);
    assert.equal(persisted.includes('"version": 1'), true);
  });

  it('validates enabled Sub2API credentials and supports explicit clearing', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-monitor-settings-validation-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new RuntimeSettingsStore(join(directory, 'settings.json'), {
      sub2api: { enabled: false, timezone: 'Asia/Hong_Kong' },
      ccSwitch: { enabled: true },
    });
    await store.init();

    await assert.rejects(
      store.update({ sub2api: { enabled: true, baseUrl: 'https://sub2api.example.com', scope: 'user' } }),
      /credential/i,
    );
    const configured = await store.update({
      sub2api: {
        enabled: true,
        baseUrl: 'https://sub2api.example.com',
        scope: 'user',
        token: 'user-jwt-secret',
        timezone: 'UTC',
      },
    });
    assert.equal(configured.sub2api.hasToken, true);

    await assert.rejects(
      store.update({ sub2api: { clearToken: true } }),
      /credential/i,
    );
    assert.equal(store.connectorOptions().sub2api.token, 'user-jwt-secret');
    await assert.rejects(store.update([]), /JSON object/i);
  });
});
