(() => {
  "use strict";

  const RANGE_LABELS = {
    today: "今日",
    "24h": "24 小时",
    "7d": "7 天"
  };
  const VALID_RANGES = new Set(Object.keys(RANGE_LABELS));
  const VALID_SOURCES = new Set(["auto", "local", "sub2api", "cc-switch", "all"]);
  const VALID_CHART_WINDOWS = new Set(["6h", "12h", "24h", "all"]);
  const POLL_INTERVAL_MS = 30000;
  const BACKEND_REQUEST_TIMEOUT_MS = 8000;
  const BACKEND_RESTART_RETRY_MS = 1500;
  const BACKEND_RESTART_MAX_ATTEMPTS = 12;
  const STALE_AFTER_MS = 90000;
  const MAX_RECENT_ROWS = 50;
  const MAX_MODEL_ROWS = 12;
  const PRECISE_NUMBERS_STORAGE_KEY = "api-monitor.precise-numbers";
  const CHART_WINDOW_STORAGE_KEY = "api-monitor.chart-window";

  const dom = {
    body: document.body,
    main: document.querySelector("main"),
    refresh: document.querySelector("#refresh-button"),
    install: document.querySelector("#install-button"),
    settingsButton: document.querySelector("#settings-button"),
    settingsDialog: document.querySelector("#settings-dialog"),
    settingsForm: document.querySelector("#settings-form"),
    settingsClose: document.querySelector("#settings-close"),
    settingsCancel: document.querySelector("#settings-cancel"),
    settingsSave: document.querySelector("#settings-save"),
    settingsStatus: document.querySelector("#settings-status"),
    sub2apiEnabled: document.querySelector("#sub2api-enabled"),
    sub2apiFields: document.querySelector("#sub2api-fields"),
    sub2apiConfigState: document.querySelector("#sub2api-config-state"),
    sub2apiBaseUrl: document.querySelector("#sub2api-base-url"),
    sub2apiAdminKey: document.querySelector("#sub2api-admin-key"),
    sub2apiToken: document.querySelector("#sub2api-token"),
    sub2apiTimezone: document.querySelector("#sub2api-timezone"),
    adminCredentialFields: document.querySelector("#admin-credential-fields"),
    userCredentialFields: document.querySelector("#user-credential-fields"),
    adminKeyState: document.querySelector("#admin-key-state"),
    userTokenState: document.querySelector("#user-token-state"),
    clearAdminRow: document.querySelector("#clear-admin-row"),
    clearAdminKey: document.querySelector("#clear-admin-key"),
    clearTokenRow: document.querySelector("#clear-token-row"),
    clearToken: document.querySelector("#clear-token"),
    ccSwitchEnabled: document.querySelector("#cc-switch-enabled"),
    ccSwitchFields: document.querySelector("#cc-switch-fields"),
    ccSwitchConfigState: document.querySelector("#cc-switch-config-state"),
    ccSwitchDbPath: document.querySelector("#cc-switch-db-path"),
    retry: document.querySelector("#retry-button"),
    statePanel: document.querySelector("#state-panel"),
    stateIcon: document.querySelector("#state-icon"),
    stateTitle: document.querySelector("#state-title"),
    stateMessage: document.querySelector("#state-message"),
    connection: document.querySelector("#connection-status"),
    connectionLabel: document.querySelector("#connection-label"),
    updatedAt: document.querySelector("#updated-at"),
    footerStatus: document.querySelector("#footer-status"),
    backendState: document.querySelector("#backend-state"),
    backendDetail: document.querySelector("#backend-detail"),
    backendMenu: document.querySelector("#backend-menu"),
    backendDialog: document.querySelector("#backend-dialog"),
    backendForm: document.querySelector("#backend-form"),
    backendClose: document.querySelector("#backend-close"),
    backendDialogState: document.querySelector("#backend-dialog-state"),
    backendDialogDot: document.querySelector("#backend-dialog-dot"),
    backendDialogTitle: document.querySelector("#backend-runtime-title"),
    backendDialogSummary: document.querySelector("#backend-dialog-summary"),
    backendAddress: document.querySelector("#backend-address"),
    backendUptime: document.querySelector("#backend-uptime"),
    backendStartedAt: document.querySelector("#backend-started-at"),
    backendProcessId: document.querySelector("#backend-process-id"),
    backendInstanceId: document.querySelector("#backend-instance-id"),
    backendRestart: document.querySelector("#backend-restart"),
    backendStop: document.querySelector("#backend-stop"),
    backendStatus: document.querySelector("#backend-status"),
    autostartEnabled: document.querySelector("#autostart-enabled"),
    autostartDetail: document.querySelector("#autostart-detail"),
    autostartModeField: document.querySelector("#autostart-mode-field"),
    sourceSelect: document.querySelector("#source-select"),
    sourceStrip: document.querySelector("#source-strip"),
    toast: document.querySelector("#toast"),
    tokenRangeLabel: document.querySelector("#token-range-label"),
    costRangeLabel: document.querySelector("#cost-range-label"),
    requestsNote: document.querySelector("#requests-note"),
    recentSubtitle: document.querySelector("#recent-subtitle"),
    trendSubtitle: document.querySelector("#trend-subtitle"),
    token: document.querySelector("#token-value"),
    cost: document.querySelector("#cost-value"),
    requests: document.querySelector("#requests-value"),
    latency: document.querySelector("#latency-value"),
    rpm: document.querySelector("#rpm-value"),
    tpm: document.querySelector("#tpm-value"),
    success: document.querySelector("#success-value"),
    successNote: document.querySelector("#success-note"),
    services: document.querySelector("#services-value"),
    servicesNote: document.querySelector("#services-note"),
    keys: document.querySelector("#keys-value"),
    recentList: document.querySelector("#recent-list"),
    recentCount: document.querySelector("#recent-count"),
    modelsList: document.querySelector("#models-list"),
    modelsCount: document.querySelector("#models-count"),
    lifetimeTokens: document.querySelector("#lifetime-tokens"),
    lifetimeRequests: document.querySelector("#lifetime-requests"),
    lifetimeCost: document.querySelector("#lifetime-cost"),
    canvas: document.querySelector("#trend-canvas"),
    chartDetail: document.querySelector("#chart-detail"),
    chartPeak: document.querySelector("#chart-peak"),
    chartTotal: document.querySelector("#chart-total")
  };

  const initialRange = new URLSearchParams(window.location.search).get("range");
  const initialSource = new URLSearchParams(window.location.search).get("source");
  const initialChartWindow = (() => {
    try {
      const value = window.localStorage.getItem(CHART_WINDOW_STORAGE_KEY);
      return VALID_CHART_WINDOWS.has(value) ? value : "all";
    } catch {
      return "all";
    }
  })();
  const initialPreciseNumbers = (() => {
    try {
      return window.localStorage.getItem(PRECISE_NUMBERS_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  })();
  const state = {
    range: VALID_RANGES.has(initialRange) ? initialRange : "today",
    source: VALID_SOURCES.has(initialSource) ? initialSource : "auto",
    chartMode: "tokens",
    chartWindow: initialChartWindow,
    chartSelectedIndex: -1,
    chartSelectedTime: "",
    chartLayout: null,
    backend: null,
    backendBusy: false,
    backendFetchId: 0,
    backendRestartTimer: null,
    autostart: null,
    autostartBusy: false,
    autostartFetchId: 0,
    data: null,
    fetchId: 0,
    controller: null,
    eventSource: null,
    sseConnected: false,
    lastSuccessAt: 0,
    installPrompt: null,
    streamRefreshTimer: null,
    toastTimer: null,
    settings: null,
    settingsBusy: false,
    preciseNumbers: initialPreciseNumbers
  };

  function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function asText(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function normalizeDashboard(payload) {
    const root = payload && typeof payload === "object" ? payload : {};
    const summary = root.summary && typeof root.summary === "object" ? root.summary : {};
    const lifetime = root.lifetime && typeof root.lifetime === "object" ? root.lifetime : {};

    return {
      generatedAt: asText(root.generatedAt),
      activeSource: asText(root.activeSource, "local"),
      sources: Array.isArray(root.sources) ? root.sources.filter(Boolean) : [],
      summary: {
        tokens: asNumber(summary.tokens),
        cost: asNumber(summary.cost),
        requests: asNumber(summary.requests),
        avgLatencyMs: asNumber(summary.avgLatencyMs),
        rpm: asNumber(summary.rpm),
        tpm: asNumber(summary.tpm),
        successRate: asNumber(summary.successRate),
        servicesHealthy: asNumber(summary.servicesHealthy),
        servicesTotal: asNumber(summary.servicesTotal),
        activeKeys: asNumber(summary.activeKeys)
      },
      recent: Array.isArray(root.recent) ? root.recent.filter(Boolean).map((item) => ({
        ...item,
        project: item.project ?? item.service,
        totalTokens: item.totalTokens ?? item.tokens,
        keyLabel: item.keyLabel ?? item.keyId,
        timestamp: item.timestamp ?? item.time
      })) : [],
      models: Array.isArray(root.models) ? root.models.filter(Boolean) : [],
      timeline: Array.isArray(root.timeline) ? root.timeline.filter(Boolean).map((item) => ({
        ...item,
        time: item.time ?? item.label ?? item.timestamp
      })) : [],
      lifetime: {
        tokens: asNumber(lifetime.tokens),
        cost: asNumber(lifetime.cost),
        requests: asNumber(lifetime.requests)
      }
    };
  }

  function normalizeBackend(payload) {
    const root = payload && typeof payload === "object" ? payload : {};
    const control = root.control && typeof root.control === "object" ? root.control : {};
    const actions = Array.isArray(control.availableActions)
      ? control.availableActions.filter((action) => action === "restart" || action === "stop")
      : [];
    return {
      status: ["stopping", "stopped"].includes(root.status) ? root.status : "running",
      instanceId: asText(root.instanceId),
      processId: asText(root.processId ?? root.pid),
      bindHost: asText(root.bindHost),
      port: asNumber(root.port),
      startedAt: asText(root.startedAt),
      uptimeSeconds: asNumber(root.uptimeSeconds) ?? 0,
      control: {
        enabled: Boolean(control.enabled),
        availableActions: actions,
        startSupported: Boolean(control.startSupported)
      }
    };
  }

  function normalizeAutostart(payload) {
    const root = payload && typeof payload === "object" ? payload : {};
    const mode = asText(root.mode) === "cc-switch" ? "cc-switch" : "always";
    return {
      supported: Boolean(root.supported ?? Object.hasOwn(root, "enabled")),
      enabled: Boolean(root.enabled),
      mode,
      detail: asText(root.detail ?? root.message),
      availableModes: Array.isArray(root.availableModes)
        ? root.availableModes
          .map((item) => typeof item === "string" ? item : asText(item?.id))
          .filter(Boolean)
        : []
    };
  }

  function formatCompact(value, maximumFractionDigits = 1) {
    if (value === null || !Number.isFinite(value)) return "--";
    const absolute = Math.abs(value);
    const units = [
      { at: 1e12, suffix: "T" },
      { at: 1e9, suffix: "B" },
      { at: 1e6, suffix: "M" },
      { at: 1e3, suffix: "K" }
    ];
    const unit = units.find((entry) => absolute >= entry.at);
    if (unit) {
      return `${new Intl.NumberFormat("zh-CN", {
        maximumFractionDigits,
        minimumFractionDigits: 0
      }).format(value / unit.at)}${unit.suffix}`;
    }
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
  }

  function formatExact(value, maximumFractionDigits = 2) {
    if (value === null || !Number.isFinite(value)) return "--";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
  }

  function formatQuantity(value, maximumFractionDigits = 1) {
    return state.preciseNumbers
      ? formatExact(value, maximumFractionDigits)
      : formatCompact(value, maximumFractionDigits);
  }

  function formatInteger(value) {
    if (value === null || !Number.isFinite(value)) return "--";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
  }

  function formatMoney(value, compact = false) {
    if (value === null || !Number.isFinite(value)) return "--";
    if (compact && Math.abs(value) >= 1000) return `$${formatCompact(value, 2)}`;
    const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
  }

  function formatLatency(value) {
    if (value === null || !Number.isFinite(value)) return "--";
    if (state.preciseNumbers) return `${formatExact(value, 2)}ms`;
    if (value >= 1000) return `${formatCompact(value / 1000, 1)}s`;
    return `${formatInteger(value)}ms`;
  }

  function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(asNumber(seconds) ?? 0));
    if (total < 60) return "刚刚启动";
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `运行 ${days} 天 ${hours} 小时`;
    if (hours > 0) return `运行 ${hours} 小时 ${minutes} 分钟`;
    return `运行 ${minutes} 分钟`;
  }

  function normalizeRate(value) {
    if (value === null || !Number.isFinite(value)) return null;
    return value >= 0 && value <= 1 ? value * 100 : value;
  }

  function formatRate(value) {
    const rate = normalizeRate(value);
    if (rate === null) return "--";
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(rate)}%`;
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatUpdatedAt(value) {
    const date = parseDate(value);
    if (!date) return "已同步";
    return `更新 ${new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date)}`;
  }

  function formatCallTime(value) {
    const date = parseDate(value);
    if (!date) return "时间未知";
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
    return new Intl.DateTimeFormat("zh-CN", sameDay ? {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    } : {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function setMetric(element, text) {
    element.textContent = text;
    element.classList.toggle("fit-sm", text.length >= 9);
    element.classList.toggle("fit-xs", text.length >= 13);
  }

  function syncValueToggleAccessibility() {
    const label = state.preciseNumbers ? "点击切换为紧凑数值" : "点击切换为精确数值";
    document.querySelectorAll("[data-value]").forEach((item) => {
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.setAttribute("aria-pressed", String(state.preciseNumbers));
      item.setAttribute("aria-label", `${item.textContent || "数据"}，${label}`);
      item.title = label;
    });
  }

  function togglePreciseNumbers() {
    state.preciseNumbers = !state.preciseNumbers;
    try {
      window.localStorage.setItem(PRECISE_NUMBERS_STORAGE_KEY, String(state.preciseNumbers));
    } catch {
      // The current page stays usable when private browsing blocks persistent storage.
    }
    if (state.data) renderDashboard(state.data);
    syncValueToggleAccessibility();
    showToast(state.preciseNumbers ? "已显示精确数值" : "已显示紧凑数值");
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showState(tone, icon, title, message, retry = false) {
    dom.statePanel.hidden = false;
    dom.statePanel.dataset.tone = tone;
    dom.stateIcon.textContent = icon;
    dom.stateTitle.textContent = title;
    dom.stateMessage.textContent = message;
    dom.retry.hidden = !retry;
  }

  function hideState() {
    dom.statePanel.hidden = true;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      dom.toast.hidden = true;
    }, 2800);
  }

  function setConnection(kind, label) {
    dom.connection.dataset.state = kind;
    dom.connectionLabel.textContent = label;
    dom.footerStatus.textContent = label;
  }

  function setFetching(fetching) {
    dom.refresh.disabled = fetching;
    dom.refresh.classList.toggle("is-spinning", fetching);
    dom.refresh.setAttribute("aria-label", fetching ? "正在刷新数据" : "刷新数据");
    dom.main.setAttribute("aria-busy", String(fetching));
  }

  function selectedSub2ApiScope() {
    return dom.settingsForm.querySelector('input[name="sub2apiScope"]:checked')?.value === "user"
      ? "user"
      : "admin";
  }

  function showSettingsStatus(message, tone = "") {
    dom.settingsStatus.textContent = message;
    dom.settingsStatus.dataset.tone = tone;
    dom.settingsStatus.hidden = !message;
  }

  function setSettingsBusy(busy, label = "保存并应用") {
    state.settingsBusy = busy;
    dom.settingsForm.setAttribute("aria-busy", String(busy));
    dom.settingsSave.disabled = busy;
    dom.settingsCancel.disabled = busy;
    dom.settingsSave.textContent = busy ? label : "保存并应用";
  }

  function syncSettingsVisibility() {
    const enabled = dom.sub2apiEnabled.checked;
    const scope = selectedSub2ApiScope();
    const hasAdminKey = Boolean(state.settings?.sub2api?.hasAdminKey);
    const hasToken = Boolean(state.settings?.sub2api?.hasToken);
    dom.sub2apiFields.hidden = !enabled;
    dom.adminCredentialFields.hidden = scope !== "admin";
    dom.userCredentialFields.hidden = scope !== "user";
    dom.sub2apiBaseUrl.required = enabled;
    dom.sub2apiTimezone.required = enabled;
    dom.sub2apiAdminKey.disabled = dom.clearAdminKey.checked;
    dom.sub2apiToken.disabled = dom.clearToken.checked;
    dom.clearAdminRow.hidden = !hasAdminKey;
    dom.clearTokenRow.hidden = !hasToken;
    dom.adminKeyState.textContent = hasAdminKey ? "已保存；留空保持不变" : "未配置";
    dom.userTokenState.textContent = hasToken ? "已保存；留空保持不变" : "未配置";
    dom.sub2apiConfigState.textContent = enabled
      ? (scope === "admin" ? "管理员模式" : "用户模式")
      : "未启用";

    dom.ccSwitchFields.hidden = !dom.ccSwitchEnabled.checked;
    dom.ccSwitchConfigState.textContent = dom.ccSwitchEnabled.checked
      ? (dom.ccSwitchDbPath.value.trim() ? "自定义路径" : "自动检测")
      : "未启用";
  }

  function applySettings(settings) {
    state.settings = settings;
    const sub2api = settings?.sub2api ?? {};
    const ccSwitch = settings?.ccSwitch ?? {};
    dom.sub2apiEnabled.checked = Boolean(sub2api.enabled);
    dom.sub2apiBaseUrl.value = asText(sub2api.baseUrl);
    dom.sub2apiAdminKey.value = "";
    dom.sub2apiToken.value = "";
    dom.sub2apiTimezone.value = asText(sub2api.timezone, "Asia/Hong_Kong");
    const scopeInput = dom.settingsForm.querySelector(`input[name="sub2apiScope"][value="${sub2api.scope === "user" ? "user" : "admin"}"]`);
    if (scopeInput) scopeInput.checked = true;
    dom.clearAdminKey.checked = false;
    dom.clearToken.checked = false;
    dom.ccSwitchEnabled.checked = ccSwitch.enabled !== false;
    dom.ccSwitchDbPath.value = asText(ccSwitch.dbPath);
    syncSettingsVisibility();
  }

  async function settingsRequestError(response) {
    if (response.status === 403) return new Error("远程修改设置前，请先在服务端配置 DASHBOARD_PASSWORD");
    if (response.status === 401) return new Error("当前登录信息无权修改设置");
    if (response.status === 400) return new Error("配置无效，请检查地址、凭据和时区");
    return new Error(`设置请求失败（HTTP ${response.status}）`);
  }

  async function loadSettings() {
    setSettingsBusy(true, "读取中…");
    showSettingsStatus("正在读取本机配置");
    try {
      const response = await fetch("/api/settings", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw await settingsRequestError(response);
      applySettings(await response.json());
      showSettingsStatus("");
    } catch (error) {
      showSettingsStatus(error instanceof Error ? error.message : "无法读取设置", "error");
    } finally {
      setSettingsBusy(false);
    }
  }

  function openSettings() {
    if (!dom.settingsDialog.open) dom.settingsDialog.showModal();
    void loadSettings();
  }

  function closeSettings() {
    if (state.settingsBusy) return;
    if (dom.settingsDialog.open) dom.settingsDialog.close();
    showSettingsStatus("");
  }

  function credentialAvailable(scope) {
    if (scope === "user") {
      return Boolean(dom.sub2apiToken.value.trim())
        || (Boolean(state.settings?.sub2api?.hasToken) && !dom.clearToken.checked);
    }
    return Boolean(dom.sub2apiAdminKey.value.trim())
      || (Boolean(state.settings?.sub2api?.hasAdminKey) && !dom.clearAdminKey.checked);
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.settingsBusy) return;
    syncSettingsVisibility();
    if (!dom.settingsForm.reportValidity()) return;
    const scope = selectedSub2ApiScope();
    if (dom.sub2apiEnabled.checked && !credentialAvailable(scope)) {
      showSettingsStatus(scope === "user" ? "请填写用户 JWT" : "请填写管理员 Key", "error");
      (scope === "user" ? dom.sub2apiToken : dom.sub2apiAdminKey).focus();
      return;
    }

    const payload = {
      sub2api: {
        enabled: dom.sub2apiEnabled.checked,
        baseUrl: dom.sub2apiBaseUrl.value.trim(),
        scope,
        adminKey: dom.sub2apiAdminKey.value.trim(),
        token: dom.sub2apiToken.value.trim(),
        clearAdminKey: dom.clearAdminKey.checked,
        clearToken: dom.clearToken.checked,
        timezone: dom.sub2apiTimezone.value.trim()
      },
      ccSwitch: {
        enabled: dom.ccSwitchEnabled.checked,
        dbPath: dom.ccSwitchDbPath.value.trim()
      }
    };

    setSettingsBusy(true, "保存中…");
    showSettingsStatus("正在保存并连接数据源");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw await settingsRequestError(response);
      applySettings(await response.json());
      showSettingsStatus("设置已应用", "success");
      connectStream();
      await fetchDashboard();
      showToast("数据源设置已保存");
      dom.settingsDialog.close();
    } catch (error) {
      showSettingsStatus(error instanceof Error ? error.message : "无法保存设置", "error");
    } finally {
      setSettingsBusy(false);
    }
  }

  function applyRangeLabels() {
    const label = RANGE_LABELS[state.range];
    dom.tokenRangeLabel.textContent = `${label} Token`;
    dom.costRangeLabel.textContent = `${label}成本`;
    dom.requestsNote.textContent = label;
    dom.recentSubtitle.textContent = `${label}最新记录`;
    dom.trendSubtitle.textContent = label;
    document.querySelectorAll("[data-range]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
    });
  }

  function hasNoActivity(data) {
    const values = [
      data.summary.tokens,
      data.summary.requests,
      data.lifetime.tokens,
      data.lifetime.requests
    ].filter((value) => value !== null);
    return (values.length === 0 || values.every((value) => value === 0))
      && data.recent.length === 0
      && data.models.length === 0
      && data.timeline.length === 0;
  }

  function renderSummary(summary) {
    setMetric(dom.token, formatQuantity(summary.tokens, 1));
    setMetric(dom.cost, formatMoney(summary.cost));
    setMetric(dom.requests, formatQuantity(summary.requests, 1));
    setMetric(dom.latency, formatLatency(summary.avgLatencyMs));
    setMetric(dom.rpm, formatQuantity(summary.rpm, 1));
    setMetric(dom.tpm, formatQuantity(summary.tpm, 1));
    setMetric(dom.success, formatRate(summary.successRate));
    setMetric(dom.keys, formatQuantity(summary.activeKeys, 1));

    const rate = normalizeRate(summary.successRate);
    dom.successNote.textContent = rate === null
      ? "暂无数据"
      : rate >= 99 ? "运行稳定" : rate >= 95 ? "需要关注" : "异常偏高";

    if (summary.servicesHealthy === null && summary.servicesTotal === null) {
      setMetric(dom.services, "--");
      dom.servicesNote.textContent = "暂无数据";
    } else {
      const healthy = summary.servicesHealthy ?? 0;
      const total = summary.servicesTotal ?? 0;
      setMetric(dom.services, `${formatInteger(healthy)}/${formatInteger(total)}`);
      dom.servicesNote.textContent = total > 0 && healthy >= total
        ? "全部正常"
        : `${formatInteger(Math.max(0, total - healthy))} 个异常`;
    }
  }

  function statusClass(status) {
    const normalized = asText(status).toLowerCase();
    if (["ok", "success", "succeeded", "completed", "200"].includes(normalized)) return "success";
    if (["pending", "running", "streaming", "processing"].includes(normalized)) return "pending";
    if (["error", "failed", "failure", "timeout"].includes(normalized) || /^4\d\d$|^5\d\d$/.test(normalized)) return "failed";
    return "unknown";
  }

  function statusLabel(status) {
    const kind = statusClass(status);
    if (kind === "success") return "成功";
    if (kind === "failed") return "失败";
    if (kind === "pending") return "处理中";
    return asText(status, "状态未知");
  }

  function sourceLabel(source) {
    const raw = source && typeof source === "object"
      ? `${asText(source.id)} ${asText(source.name)} ${asText(source.type)}`
      : asText(source);
    const normalized = raw.toLowerCase();
    if (normalized.includes("sub2api")) return "Sub2API";
    if (normalized.includes("cc-switch") || normalized.includes("ccswitch")) return "cc-switch";
    if (normalized.includes("local") || normalized.includes("proxy") || raw.includes("本机") || raw.includes("代理")) return "本机代理";
    return "数据源";
  }

  function sourceStatus(status) {
    const normalized = asText(status).toLowerCase();
    if (["online", "ok", "healthy", "up", "正常"].includes(normalized)) return "online";
    if (["degraded", "warning", "partial", "unstable", "降级"].includes(normalized)) return "degraded";
    if (["offline", "down", "error", "failed", "异常"].includes(normalized)) return "offline";
    return "unknown";
  }

  function renderSources(sources, activeSource) {
    dom.sourceStrip.replaceChildren();
    const available = new Set(["local", ...sources.map((source) => asText(source?.id))]);
    for (const option of dom.sourceSelect.options) {
      option.disabled = !["auto", "local", "all"].includes(option.value) && !available.has(option.value);
    }
    // An explicit connector can be absent when it is not configured. Keep the
    // visible selection aligned with the local fallback returned by the server.
    if (!["auto", "local", "all"].includes(state.source) && !available.has(state.source)) {
      state.source = available.has(activeSource) ? activeSource : "local";
      const url = new URL(window.location.href);
      url.searchParams.set("source", state.source);
      window.history.replaceState(null, "", url);
    }
    dom.sourceSelect.value = state.source;
    const activeLabel = sourceLabel(activeSource);
    dom.sourceSelect.title = state.source === "auto" ? `当前自动选择：${activeLabel}` : `当前来源：${activeLabel}`;
    if (!sources.length) {
      dom.sourceStrip.hidden = true;
      return;
    }
    sources.slice(0, 6).forEach((source) => {
      const status = sourceStatus(source?.status);
      const pill = element("span", "source-pill");
      pill.dataset.status = status;
      const label = element("span", "", sourceLabel(source));
      const statusText = status === "online" ? "在线" : status === "degraded" ? "降级" : status === "offline" ? "离线" : "未知";
      pill.title = `${sourceLabel(source)} · ${statusText}`;
      pill.append(label, element("span", "source-state", statusText));
      dom.sourceStrip.append(pill);
    });
    dom.sourceStrip.hidden = false;
  }

  function backendAddress(backend) {
    if (!backend) return "--";
    const host = backend.bindHost || "未知地址";
    return backend.port === null ? host : `${host}:${backend.port}`;
  }

  function formatBackendStartedAt(value) {
    const date = parseDate(value);
    if (!date) return "--";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  }

  function setBackendManagementStatus(message, tone = "") {
    dom.backendStatus.textContent = message;
    dom.backendStatus.dataset.tone = tone;
    dom.backendStatus.hidden = !message;
  }

  function syncAutostartControls() {
    const available = state.autostart?.supported === true;
    const enabled = available && state.autostart?.enabled === true;
    const busy = state.autostartBusy;
    dom.autostartEnabled.disabled = !available || busy;
    dom.autostartModeField.disabled = !enabled || busy;
    const ccSwitchAllowed = !state.autostart?.availableModes?.length
      || state.autostart.availableModes.includes("cc-switch");
    const ccSwitch = dom.backendForm.querySelector('input[name="autostartMode"][value="cc-switch"]');
    if (ccSwitch) ccSwitch.disabled = !enabled || busy || !ccSwitchAllowed;
  }

  function renderAutostart(autostart) {
    if (!autostart) {
      dom.autostartEnabled.checked = false;
      dom.autostartDetail.textContent = "暂时无法读取开机自启设置";
      syncAutostartControls();
      return;
    }

    dom.autostartEnabled.checked = autostart.enabled;
    const modeInput = dom.backendForm.querySelector(`input[name="autostartMode"][value="${autostart.mode}"]`);
    if (modeInput) modeInput.checked = true;
    dom.autostartDetail.textContent = autostart.supported
      ? (autostart.detail || (autostart.enabled ? "已启用" : "未启用"))
      : (autostart.detail || "当前系统不支持开机自启管理");
    syncAutostartControls();
  }

  function renderBackendDialog(backend) {
    const stateLabel = backend?.status === "stopped"
      ? "后端服务已关闭"
      : backend?.status === "stopping"
        ? "正在关闭或重启"
        : backend ? "后端服务运行中" : "后端状态不可用";
    const stateKind = backend?.status === "stopped"
      ? "stopped"
      : backend?.status === "stopping" ? "stopping" : backend ? "running" : "error";
    const canControl = backend?.status === "running"
      && backend.control?.enabled
      && Array.isArray(backend.control.availableActions);

    dom.backendDialogState.dataset.state = stateKind;
    dom.backendDialogTitle.textContent = stateLabel;
    dom.backendDialogSummary.textContent = backend?.status === "stopped"
      ? "已关闭；请在电脑端启动监控服务。"
      : backend
        ? `${backendAddress(backend)} · ${formatUptime(backend.uptimeSeconds)}${backend.control?.enabled ? "" : " · 控制需要面板密码"}`
        : "请确认本机服务正在运行，并已完成面板登录。";
    dom.backendAddress.textContent = backendAddress(backend);
    dom.backendUptime.textContent = backend ? formatUptime(backend.uptimeSeconds) : "--";
    dom.backendStartedAt.textContent = backend ? formatBackendStartedAt(backend.startedAt) : "--";
    dom.backendProcessId.textContent = backend?.processId || "--";
    dom.backendInstanceId.textContent = backend?.instanceId || "--";
    dom.backendRestart.disabled = !(canControl && backend.control.availableActions.includes("restart")) || state.backendBusy;
    dom.backendStop.disabled = !(canControl && backend.control.availableActions.includes("stop")) || state.backendBusy;
    dom.backendForm.setAttribute("aria-busy", String(state.backendBusy || state.autostartBusy));
  }

  function renderBackend(backend) {
    if (!backend) {
      dom.backendState.dataset.state = "error";
      dom.backendDetail.textContent = "暂时无法读取后端状态";
      dom.backendState.setAttribute("aria-label", "后端状态不可用");
      renderBackendDialog(null);
      return;
    }

    const stateLabel = backend.status === "stopped"
      ? "后端服务已关闭"
      : backend.status === "stopping" ? "正在关闭或重启" : "后端服务运行中";
    dom.backendState.dataset.state = backend.status;
    dom.backendDetail.textContent = backend.status === "stopped"
      ? "已关闭；请在电脑端启动监控服务"
      : backend.status === "stopping"
        ? `正在处理请求 · ${backendAddress(backend)}`
        : `${backendAddress(backend)} · ${formatUptime(backend.uptimeSeconds)}${backend.control?.enabled ? "" : " · 控制需要面板密码"}`;
    dom.backendState.setAttribute("aria-label", `${stateLabel}，${dom.backendDetail.textContent}`);
    renderBackendDialog(backend);
  }

  function setBackendBusy(busy) {
    state.backendBusy = busy;
    renderBackend(state.backend);
  }

  function setAutostartBusy(busy) {
    state.autostartBusy = busy;
    renderAutostart(state.autostart);
    renderBackendDialog(state.backend);
  }

  function renderRecent(recent) {
    const rows = recent.slice(0, MAX_RECENT_ROWS);
    dom.recentCount.textContent = `显示 ${formatInteger(rows.length)} 条`;
    dom.recentList.replaceChildren();

    if (rows.length === 0) {
      dom.recentList.append(element("li", "list-placeholder", "当前范围暂无调用记录"));
      return;
    }

    rows.forEach((call) => {
      const row = element("li", "call-row");
      const top = element("div", "call-topline");
      const identity = element("div", "call-identity");
      const mark = element("span", `status-mark ${statusClass(call.status)}`);
      mark.title = statusLabel(call.status);
      mark.setAttribute("aria-label", statusLabel(call.status));
      const project = element("strong", "call-project", asText(call.project, "未命名项目"));
      project.title = project.textContent;
      identity.append(mark, project);
      const cost = element("span", "call-cost", formatMoney(asNumber(call.cost)));
      top.append(identity, cost);

      const meta = element("div", "call-meta");
      const time = element("time", "call-time", formatCallTime(call.timestamp));
      if (call.timestamp) time.dateTime = asText(call.timestamp);
      const model = element("span", "call-model", asText(call.model, "模型未知"));
      model.title = model.textContent;
      const totalTokens = asNumber(call.totalTokens)
        ?? ((asNumber(call.inputTokens) ?? 0) + (asNumber(call.outputTokens) ?? 0));
      const tokens = element("span", "call-tokens", `${formatQuantity(totalTokens, 1)} Token`);
      const latency = element("span", "call-latency", formatLatency(asNumber(call.latencyMs)));
      meta.append(time, model, tokens, latency);

      if (call.stream === true) meta.append(element("span", "stream-tag", "流式"));
      if (call.source) meta.append(element("span", "source-label", sourceLabel(call.source)));
      if (call.keyLabel) {
        const key = element("span", "key-label", asText(call.keyLabel));
        key.title = key.textContent;
        meta.append(key);
      }

      row.append(top, meta);
      dom.recentList.append(row);
    });
  }

  function renderModels(models) {
    const rows = models.slice(0, MAX_MODEL_ROWS);
    dom.modelsList.replaceChildren();
    dom.modelsCount.textContent = rows.length ? `TOP ${rows.length}` : "TOP --";

    if (rows.length === 0) {
      dom.modelsList.append(element("li", "list-placeholder", "当前范围暂无模型数据"));
      return;
    }

    const tokenTotal = models.reduce((sum, item) => sum + (asNumber(item.tokens) ?? 0), 0);
    rows.forEach((model, index) => {
      let share = asNumber(model.share);
      if (share === null) share = tokenTotal > 0 ? ((asNumber(model.tokens) ?? 0) / tokenTotal) * 100 : 0;
      if (share >= 0 && share <= 1) share *= 100;
      share = Math.max(0, Math.min(100, share));

      const row = element("li", "model-row");
      row.setAttribute("aria-label", `第 ${index + 1} 名，${asText(model.model, "模型未知")}，占比 ${formatRate(share)}`);
      const top = element("div", "model-topline");
      const nameBlock = element("div", "model-name-block");
      const rank = element("span", "rank-number", String(index + 1));
      const name = element("span", "model-name", asText(model.model, "模型未知"));
      name.title = name.textContent;
      nameBlock.append(rank, name);
      top.append(nameBlock, element("span", "model-share", formatRate(share)));

      const bar = element("div", "model-bar");
      const fill = element("span");
      fill.style.setProperty("--share", `${share}%`);
      fill.setAttribute("aria-label", `${formatRate(share)} 占比`);
      bar.append(fill);

      const values = element("div", "model-values");
      values.append(
        element("span", "", `${formatQuantity(asNumber(model.tokens), 1)} Token`),
        element("span", "", `${formatQuantity(asNumber(model.requests), 1)} 次`),
        element("span", "", formatMoney(asNumber(model.cost)))
      );
      row.append(top, bar, values);
      dom.modelsList.append(row);
    });
  }

  function renderLifetime(lifetime) {
    setMetric(dom.lifetimeTokens, formatQuantity(lifetime.tokens, 2));
    setMetric(dom.lifetimeRequests, formatQuantity(lifetime.requests, 1));
    setMetric(dom.lifetimeCost, formatMoney(lifetime.cost, !state.preciseNumbers));
  }

  function trendPointLabel(point) {
    return asText(point?.time, "时间未知") || "时间未知";
  }

  function trendPointDetail(point) {
    const tokens = asNumber(point?.tokens) ?? 0;
    const requests = asNumber(point?.requests) ?? 0;
    const cost = asNumber(point?.cost) ?? 0;
    const latency = asNumber(point?.avgLatencyMs) ?? 0;
    return `${trendPointLabel(point)} · ${formatQuantity(tokens, 1)} Token · ${formatQuantity(requests, 1)} 请求 · ${formatMoney(cost)} · 平均 ${formatLatency(latency)}`;
  }

  function trendTimeline() {
    const timeline = state.data?.timeline ?? [];
    if (state.chartWindow === "all" || timeline.length === 0) return timeline;
    const windowHours = Number.parseInt(state.chartWindow, 10);
    if (!Number.isFinite(windowHours) || windowHours <= 0) return timeline;

    const timestamps = timeline
      .map((point) => parseDate(point?.timestamp ?? point?.time)?.getTime())
      .filter((timestamp) => Number.isFinite(timestamp));
    if (timestamps.length === 0) return timeline;
    const latest = Math.max(...timestamps);
    const cutoff = latest - windowHours * 3_600_000 + 1;
    return timeline.filter((point) => {
      const timestamp = parseDate(point?.timestamp ?? point?.time)?.getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  }

  function syncChartWindowButtons() {
    document.querySelectorAll("[data-chart-window]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.chartWindow === state.chartWindow));
    });
  }

  function selectChartWindow(windowName) {
    if (!VALID_CHART_WINDOWS.has(windowName) || windowName === state.chartWindow) return;
    state.chartWindow = windowName;
    state.chartSelectedIndex = -1;
    state.chartSelectedTime = "";
    try {
      window.localStorage.setItem(CHART_WINDOW_STORAGE_KEY, windowName);
    } catch {
      // A chart window remains active for this page even when it cannot be persisted.
    }
    syncChartWindowButtons();
    drawTrend();
  }

  function syncTrendSelection(timeline) {
    if (timeline.length === 0) {
      state.chartSelectedIndex = -1;
      state.chartSelectedTime = "";
      return -1;
    }

    let selectedIndex = timeline.findIndex((point) => trendPointLabel(point) === state.chartSelectedTime);
    if (selectedIndex < 0) selectedIndex = timeline.length - 1;
    state.chartSelectedIndex = selectedIndex;
    state.chartSelectedTime = trendPointLabel(timeline[selectedIndex]);
    return selectedIndex;
  }

  function updateTrendDetail(timeline, selectedIndex, modeLabel) {
    const point = timeline[selectedIndex];
    if (!point) {
      dom.chartDetail.textContent = "当前范围内暂无趋势明细";
      dom.canvas.removeAttribute("aria-valuemin");
      dom.canvas.removeAttribute("aria-valuemax");
      dom.canvas.removeAttribute("aria-valuenow");
      dom.canvas.removeAttribute("aria-valuetext");
      return;
    }

    const detail = trendPointDetail(point);
    dom.chartDetail.textContent = detail;
    dom.canvas.setAttribute("aria-valuemin", "1");
    dom.canvas.setAttribute("aria-valuemax", String(timeline.length));
    dom.canvas.setAttribute("aria-valuenow", String(selectedIndex + 1));
    dom.canvas.setAttribute("aria-valuetext", detail);
    dom.canvas.setAttribute(
      "aria-label",
      `${modeLabel}趋势，第 ${selectedIndex + 1} / ${timeline.length} 个时间点。${detail}。可点击曲线或用左右方向键查看其他时间点。`
    );
  }

  function selectTrendPoint(index) {
    const timeline = trendTimeline();
    if (timeline.length === 0) return;
    const selectedIndex = Math.max(0, Math.min(timeline.length - 1, index));
    state.chartSelectedIndex = selectedIndex;
    state.chartSelectedTime = trendPointLabel(timeline[selectedIndex]);
    drawTrend();
  }

  function selectTrendPointAtClientX(clientX) {
    const points = state.chartLayout?.points;
    if (!points?.length) return;
    const bounds = dom.canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    points.forEach((point, index) => {
      const distance = Math.abs(point.x - x);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    selectTrendPoint(closestIndex);
  }

  function drawTrend() {
    const context = dom.canvas.getContext("2d");
    if (!context) return;

    const rect = dom.canvas.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(140, Math.floor(rect.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    dom.canvas.width = Math.floor(width * ratio);
    dom.canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const timeline = trendTimeline();
    const mode = state.chartMode;
    const values = timeline.map((point) => asNumber(point?.[mode]) ?? 0);
    const formatter = formatQuantity;
    const modeLabel = mode === "tokens" ? "Token" : "请求";
    const selectedIndex = syncTrendSelection(timeline);

    if (values.length === 0) {
      state.chartLayout = null;
      context.fillStyle = "#78898c";
      context.font = "12px system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("暂无趋势数据", width / 2, height / 2);
      dom.chartPeak.textContent = "峰值 --";
      dom.chartTotal.textContent = "合计 --";
      dom.canvas.setAttribute("aria-label", `${modeLabel}趋势暂无数据`);
      updateTrendDetail(timeline, selectedIndex, modeLabel);
      return;
    }

    const peak = Math.max(...values, 0);
    const floor = Math.min(...values, 0);
    const range = Math.max(peak - floor, peak || 1);
    const padding = { top: 14, right: 8, bottom: 24, left: 8 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    context.lineWidth = 1;
    context.strokeStyle = "#e0e8e8";
    for (let index = 0; index <= 3; index += 1) {
      const y = padding.top + (graphHeight * index) / 3;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
    }

    const points = values.map((value, index) => ({
      x: padding.left + (values.length === 1 ? graphWidth / 2 : (graphWidth * index) / (values.length - 1)),
      y: padding.top + graphHeight - ((value - floor) / range) * graphHeight
    }));
    state.chartLayout = { points };

    context.strokeStyle = mode === "tokens" ? "#0b746b" : "#376bb1";
    context.lineWidth = 2.2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();

    const accent = mode === "tokens" ? "#0b746b" : "#376bb1";
    if (points.length <= 96) {
      context.fillStyle = accent;
      context.globalAlpha = 0.55;
      points.forEach((point) => {
        context.beginPath();
        context.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
        context.fill();
      });
      context.globalAlpha = 1;
    }

    const selectedPoint = points[selectedIndex];
    context.strokeStyle = accent;
    context.globalAlpha = 0.42;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(selectedPoint.x, padding.top);
    context.lineTo(selectedPoint.x, height - padding.bottom);
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = accent;
    context.beginPath();
    context.arc(selectedPoint.x, selectedPoint.y, 5.2, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(selectedPoint.x, selectedPoint.y, 2.2, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#78898c";
    context.font = "10px system-ui, sans-serif";
    context.textAlign = "left";
    context.fillText(asText(timeline[0]?.time, ""), padding.left, height - 5);
    context.textAlign = "right";
    context.fillText(asText(timeline[timeline.length - 1]?.time, ""), width - padding.right, height - 5);

    const total = values.reduce((sum, value) => sum + value, 0);
    dom.chartPeak.textContent = `峰值 ${formatter(peak, 1)}`;
    dom.chartTotal.textContent = `合计 ${formatter(total, 1)}`;
    updateTrendDetail(timeline, selectedIndex, modeLabel);
  }

  function renderDashboard(data) {
    renderSummary(data.summary);
    renderSources(data.sources, data.activeSource);
    renderRecent(data.recent);
    renderModels(data.models);
    renderLifetime(data.lifetime);
    drawTrend();
    dom.updatedAt.textContent = formatUpdatedAt(data.generatedAt);
    dom.body.classList.remove("initial-loading");
    applyRangeLabels();
    syncValueToggleAccessibility();
  }

  async function fetchBackendStatus() {
    const fetchId = ++state.backendFetchId;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/backend", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const backend = normalizeBackend(await response.json());
      if (fetchId !== state.backendFetchId) return null;
      state.backend = backend;
      renderBackend(backend);
      return backend;
    } catch {
      if (fetchId !== state.backendFetchId || state.backendBusy) return null;
      state.backend = null;
      renderBackend(null);
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function retryBackendAfterRestart(attempt = 0) {
    window.clearTimeout(state.backendRestartTimer);
    state.backendRestartTimer = window.setTimeout(async () => {
      state.backendRestartTimer = null;
      const backend = await fetchBackendStatus();
      if (backend?.status === "running") {
        setBackendBusy(false);
        void fetchDashboard();
        void fetchAutostartStatus();
        return;
      }
      if (attempt + 1 < BACKEND_RESTART_MAX_ATTEMPTS) {
        retryBackendAfterRestart(attempt + 1);
        return;
      }
      setBackendBusy(false);
      state.backend = null;
      renderBackend(null);
      showToast("后端重启尚未完成，请稍后刷新");
    }, BACKEND_RESTART_RETRY_MS);
  }

  async function requestBackendAction(action) {
    const backend = state.backend;
    if (state.backendBusy || !backend?.control?.availableActions?.includes(action)) return;
    const restart = action === "restart";
    const confirmation = restart
      ? "确定重启后端服务？当前实时连接会短暂中断。"
      : "确定关闭后端服务？关闭后需要在电脑端重新启动。";
    if (!window.confirm(confirmation)) return;

    setBackendBusy(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/backend", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action }),
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status === 403) throw new Error("后端控制需要先设置面板密码");
        if (response.status === 401) throw new Error("面板密码不正确或已失效");
        throw new Error(`HTTP ${response.status}`);
      }

      state.backend = { ...backend, status: restart ? "stopping" : "stopped" };
      renderBackend(state.backend);
      showToast(restart ? "正在重启后端服务" : "已请求关闭后端服务");

      if (!restart) {
        setBackendBusy(false);
        setBackendManagementStatus("已请求关闭服务", "success");
        return;
      }

      retryBackendAfterRestart();
    } catch (error) {
      setBackendBusy(false);
      showToast(error instanceof DOMException && error.name === "AbortError"
        ? "后端控制请求超时，请稍后重试"
        : error instanceof Error ? error.message : "后端控制请求失败");
      void fetchBackendStatus();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function fetchAutostartStatus() {
    const fetchId = ++state.autostartFetchId;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/autostart", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const autostart = normalizeAutostart(await response.json());
      if (fetchId !== state.autostartFetchId) return null;
      state.autostart = autostart;
      renderAutostart(autostart);
      return autostart;
    } catch {
      if (fetchId !== state.autostartFetchId || state.autostartBusy) return null;
      state.autostart = null;
      renderAutostart(null);
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function selectedAutostartMode() {
    return dom.backendForm.querySelector('input[name="autostartMode"]:checked')?.value === "cc-switch"
      ? "cc-switch"
      : "always";
  }

  async function updateAutostart(enabled, mode) {
    if (state.autostartBusy || state.autostart?.supported !== true) return;
    const previous = state.autostart;
    state.autostart = { ...previous, enabled, mode };
    setAutostartBusy(true);
    setBackendManagementStatus("正在保存开机自启设置");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/autostart", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ enabled, mode }),
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status === 403) throw new Error("开机自启管理需要先设置面板密码");
        if (response.status === 401) throw new Error("面板密码不正确或已失效");
        throw new Error(`HTTP ${response.status}`);
      }
      state.autostart = normalizeAutostart(await response.json());
      renderAutostart(state.autostart);
      setBackendManagementStatus("开机自启设置已保存", "success");
    } catch (error) {
      setBackendManagementStatus(
        error instanceof DOMException && error.name === "AbortError"
          ? "保存开机自启设置超时"
          : error instanceof Error ? error.message : "无法保存开机自启设置",
        "error"
      );
      state.autostart = previous;
      setAutostartBusy(false);
      await fetchAutostartStatus();
    } finally {
      window.clearTimeout(timeout);
      if (state.autostartBusy) setAutostartBusy(false);
    }
  }

  async function openBackendManagement() {
    setBackendManagementStatus("");
    if (!dom.backendDialog.open) dom.backendDialog.showModal();
    await Promise.all([fetchBackendStatus(), fetchAutostartStatus()]);
  }

  function closeBackendManagement() {
    if (state.backendBusy || state.autostartBusy) return;
    if (dom.backendDialog.open) dom.backendDialog.close();
  }

  async function fetchDashboard({ announce = false, initial = false } = {}) {
    const fetchId = ++state.fetchId;
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    const controller = state.controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    setFetching(true);

    if (initial && !state.data) {
      showState("loading", "···", "正在读取监测数据", "首次同步可能需要片刻。", false);
    }

    try {
      const query = new URLSearchParams({ range: state.range, source: state.source });
      const response = await fetch(`/api/dashboard?${query}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (fetchId !== state.fetchId) return;

      const data = normalizeDashboard(payload);
      state.data = data;
      state.lastSuccessAt = Date.now();
      renderDashboard(data);
      void fetchBackendStatus();

      if (hasNoActivity(data)) {
        showState("empty", "0", "暂无调用数据", "监测服务已连接，等待第一条调用记录。", false);
      } else {
        hideState();
      }

      if (!navigator.onLine) setConnection("offline", "设备离线");
      else if (state.sseConnected) setConnection("live", "实时连接");
      else setConnection("polling", "轮询更新");
      if (announce) showToast("数据已更新");
    } catch (error) {
      if (error.name === "AbortError" && fetchId !== state.fetchId) return;
      if (fetchId !== state.fetchId) return;

      const offline = !navigator.onLine;
      setConnection(offline ? "offline" : "error", offline ? "设备离线" : "更新失败");
      if (state.data) {
        showState(
          offline ? "offline" : "error",
          offline ? "!" : "×",
          offline ? "当前处于离线状态" : "更新失败",
          "当前显示上次成功同步的数据。",
          !offline
        );
      } else {
        dom.body.classList.remove("initial-loading");
        showState(
          offline ? "offline" : "error",
          offline ? "!" : "×",
          offline ? "无法连接监测服务" : "无法读取监测数据",
          offline ? "网络恢复后将自动重试。" : "请检查服务状态后重试。",
          !offline
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (fetchId === state.fetchId) {
        setFetching(false);
        state.controller = null;
      }
    }
  }

  function scheduleStreamRefresh() {
    window.clearTimeout(state.streamRefreshTimer);
    state.streamRefreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") fetchDashboard();
    }, 250);
  }

  function connectStream() {
    if (!("EventSource" in window) || !navigator.onLine) return;
    if (state.eventSource) state.eventSource.close();
    state.sseConnected = false;

    const query = new URLSearchParams({ range: state.range, source: state.source });
    const stream = new EventSource(`/api/stream?${query}`);
    state.eventSource = stream;
    setConnection("connecting", "正在连接");

    stream.addEventListener("open", () => {
      if (state.eventSource !== stream) return;
      state.sseConnected = true;
      setConnection("live", "实时连接");
    });
    stream.addEventListener("dashboard", scheduleStreamRefresh);
    stream.addEventListener("update", scheduleStreamRefresh);
    stream.addEventListener("message", scheduleStreamRefresh);
    stream.addEventListener("error", () => {
      if (state.eventSource !== stream) return;
      state.sseConnected = false;
      setConnection(navigator.onLine ? "retrying" : "offline", navigator.onLine ? "正在重连" : "设备离线");
    });
  }

  function updateStaleStatus() {
    if (!navigator.onLine) {
      setConnection("offline", "设备离线");
      return;
    }
    if (state.lastSuccessAt && Date.now() - state.lastSuccessAt > STALE_AFTER_MS) {
      setConnection("stale", "数据已过期");
    }
  }

  function selectRange(range) {
    if (!VALID_RANGES.has(range) || range === state.range) return;
    state.range = range;
    applyRangeLabels();
    const url = new URL(window.location.href);
    url.searchParams.set("range", range);
    window.history.replaceState(null, "", url);
    connectStream();
    fetchDashboard({ initial: !state.data });
  }

  function selectSource(source) {
    if (!VALID_SOURCES.has(source) || source === state.source) return;
    state.source = source;
    const url = new URL(window.location.href);
    url.searchParams.set("source", source);
    window.history.replaceState(null, "", url);
    if (source === "all") showToast("全部相加可能包含同一链路的重复记录");
    connectStream();
    fetchDashboard({ initial: !state.data });
  }

  function registerInteractions() {
    document.querySelectorAll("[data-range]").forEach((button) => {
      button.addEventListener("click", () => selectRange(button.dataset.range));
    });
    document.querySelectorAll("[data-chart-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.chartMode = button.dataset.chartMode;
        document.querySelectorAll("[data-chart-mode]").forEach((modeButton) => {
          modeButton.setAttribute("aria-pressed", String(modeButton === button));
        });
        drawTrend();
      });
    });
    document.querySelectorAll("[data-chart-window]").forEach((button) => {
      button.addEventListener("click", () => selectChartWindow(button.dataset.chartWindow));
    });
    document.querySelectorAll("[data-value]").forEach((item) => {
      item.addEventListener("click", togglePreciseNumbers);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        togglePreciseNumbers();
      });
    });
    dom.canvas.addEventListener("click", (event) => selectTrendPointAtClientX(event.clientX));
    dom.canvas.addEventListener("keydown", (event) => {
      const timeline = trendTimeline();
      if (timeline.length === 0) return;
      let nextIndex = state.chartSelectedIndex;
      if (event.key === "ArrowLeft") nextIndex -= 1;
      else if (event.key === "ArrowRight") nextIndex += 1;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = timeline.length - 1;
      else return;
      event.preventDefault();
      selectTrendPoint(nextIndex);
    });
    dom.backendMenu.addEventListener("click", () => void openBackendManagement());
    dom.backendClose.addEventListener("click", closeBackendManagement);
    dom.backendRestart.addEventListener("click", () => void requestBackendAction("restart"));
    dom.backendStop.addEventListener("click", () => void requestBackendAction("stop"));
    dom.autostartEnabled.addEventListener("change", () => {
      void updateAutostart(dom.autostartEnabled.checked, selectedAutostartMode());
    });
    dom.backendForm.querySelectorAll('input[name="autostartMode"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) void updateAutostart(dom.autostartEnabled.checked, selectedAutostartMode());
      });
    });
    dom.backendDialog.addEventListener("click", (event) => {
      if (event.target === dom.backendDialog) closeBackendManagement();
    });
    dom.refresh.addEventListener("click", () => fetchDashboard({ announce: true }));
    dom.retry.addEventListener("click", () => fetchDashboard({ announce: true }));
    dom.settingsButton.addEventListener("click", openSettings);
    dom.settingsClose.addEventListener("click", closeSettings);
    dom.settingsCancel.addEventListener("click", closeSettings);
    dom.settingsForm.addEventListener("submit", saveSettings);
    dom.settingsForm.addEventListener("change", syncSettingsVisibility);
    dom.ccSwitchDbPath.addEventListener("input", syncSettingsVisibility);
    dom.clearAdminKey.addEventListener("change", () => {
      if (dom.clearAdminKey.checked) dom.sub2apiAdminKey.value = "";
      syncSettingsVisibility();
    });
    dom.clearToken.addEventListener("change", () => {
      if (dom.clearToken.checked) dom.sub2apiToken.value = "";
      syncSettingsVisibility();
    });
    dom.settingsDialog.addEventListener("click", (event) => {
      if (event.target === dom.settingsDialog) closeSettings();
    });
    dom.sourceSelect.value = state.source;
    dom.sourceSelect.addEventListener("change", () => selectSource(dom.sourceSelect.value));

    window.addEventListener("online", () => {
      connectStream();
      fetchDashboard();
      void fetchBackendStatus();
    });
    window.addEventListener("offline", () => {
      state.sseConnected = false;
      setConnection("offline", "设备离线");
      showState("offline", "!", "当前处于离线状态", state.data ? "当前显示上次成功同步的数据。" : "网络恢复后将自动重试。", false);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        updateStaleStatus();
        fetchDashboard();
        void fetchBackendStatus();
      }
    });

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => window.requestAnimationFrame(drawTrend));
      observer.observe(dom.canvas.parentElement);
    } else {
      window.addEventListener("resize", drawTrend, { passive: true });
    }
  }

  function setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      dom.install.hidden = false;
    });
    dom.install.addEventListener("click", async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      dom.install.hidden = true;
    });
    window.addEventListener("appinstalled", () => {
      state.installPrompt = null;
      dom.install.hidden = true;
      showToast("应用已安装");
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // The dashboard remains usable when service worker registration is unavailable.
      });
    });
  }

  applyRangeLabels();
  syncChartWindowButtons();
  syncValueToggleAccessibility();
  registerInteractions();
  setupInstallPrompt();
  registerServiceWorker();
  connectStream();
  void fetchBackendStatus();
  fetchDashboard({ initial: true });

  window.setInterval(() => {
    updateStaleStatus();
    if (document.visibilityState === "visible" && navigator.onLine) {
      fetchDashboard();
      void fetchBackendStatus();
    }
  }, POLL_INTERVAL_MS);

  window.addEventListener("beforeunload", () => {
    state.eventSource?.close();
    state.controller?.abort();
    window.clearTimeout(state.backendRestartTimer);
  });
})();
