package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.View;
import android.view.Window;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.appcompat.app.AlertDialog;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.button.MaterialButtonToggleGroup;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

import java.text.NumberFormat;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native Material 3 dashboard and the shared connection settings surface. */
public final class MainActivity extends ComponentActivity {
    private static final int STATE_LOADING = 0;
    private static final int STATE_NOT_CONFIGURED = 1;
    private static final int STATE_ERROR = 2;

    private final ExecutorService dashboardExecutor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SwipeRefreshLayout swipeRefresh;
    private MaterialButtonToggleGroup rangeGroup;
    private MaterialButtonToggleGroup sourceGroup;
    private MaterialButtonToggleGroup trendGroup;
    private MaterialButtonToggleGroup trendRangeGroup;
    private LinearLayout dashboardData;
    private View emptyState;
    private TextView emptyTitle;
    private TextView emptyMessage;
    private MaterialButton emptyAction;
    private TextView connectionText;
    private TextView updatedText;
    private View connectionDot;
    private View backendDot;
    private TextView backendDetailText;
    private MaterialButton backendManageButton;
    private MaterialButton updateButton;
    private TextView tokensText;
    private TextView costText;
    private TextView requestsText;
    private TextView latencyText;
    private TextView rpmText;
    private TextView tpmText;
    private TextView successText;
    private TextView servicesText;
    private TextView keysText;
    private TextView lifetimeTokensText;
    private TextView lifetimeRequestsText;
    private TextView lifetimeCostText;
    private TextView recentSubtitle;
    private LinearLayout recentList;
    private ModelBarChartView modelsChart;
    private TrendChartView trendChart;
    private TextView trendDetailText;
    private TextView trendPeakText;
    private TextView trendTotalText;

    private AlertDialog settingsDialog;
    private String selectedRange = "today";
    private String selectedSource = "auto";
    private String trendWindow = "all";
    private boolean trendRequests;
    private boolean preciseNumbers;
    private boolean loading;
    private int requestSequence;
    private int emptyStateMode = STATE_LOADING;
    private boolean configurationRequest;
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private DashboardClient.Snapshot lastSnapshot;
    private UpdateClient.Request updateRequest;
    private boolean updateInFlight;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prepareEdgeToEdge();
        setContentView(R.layout.activity_main);
        bindViews();
        applySystemBarInsets();

        DashboardPrefs.Config config = DashboardPrefs.load(this);
        selectedRange = config.range;
        selectedSource = config.source;
        trendWindow = DashboardPrefs.trendWindow(this);
        preciseNumbers = DashboardPrefs.preciseNumbers(this);
        rangeGroup.check(rangeButtonId(selectedRange));
        sourceGroup.check(sourceButtonId(selectedSource));
        trendRangeGroup.check(trendRangeButtonId(trendWindow));
        bindActions();
        bindNumberModeToggles();

