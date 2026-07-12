import { createCcSwitchConnector } from './cc-switch.mjs';
import { createSub2ApiConnector } from './sub2api.mjs';

export async function createConnectorManager(options = {}) {
  const connectors = [];
  const sub2Configured = options.sub2api?.enabled !== false && (options.sub2api?.baseUrl
    || options.sub2api?.adminKey
    || options.sub2api?.token);
  if (sub2Configured) connectors.push(createSub2ApiConnector(options.sub2api));

  const ccSwitch = options.ccSwitch?.enabled === false
    ? null
    : await createCcSwitchConnector(options.ccSwitch ?? {});
  if (ccSwitch) connectors.push(ccSwitch);

  const states = new Map(connectors.map((connector) => [connector.id, new Map()]));
  const cacheMs = options.cacheMs ?? 10_000;

  function stateFor(connector, range) {
    const rangeStates = states.get(connector.id);
    if (!rangeStates.has(range)) {
      rangeStates.set(range, {
        data: null,
        lastAttemptAt: 0,
        lastSyncAt: null,
        inFlight: null,
        status: 'degraded',
        message: 'Waiting for first sync',
      });
    }
    return rangeStates.get(range);
  }

  async function refresh(connector, range) {
    const state = stateFor(connector, range);
    const now = Date.now();
    if (state.inFlight) return state.inFlight;
    if (state.lastAttemptAt && now - state.lastAttemptAt < cacheMs) return state;

    state.lastAttemptAt = now;
    state.inFlight = (async () => {
      try {
        const data = await connector.refresh(range);
        state.data = data;
        state.lastSyncAt = new Date().toISOString();
        state.status = data.degraded ? 'degraded' : 'ok';
        state.message = data.degraded
          ? data.message || 'Partial connector data is unavailable'
          : '';
      } catch {
        state.status = 'degraded';
        state.message = `${connector.name} is unavailable`;
      } finally {
        state.inFlight = null;
      }
      return state;
    })();
    return state.inFlight;
  }

  return {
    async snapshot(range = 'today') {
      await Promise.all(connectors.map((connector) => refresh(connector, range)));
      return {
        snapshots: connectors.flatMap((connector) => {
          const state = stateFor(connector, range);
          return state.data ? [{ sourceId: connector.id, ...state.data }] : [];
        }),
        sources: connectors.map((connector) => {
          const state = stateFor(connector, range);
          return {
            id: connector.id,
            name: connector.name,
            type: connector.type,
            status: state.status,
            message: state.message,
            lastSyncAt: state.lastSyncAt,
          };
        }),
      };
    },
  };
}
