import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { validateConnectorBaseUrl } from './connectors/common.mjs';

const SETTINGS_VERSION = 1;
const MAX_URL_LENGTH = 2_048;
const MAX_PATH_LENGTH = 4_096;
const MAX_SECRET_LENGTH = 8_192;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value, fallback = '', maximum = 256) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maximum);
}

function secret(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (normalized.length > MAX_SECRET_LENGTH) throw new Error('Credential is too long');
  return normalized;
}

function scope(value, fallback = 'admin') {
  return value === 'user' || value === 'admin' ? value : fallback;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizedSettings(value, defaults) {
  const root = object(value);
  const defaultSub2Api = object(defaults.sub2api);
  const defaultCcSwitch = object(defaults.ccSwitch);
  const sub2api = object(root.sub2api);
  const ccSwitch = object(root.ccSwitch);
  return {
    version: SETTINGS_VERSION,
    updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : null,
    sub2api: {
      enabled: boolean(sub2api.enabled, boolean(defaultSub2Api.enabled, false)),
      baseUrl: text(sub2api.baseUrl, text(defaultSub2Api.baseUrl, '', MAX_URL_LENGTH), MAX_URL_LENGTH),
      scope: scope(sub2api.scope, scope(defaultSub2Api.scope)),
      adminKey: secret(sub2api.adminKey, secret(defaultSub2Api.adminKey)),
      token: secret(sub2api.token, secret(defaultSub2Api.token)),
      timezone: text(sub2api.timezone, text(defaultSub2Api.timezone, 'Asia/Hong_Kong', 80), 80),
    },
    ccSwitch: {
      enabled: boolean(ccSwitch.enabled, boolean(defaultCcSwitch.enabled, true)),
      dbPath: text(ccSwitch.dbPath, text(defaultCcSwitch.dbPath, '', MAX_PATH_LENGTH), MAX_PATH_LENGTH),
    },
  };
}

export class RuntimeSettingsStore {
  #filePath;
  #defaults;
  #settings;
  #queue = Promise.resolve();

  constructor(filePath, defaults = {}) {
    this.#filePath = filePath;
    this.#defaults = normalizedSettings({}, defaults);
    this.#settings = this.#defaults;
  }

  async init() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.#filePath, 'utf8'));
      this.#settings = normalizedSettings(saved, this.#defaults);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Runtime settings file is invalid');
    }
  }

  publicView() {
    const { sub2api, ccSwitch, updatedAt } = this.#settings;
    return {
      updatedAt,
      sub2api: {
        enabled: sub2api.enabled,
        baseUrl: sub2api.baseUrl,
        scope: sub2api.scope,
        timezone: sub2api.timezone,
        hasAdminKey: Boolean(sub2api.adminKey),
        hasToken: Boolean(sub2api.token),
      },
      ccSwitch: {
        enabled: ccSwitch.enabled,
        dbPath: ccSwitch.dbPath,
      },
    };
  }

  connectorOptions(options = {}) {
    const { sub2api, ccSwitch } = this.#settings;
    return {
      cacheMs: options.cacheMs,
      sub2api: {
        enabled: sub2api.enabled,
        baseUrl: sub2api.baseUrl,
        adminKey: sub2api.adminKey,
        token: sub2api.token,
        scope: sub2api.scope,
        timezone: sub2api.timezone,
        timeoutMs: options.timeoutMs,
      },
      ccSwitch: {
        enabled: ccSwitch.enabled,
        dbPath: ccSwitch.dbPath,
      },
    };
  }

  async update(input) {
    const operation = this.#queue.then(() => this.#applyUpdate(input));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #applyUpdate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Settings must be a JSON object');
    }
    const root = object(input);
    if (Object.keys(root).some((key) => !['sub2api', 'ccSwitch'].includes(key))) {
      throw new Error('Settings contain unsupported fields');
    }

    const current = this.#settings;
    const submittedSub2Api = object(root.sub2api);
    const submittedCcSwitch = object(root.ccSwitch);
    const sub2api = {
      ...current.sub2api,
      enabled: boolean(submittedSub2Api.enabled, current.sub2api.enabled),
      baseUrl: text(submittedSub2Api.baseUrl, current.sub2api.baseUrl, MAX_URL_LENGTH),
      scope: scope(submittedSub2Api.scope, current.sub2api.scope),
      timezone: text(submittedSub2Api.timezone, current.sub2api.timezone, 80),
    };
    if (submittedSub2Api.clearAdminKey === true) sub2api.adminKey = '';
    else if (typeof submittedSub2Api.adminKey === 'string' && submittedSub2Api.adminKey.trim()) {
      sub2api.adminKey = secret(submittedSub2Api.adminKey);
    }
    if (submittedSub2Api.clearToken === true) sub2api.token = '';
    else if (typeof submittedSub2Api.token === 'string' && submittedSub2Api.token.trim()) {
      sub2api.token = secret(submittedSub2Api.token);
    }

    const ccSwitch = {
      ...current.ccSwitch,
      enabled: boolean(submittedCcSwitch.enabled, current.ccSwitch.enabled),
      dbPath: text(submittedCcSwitch.dbPath, current.ccSwitch.dbPath, MAX_PATH_LENGTH),
    };

    if (sub2api.enabled) {
      if (!sub2api.baseUrl) throw new Error('Sub2API base URL is required');
      const credential = sub2api.scope === 'user' ? sub2api.token : sub2api.adminKey;
      if (!credential) throw new Error('Sub2API credential is required');
      const validated = await validateConnectorBaseUrl(sub2api.baseUrl);
      sub2api.baseUrl = validated.href.replace(/\/$/, '');
      if (!validTimeZone(sub2api.timezone)) throw new Error('Sub2API timezone is invalid');
    }

    const nextSettings = {
      version: SETTINGS_VERSION,
      updatedAt: new Date().toISOString(),
      sub2api,
      ccSwitch,
    };
    await writeFile(this.#filePath, `${JSON.stringify(nextSettings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.#settings = nextSettings;
    return this.publicView();
  }
}