        configurationRequest = getIntent().hasExtra(AppWidgetManager.EXTRA_APPWIDGET_ID);
        if (configurationRequest) {
            setResult(RESULT_CANCELED);
            widgetId = getIntent().getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID
            );
            if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                Toast.makeText(this, R.string.widget_id_missing, Toast.LENGTH_SHORT).show();
                finish();
                return;
            }

            // Preserve a manually configured widget when it opens this activity again.
            if (!config.isConfigured()) {
                WidgetPrefs.Config widgetConfig = WidgetPrefs.load(this, widgetId);
                if (widgetConfig.isConfigured()) {
                    DashboardPrefs.saveConnection(this, widgetConfig.baseUrl, widgetConfig.password);
                    config = DashboardPrefs.load(this);
                }
            }
            if (config.isConfigured()) {
                completeWidgetConfiguration(config);
            } else {
                showNotConfigured();
                main.post(() -> showConnectionSettings(false));
            }
            return;
        }

        if (config.isConfigured()) {
            refreshDashboard();
        } else {
            showNotConfigured();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumePendingUpdateInstallIfAllowed();
    }

    private void prepareEdgeToEdge() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(getColor(R.color.page_background));
    }

    private void applySystemBarInsets() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), swipeRefresh);
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);
        ViewCompat.setOnApplyWindowInsetsListener(swipeRefresh, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        ViewCompat.requestApplyInsets(swipeRefresh);
    }

    private void bindViews() {
        swipeRefresh = findViewById(R.id.dashboard_root);
        rangeGroup = findViewById(R.id.dashboard_range_group);
        sourceGroup = findViewById(R.id.dashboard_source_group);
        trendGroup = findViewById(R.id.dashboard_trend_group);
        trendRangeGroup = findViewById(R.id.dashboard_trend_range_group);
        dashboardData = findViewById(R.id.dashboard_data);
        emptyState = findViewById(R.id.dashboard_empty_state);
        emptyTitle = findViewById(R.id.dashboard_empty_title);
        emptyMessage = findViewById(R.id.dashboard_empty_message);
        emptyAction = findViewById(R.id.dashboard_empty_action);
        connectionText = findViewById(R.id.dashboard_connection);
        updatedText = findViewById(R.id.dashboard_updated_at);
        connectionDot = findViewById(R.id.dashboard_connection_dot);
        backendDot = findViewById(R.id.dashboard_backend_dot);
        backendDetailText = findViewById(R.id.dashboard_backend_detail);
        backendManageButton = findViewById(R.id.dashboard_backend_manage);
        updateButton = findViewById(R.id.dashboard_update);
        tokensText = findViewById(R.id.dashboard_tokens);
        costText = findViewById(R.id.dashboard_cost);
        requestsText = findViewById(R.id.dashboard_requests);
        latencyText = findViewById(R.id.dashboard_latency);
        rpmText = findViewById(R.id.dashboard_rpm);
        tpmText = findViewById(R.id.dashboard_tpm);
        successText = findViewById(R.id.dashboard_success);
        servicesText = findViewById(R.id.dashboard_services);
        keysText = findViewById(R.id.dashboard_keys);
        lifetimeTokensText = findViewById(R.id.dashboard_lifetime_tokens);
        lifetimeRequestsText = findViewById(R.id.dashboard_lifetime_requests);
        lifetimeCostText = findViewById(R.id.dashboard_lifetime_cost);
        recentSubtitle = findViewById(R.id.dashboard_recent_subtitle);
        recentList = findViewById(R.id.dashboard_recent_list);
        modelsChart = findViewById(R.id.dashboard_models_chart);
        trendChart = findViewById(R.id.dashboard_trend);
        trendDetailText = findViewById(R.id.dashboard_trend_detail);
        trendPeakText = findViewById(R.id.dashboard_trend_peak);
        trendTotalText = findViewById(R.id.dashboard_trend_total);
    }

    private void bindActions() {
        updateButton.setOnClickListener(view -> checkForAppUpdate());
        findViewById(R.id.dashboard_settings).setOnClickListener(view -> showConnectionSettings(false));
        findViewById(R.id.dashboard_add_widget).setOnClickListener(view -> requestWidgetPin());
        findViewById(R.id.dashboard_refresh).setOnClickListener(view -> refreshDashboard());
        backendManageButton.setOnClickListener(view ->
                startActivity(new Intent(this, BackendManagementActivity.class)));
        emptyAction.setOnClickListener(view -> {
            if (emptyStateMode == STATE_NOT_CONFIGURED) {
                showConnectionSettings(false);
            } else {
                refreshDashboard();
            }
        });
        swipeRefresh.setOnRefreshListener(this::refreshDashboard);
        trendChart.setOnPointSelectedListener(this::renderTrendPoint);
        rangeGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked) return;
            String range = rangeForButton(checkedId);
            if (range == null || range.equals(selectedRange)) return;
            selectedRange = range;
            DashboardPrefs.saveSelection(this, selectedRange, selectedSource);
            refreshDashboard();
        });
        sourceGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked) return;
            String source = sourceForButton(checkedId);
            if (source == null || source.equals(selectedSource)) return;
            selectedSource = source;
            DashboardPrefs.saveSelection(this, selectedRange, selectedSource);
            refreshDashboard();
        });
        trendGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked) return;
            trendRequests = checkedId == R.id.dashboard_trend_requests;
            if (lastSnapshot != null) renderTrend(lastSnapshot);
        });
        trendRangeGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked) return;
            String range = trendWindowForButton(checkedId);
            if (range == null || range.equals(trendWindow)) return;
            trendWindow = range;
            DashboardPrefs.saveTrendWindow(this, trendWindow);
            if (lastSnapshot != null) renderTrend(lastSnapshot);
        });
    }

    private void bindNumberModeToggles() {
        View.OnClickListener toggle = view -> toggleNumberMode();
        tokensText.setOnClickListener(toggle);
        costText.setOnClickListener(toggle);
        requestsText.setOnClickListener(toggle);
        latencyText.setOnClickListener(toggle);
        rpmText.setOnClickListener(toggle);
        tpmText.setOnClickListener(toggle);
        successText.setOnClickListener(toggle);
        servicesText.setOnClickListener(toggle);
        keysText.setOnClickListener(toggle);
        lifetimeTokensText.setOnClickListener(toggle);
        lifetimeRequestsText.setOnClickListener(toggle);
        lifetimeCostText.setOnClickListener(toggle);
        modelsChart.setOnClickListener(toggle);
    }

    private void checkForAppUpdate() {
        if (updateInFlight) return;
        setUpdateBusy(true, getString(R.string.dashboard_update_checking));
        updateRequest = UpdateClient.checkForUpdate(this, new UpdateClient.Listener() {
            @Override
            public void onCheckComplete(UpdateClient.CheckResult result) {
                updateRequest = null;
                setUpdateBusy(false, null);
                if (isFinishing()) return;
                if (!result.updateAvailable) {
                    Toast.makeText(MainActivity.this, R.string.dashboard_update_current, Toast.LENGTH_SHORT).show();
                    return;
                }
                showUpdateAvailable(result.latestRelease);
            }

            @Override
            public void onError(UpdateClient.UpdateException error) {
                updateRequest = null;
                setUpdateBusy(false, null);
                if (!isFinishing()) {
                    Toast.makeText(MainActivity.this, R.string.dashboard_update_failed, Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    private void showUpdateAvailable(UpdateClient.ReleaseInfo release) {
        String notes = release.releaseNotes == null ? "" : release.releaseNotes.trim();
        if (notes.length() > 600) notes = notes.substring(0, 600) + "…";
        String message = getString(R.string.dashboard_update_available_message, release.versionName);
        if (!notes.isEmpty()) message += "\n\n" + notes;
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.dashboard_update_available_title)
                .setMessage(message)
                .setNegativeButton(R.string.dashboard_update_later, null)
                .setPositiveButton(R.string.dashboard_update_now,
                        (dialog, which) -> downloadAndInstallUpdate(release))
                .show();
    }

    private void downloadAndInstallUpdate(UpdateClient.ReleaseInfo release) {
        if (updateInFlight) return;
        setUpdateBusy(true, getString(R.string.dashboard_update_downloading));
        updateRequest = UpdateClient.downloadUpdate(this, release, new UpdateClient.Listener() {
            @Override
            public void onDownloadProgress(UpdateClient.ReleaseInfo ignored, long downloaded, long total) {
                if (total <= 0L) return;
                int percent = (int) Math.min(100L, Math.max(0L, downloaded * 100L / total));
                updateButton.setText(getString(R.string.dashboard_update_download_progress, percent));
            }

            @Override
            public void onDownloaded(UpdateClient.ReleaseInfo ignored, java.io.File apk) {
                updateRequest = null;
                try {
                    UpdateInstaller.InstallResult result = UpdateInstaller.requestInstall(MainActivity.this, apk);
                    setUpdateBusy(false, null);
                    if (result == UpdateInstaller.InstallResult.PERMISSION_REQUIRED) {
                        Toast.makeText(
                                MainActivity.this,
                                R.string.dashboard_update_permission_required,
                                Toast.LENGTH_LONG
                        ).show();
                    } else if (result == UpdateInstaller.InstallResult.INSTALLER_OPENED) {
                        Toast.makeText(
                                MainActivity.this,
                                R.string.dashboard_update_installer_opened,
                                Toast.LENGTH_SHORT
                        ).show();
                    }
                } catch (UpdateInstaller.InstallException error) {
                    setUpdateBusy(false, null);
                    if (!isFinishing()) {
                        Toast.makeText(MainActivity.this, R.string.dashboard_update_failed, Toast.LENGTH_LONG).show();
                    }
                }
            }

            @Override
            public void onError(UpdateClient.UpdateException error) {
                updateRequest = null;
                setUpdateBusy(false, null);
                if (!isFinishing()) {
                    Toast.makeText(MainActivity.this, R.string.dashboard_update_failed, Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    private void resumePendingUpdateInstallIfAllowed() {
        if (!UpdateInstaller.hasPendingInstall(this)) return;
        if (!UpdateInstaller.canRequestPackageInstalls(this)) return;
        try {
            UpdateInstaller.InstallResult result = UpdateInstaller.resumePendingInstall(this);
            if (result == UpdateInstaller.InstallResult.INSTALLER_OPENED) {
                Toast.makeText(this, R.string.dashboard_update_installer_opened, Toast.LENGTH_SHORT).show();
            }
        } catch (UpdateInstaller.InstallException error) {
            Toast.makeText(this, R.string.dashboard_update_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void setUpdateBusy(boolean busy, String label) {
        updateInFlight = busy;
        updateButton.setEnabled(!busy);
        updateButton.setText(label == null ? getString(R.string.dashboard_update) : label);
    }

    private void toggleNumberMode() {
        preciseNumbers = !preciseNumbers;
        DashboardPrefs.savePreciseNumbers(this, preciseNumbers);
        if (lastSnapshot != null) renderSnapshot(lastSnapshot);
        Toast.makeText(
                this,
                getString(
                        R.string.dashboard_numbers_changed,
                        getString(preciseNumbers
                                ? R.string.dashboard_numbers_precise
                                : R.string.dashboard_numbers_compact)
                ),
                Toast.LENGTH_SHORT
        ).show();
    }

    private void requestWidgetPin() {
        if (!DashboardPrefs.load(this).isConfigured()) {
            // A pin request can be accepted without opening a configuration activity, so save first.
            showConnectionSettings(true);
            return;
        }
        WidgetPinHelper.requestPin(this);
    }

    private void refreshDashboard() {
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        if (!config.isConfigured()) {
            swipeRefresh.setRefreshing(false);
            showNotConfigured();
            return;
        }
        if (loading) {
            swipeRefresh.setRefreshing(false);
            return;
        }
        loading = true;
        swipeRefresh.setRefreshing(true);
        if (lastSnapshot == null) showLoading();
        int requestId = ++requestSequence;
        dashboardExecutor.execute(() -> {
            try {
                DashboardClient.Snapshot snapshot = DashboardClient.fetch(config, selectedRange, selectedSource);
                main.post(() -> {
                    if (requestId != requestSequence || isFinishing()) return;
                    loading = false;
                    swipeRefresh.setRefreshing(false);
                    renderSnapshot(snapshot);
                    refreshBackendStatus(config, requestId);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (requestId != requestSequence || isFinishing()) return;
                    loading = false;
                    swipeRefresh.setRefreshing(false);
                    showDashboardError();
                });
            }
        });
    }

    private void refreshBackendStatus(DashboardPrefs.Config config, int dashboardRequestId) {
        dashboardExecutor.execute(() -> {
            try {
                DashboardClient.BackendStatus status = DashboardClient.fetchBackend(config);
                main.post(() -> {
                    if (dashboardRequestId != requestSequence || isFinishing()) return;
                    renderBackendStatus(status);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (dashboardRequestId != requestSequence || isFinishing()) return;
                    showBackendUnavailable();
                });
            }
        });
    }

    private void renderBackendStatus(DashboardClient.BackendStatus status) {
        String address = backendAddress(status);
        if ("stopping".equals(status.status)) {
            backendDetailText.setText(getString(R.string.dashboard_backend_stopping, address));
            setBackendTone(getColor(R.color.amber));
        } else {
            String detail = getString(
                    R.string.dashboard_backend_running,
                    address,
                    formatBackendUptime(status.uptimeSeconds)
            );
            if (!status.controlsEnabled) {
                detail = getString(R.string.dashboard_backend_controls_disabled, detail);
            }
            backendDetailText.setText(detail);
            setBackendTone(getColor(R.color.green));
        }
    }

    private void showBackendUnavailable() {
        backendDetailText.setText(R.string.dashboard_backend_unavailable);
        setBackendTone(getColor(R.color.status_error));
    }

    private String backendAddress(DashboardClient.BackendStatus status) {
        String host = status.bindHost == null || status.bindHost.isEmpty()
                ? getString(R.string.dashboard_backend_unknown_address)
                : status.bindHost;
        return status.port > 0 ? host + ":" + status.port : host;
    }

    private String formatBackendUptime(long seconds) {
        long total = Math.max(0L, seconds);
        if (total < 60L) return getString(R.string.dashboard_backend_uptime_just_started);
        long days = total / 86_400L;
        long hours = (total % 86_400L) / 3_600L;
        long minutes = (total % 3_600L) / 60L;
        if (days > 0L) return getString(R.string.dashboard_backend_uptime_days, days, hours);
        if (hours > 0L) return getString(R.string.dashboard_backend_uptime_hours, hours, minutes);
        return getString(R.string.dashboard_backend_uptime_minutes, minutes);
    }

    private void setBackendTone(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        backendDot.setBackground(drawable);
        ViewCompat.setBackgroundTintList(backendDot, ColorStateList.valueOf(color));
    }

    private void renderSnapshot(DashboardClient.Snapshot snapshot) {
        lastSnapshot = snapshot;
        emptyState.setVisibility(View.GONE);
        dashboardData.setVisibility(View.VISIBLE);
        String activeSource = snapshot.activeSource.isEmpty() ? selectedSource : snapshot.activeSource;
        connectionText.setText(getString(R.string.dashboard_active_source, sourceLabel(activeSource)));
        connectionText.setTextColor(getColor(R.color.green));
        updatedText.setText(getString(R.string.dashboard_updated, displayTime(snapshot.generatedAt)));
        setConnectionTone(getColor(R.color.green));

        tokensText.setText(displayNumber(snapshot.tokens));
        costText.setText(displayMoney(snapshot.cost));
        requestsText.setText(displayNumber(snapshot.requests));
        latencyText.setText(latency(snapshot.avgLatencyMs));
        rpmText.setText(displayNumber(snapshot.rpm));
        tpmText.setText(displayNumber(snapshot.tpm));
        successText.setText(rate(snapshot.successRate));
        servicesText.setText(snapshot.servicesTotal > 0
                ? snapshot.servicesHealthy + "/" + snapshot.servicesTotal
                : "--");
        keysText.setText(displayNumber(snapshot.activeKeys));
        lifetimeTokensText.setText(displayNumber(snapshot.lifetimeTokens));
        lifetimeRequestsText.setText(displayNumber(snapshot.lifetimeRequests));
        lifetimeCostText.setText(displayMoney(snapshot.lifetimeCost));
        recentSubtitle.setText(snapshot.recent.isEmpty()
                ? getString(R.string.dashboard_no_recent)
                : getString(R.string.dashboard_recent_subtitle));
        renderRecent(snapshot);
        renderModels(snapshot);
        renderTrend(snapshot);
    }

    private void renderRecent(DashboardClient.Snapshot snapshot) {
        recentList.removeAllViews();
        if (snapshot.recent.isEmpty()) {
            recentList.addView(emptyListText(R.string.dashboard_no_recent));
            return;
        }
        for (int index = 0; index < snapshot.recent.size(); index++) {
            DashboardClient.Recent item = snapshot.recent.get(index);
            LinearLayout row = new LinearLayout(this);
            row.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
            ));
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(0, dp(7), 0, dp(7));

            TextView heading = dashboardText(15f, Typeface.BOLD, getColor(R.color.ink));
            heading.setSingleLine(true);
            heading.setEllipsize(TextUtils.TruncateAt.END);
            heading.setText(item.project + " | " + displayMoney(item.cost));
            TextView meta = dashboardText(12f, Typeface.NORMAL, getColor(R.color.muted));
            meta.setSingleLine(true);
            meta.setEllipsize(TextUtils.TruncateAt.END);
            meta.setText(getString(
                    R.string.dashboard_recent_meta,
                    displayTime(item.timestamp),
                    item.model,
                    displayNumber(item.tokens) + " Token | " + latency(item.latencyMs)
            ));
            row.addView(heading);
            row.addView(meta, withTopMargin(0));
            recentList.addView(row);
            if (index < snapshot.recent.size() - 1) recentList.addView(divider());
        }
    }

    private void renderModels(DashboardClient.Snapshot snapshot) {
        modelsChart.setModels(snapshot.models, preciseNumbers);
    }

    private void renderTrend(DashboardClient.Snapshot snapshot) {
        List<DashboardClient.TimelinePoint> timeline = filteredTimeline(snapshot.timeline);
        trendChart.setTrend(timeline, trendRequests);
        if (timeline.isEmpty()) trendDetailText.setText(R.string.dashboard_no_trend);
        long peak = 0;
        long total = 0;
        for (DashboardClient.TimelinePoint point : timeline) {
            long value = trendRequests ? point.requests : point.tokens;
            peak = Math.max(peak, value);
            total += value;
        }
        String unit = getString(trendRequests
                ? R.string.dashboard_trend_requests
                : R.string.dashboard_trend_tokens);
        trendPeakText.setText(getString(R.string.dashboard_trend_peak, displayNumber(peak) + " " + unit));
        trendTotalText.setText(getString(R.string.dashboard_trend_total, displayNumber(total) + " " + unit));
    }

    private List<DashboardClient.TimelinePoint> filteredTimeline(
            List<DashboardClient.TimelinePoint> source
    ) {
        if (source == null || source.isEmpty() || "all".equals(trendWindow)) {
            return source == null ? new ArrayList<>() : new ArrayList<>(source);
        }
        int hours = "6h".equals(trendWindow) ? 6 : "12h".equals(trendWindow) ? 12 : 24;
        long cutoff = System.currentTimeMillis() - hours * 3_600_000L;
        List<DashboardClient.TimelinePoint> filtered = new ArrayList<>();
        for (DashboardClient.TimelinePoint point : source) {
            Long timestamp = timelineEpochMillis(point.timestamp);
            // Retain service-supplied buckets without a parseable timestamp rather than hiding data.
            if (timestamp == null || timestamp >= cutoff) filtered.add(point);
        }
        return filtered;
    }

    private Long timelineEpochMillis(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            if (value.matches("\\d{13}")) return Long.parseLong(value);
            if (value.matches("\\d{10}")) return Long.parseLong(value) * 1_000L;
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException | NumberFormatException ignored) {
            return null;
        }
    }

    private void renderTrendPoint(DashboardClient.TimelinePoint point, boolean requestsMode) {
        String label = point.label == null || point.label.isEmpty() ? displayTime(point.timestamp) : point.label;
        trendDetailText.setText(getString(
                R.string.dashboard_trend_point_detail,
                label,
                exactNumber(point.tokens),
                exactNumber(point.requests),
                moneyDetailed(point.cost),
                latency(point.avgLatencyMs)
        ));
    }

    private TextView dashboardText(float sizeSp, int style, int color) {
        TextView text = new TextView(this);
        text.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        text.setTypeface(Typeface.DEFAULT, style);
        text.setTextColor(color);
        return text;
    }

    private TextView emptyListText(int message) {
        TextView text = dashboardText(14f, Typeface.NORMAL, getColor(R.color.muted));
        text.setText(message);
        text.setPadding(0, dp(8), 0, dp(8));
        return text;
    }

    private View divider() {
        View divider = new View(this);
        divider.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(1)
        ));
        divider.setBackgroundColor(getColor(R.color.line));
        return divider;
    }

    private LinearLayout.LayoutParams withTopMargin(int marginDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(marginDp);
        return params;
    }

    private void showLoading() {
        dashboardData.setVisibility(View.GONE);
        emptyState.setVisibility(View.VISIBLE);
        emptyStateMode = STATE_LOADING;
        emptyTitle.setText(R.string.dashboard_loading_title);
        emptyMessage.setText(R.string.dashboard_loading_message);
        emptyAction.setVisibility(View.GONE);
        connectionText.setText(R.string.dashboard_waiting_connection);
        connectionText.setTextColor(getColor(R.color.status_muted));
        updatedText.setText(R.string.dashboard_waiting_update);
        setConnectionTone(getColor(R.color.amber));
    }

    private void showNotConfigured() {
        dashboardData.setVisibility(View.GONE);
        emptyState.setVisibility(View.VISIBLE);
        emptyStateMode = STATE_NOT_CONFIGURED;
        emptyTitle.setText(R.string.dashboard_not_configured_title);
        emptyMessage.setText(R.string.dashboard_not_configured_message);
        emptyAction.setText(R.string.dashboard_connection_setup);
        emptyAction.setVisibility(View.VISIBLE);
        connectionText.setText(R.string.dashboard_needs_configuration);
        connectionText.setTextColor(getColor(R.color.status_muted));
        updatedText.setText(R.string.dashboard_waiting_update);
        setConnectionTone(getColor(R.color.amber));
    }

    private void showDashboardError() {
        connectionText.setText(R.string.dashboard_connection_failed);
        connectionText.setTextColor(getColor(R.color.status_error));
        setConnectionTone(getColor(R.color.status_error));
        if (lastSnapshot != null) {
            Toast.makeText(this, R.string.dashboard_error_message, Toast.LENGTH_SHORT).show();
            return;
        }
        dashboardData.setVisibility(View.GONE);
        emptyState.setVisibility(View.VISIBLE);
        emptyStateMode = STATE_ERROR;
        emptyTitle.setText(R.string.dashboard_error_title);
        emptyMessage.setText(R.string.dashboard_error_message);
        emptyAction.setText(R.string.dashboard_retry);
        emptyAction.setVisibility(View.VISIBLE);
    }

    private void showConnectionSettings(boolean pinAfterSave) {
        if (settingsDialog != null && settingsDialog.isShowing()) return;
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int horizontal = dp(4);
        form.setPadding(horizontal, 0, horizontal, 0);

        TextInputLayout urlLayout = outlinedInput(getString(R.string.config_url_label));
        TextInputEditText urlInput = new TextInputEditText(this);
        // TextInputLayout owns the floating label; a child hint would overlap it before focus.
        urlLayout.setPlaceholderText(getString(R.string.config_url_hint));
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setSingleLine(true);
        urlInput.setText(config.baseUrl);
        urlLayout.addView(urlInput);
        form.addView(urlLayout);

        TextInputLayout passwordLayout = outlinedInput(getString(R.string.config_password_label));
        TextInputEditText passwordInput = new TextInputEditText(this);
        passwordLayout.setPlaceholderText(getString(R.string.config_password_hint));
        passwordInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordInput.setSingleLine(true);
        passwordInput.setText(config.password);
        passwordLayout.addView(passwordInput);
        form.addView(passwordLayout, withTopMargin(14));

        TextView note = dashboardText(12f, Typeface.NORMAL, getColor(R.color.muted));
        note.setText(R.string.dashboard_connection_description);
        form.addView(note, withTopMargin(12));

        MaterialAlertDialogBuilder builder = new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.dashboard_connection_title)
                .setView(form)
                .setNegativeButton(R.string.dashboard_cancel, (dialog, which) -> {
                    if (configurationRequest) finish();
                })
                .setPositiveButton(R.string.dashboard_save_connection, null);
        settingsDialog = builder.create();
        settingsDialog.setOnDismissListener(dialog -> settingsDialog = null);
        settingsDialog.setOnShowListener(dialog -> settingsDialog.getButton(DialogInterface.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    urlLayout.setError(null);
                    final String baseUrl;
                    try {
                        baseUrl = EndpointValidator.normalizeBaseUrl(String.valueOf(urlInput.getText()));
                    } catch (IllegalArgumentException error) {
                        urlLayout.setError(error.getMessage());
                        return;
                    }
                    String password = String.valueOf(passwordInput.getText());
                    if (baseUrl.startsWith("http://")) {
                        new MaterialAlertDialogBuilder(this)
                                .setTitle(R.string.cleartext_title)
                                .setMessage(R.string.cleartext_message)
                                .setNegativeButton(android.R.string.cancel, null)
                                .setPositiveButton(R.string.continue_text,
                                        (confirmation, which) -> saveConnection(baseUrl, password, pinAfterSave))
                                .show();
                        return;
                    }
                    saveConnection(baseUrl, password, pinAfterSave);
                }));
        settingsDialog.show();
    }

    private TextInputLayout outlinedInput(String label) {
        TextInputLayout layout = new TextInputLayout(this);
        layout.setHint(label);
        layout.setBoxBackgroundMode(TextInputLayout.BOX_BACKGROUND_OUTLINE);
        layout.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        return layout;
    }

    private void saveConnection(String baseUrl, String password, boolean pinAfterSave) {
        DashboardPrefs.saveConnection(this, baseUrl, password);
        if (settingsDialog != null) settingsDialog.dismiss();
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        Toast.makeText(this, R.string.dashboard_connection_saved, Toast.LENGTH_SHORT).show();
        if (configurationRequest) {
            completeWidgetConfiguration(config);
            return;
        }
        if (pinAfterSave) WidgetPinHelper.requestPin(this);
        lastSnapshot = null;
        refreshDashboard();
    }

    private void completeWidgetConfiguration(DashboardPrefs.Config config) {
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID || !config.isConfigured()) {
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        WidgetPrefs.save(this, widgetId, config.baseUrl, config.password);
        WidgetUpdater.update(this, widgetId);
        Intent result = new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        setResult(RESULT_OK, result);
        Toast.makeText(this, R.string.dashboard_widget_configured, Toast.LENGTH_SHORT).show();
        finish();
    }

    private void setConnectionTone(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        connectionDot.setBackground(drawable);
        ViewCompat.setBackgroundTintList(connectionDot, ColorStateList.valueOf(color));
    }

    private int rangeButtonId(String range) {
        if ("24h".equals(range)) return R.id.dashboard_range_24h;
        if ("7d".equals(range)) return R.id.dashboard_range_7d;
        return R.id.dashboard_range_today;
    }

    private int trendRangeButtonId(String range) {
        if ("6h".equals(range)) return R.id.dashboard_trend_range_6h;
        if ("12h".equals(range)) return R.id.dashboard_trend_range_12h;
        if ("24h".equals(range)) return R.id.dashboard_trend_range_24h;
        return R.id.dashboard_trend_range_all;
    }

    private int sourceButtonId(String source) {
        if ("local".equals(source)) return R.id.dashboard_source_local;
        if ("sub2api".equals(source)) return R.id.dashboard_source_sub2api;
        if ("cc-switch".equals(source)) return R.id.dashboard_source_cc_switch;
        if ("all".equals(source)) return R.id.dashboard_source_all;
        return R.id.dashboard_source_auto;
    }

    private String rangeForButton(int buttonId) {
        if (buttonId == R.id.dashboard_range_today) return "today";
        if (buttonId == R.id.dashboard_range_24h) return "24h";
        if (buttonId == R.id.dashboard_range_7d) return "7d";
        return null;
    }

    private String trendWindowForButton(int buttonId) {
        if (buttonId == R.id.dashboard_trend_range_6h) return "6h";
        if (buttonId == R.id.dashboard_trend_range_12h) return "12h";
        if (buttonId == R.id.dashboard_trend_range_24h) return "24h";
        if (buttonId == R.id.dashboard_trend_range_all) return "all";
        return null;
    }

    private String sourceForButton(int buttonId) {
        if (buttonId == R.id.dashboard_source_auto) return "auto";
        if (buttonId == R.id.dashboard_source_local) return "local";
        if (buttonId == R.id.dashboard_source_sub2api) return "sub2api";
        if (buttonId == R.id.dashboard_source_cc_switch) return "cc-switch";
        if (buttonId == R.id.dashboard_source_all) return "all";
        return null;
    }

    private String sourceLabel(String source) {
        if ("local".equals(source)) return getString(R.string.source_local);
        if ("sub2api".equals(source)) return getString(R.string.source_sub2api);
        if ("cc-switch".equals(source)) return getString(R.string.source_cc_switch);
        if ("all".equals(source)) return getString(R.string.source_all);
        return getString(R.string.source_auto);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String compact(long value) {
        double number = value;
        String suffix = "";
        if (number >= 1_000_000_000_000d) { number /= 1_000_000_000_000d; suffix = "T"; }
        else if (number >= 1_000_000_000d) { number /= 1_000_000_000d; suffix = "B"; }
        else if (number >= 1_000_000d) { number /= 1_000_000d; suffix = "M"; }
        else if (number >= 1_000d) { number /= 1_000d; suffix = "K"; }
        if (suffix.isEmpty()) return NumberFormat.getIntegerInstance(Locale.getDefault()).format(value);
        return String.format(Locale.getDefault(), "%.1f%s", number, suffix);
    }

    private String displayNumber(long value) {
        return preciseNumbers ? exactNumber(value) : compact(value);
    }

    private static String money(double value) {
        return String.format(Locale.US, "$%.2f", value);
    }

    private String displayMoney(double value) {
        return preciseNumbers ? moneyDetailed(value) : money(value);
    }

    private static String moneyDetailed(double value) {
        int digits = value > 0d && value < 0.01d ? 4 : 2;
        return String.format(Locale.US, "$%." + digits + "f", value);
    }

    private static String exactNumber(long value) {
        return NumberFormat.getIntegerInstance(Locale.getDefault()).format(value);
    }

    private static String latency(long value) {
        return value >= 1_000 ? String.format(Locale.getDefault(), "%.1fs", value / 1_000d) : value + "ms";
    }

    private static String rate(double value) {
        return String.format(Locale.getDefault(), "%.1f%%", value);
    }

    private static String displayTime(String value) {
        if (value == null || value.isEmpty()) return "--";
        if (value.matches("\\d{13}")) {
            try {
                return DateTimeFormatter.ofPattern("HH:mm:ss", Locale.getDefault())
                        .withZone(ZoneId.systemDefault())
                        .format(Instant.ofEpochMilli(Long.parseLong(value)));
            } catch (NumberFormatException ignored) {
                return "--";
            }
        }
        try {
            return DateTimeFormatter.ofPattern("HH:mm:ss", Locale.getDefault())
                    .withZone(ZoneId.systemDefault())
                    .format(Instant.parse(value));
        } catch (DateTimeParseException ignored) {
            // Fall through to the service's shortened timestamp.
        }
        int timeStart = value.indexOf('T');
        if (timeStart >= 0 && value.length() >= timeStart + 9) return value.substring(timeStart + 1, timeStart + 9);
        if (value.length() >= 8 && value.charAt(2) == ':') return value.substring(0, 8);
        return value.length() > 16 ? value.substring(0, 16) : value;
    }

    @Override
    protected void onDestroy() {
        requestSequence++;
        if (updateRequest != null) updateRequest.cancel();
        dashboardExecutor.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
