package com.apimonitor.widget;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.button.MaterialButtonToggleGroup;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.switchmaterial.SwitchMaterial;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Detailed, authenticated control surface for the Node.js monitor backend. */
public final class BackendManagementActivity extends ComponentActivity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SwipeRefreshLayout swipeRefresh;
    private View statusDot;
    private TextView stateText;
    private TextView addressText;
    private TextView processText;
    private TextView instanceText;
    private TextView startedText;
    private TextView uptimeText;
    private TextView controlsText;
    private TextView messageText;
    private MaterialButton restartButton;
    private MaterialButton stopButton;
    private SwitchMaterial autostartSwitch;
    private TextView autostartDetailText;
    private MaterialButtonToggleGroup autostartModeGroup;
    private MaterialButton autostartAlwaysButton;
    private MaterialButton autostartCcSwitchButton;

    private DashboardClient.BackendStatus backendStatus;
    private DashboardClient.AutostartStatus autostartStatus;
    private boolean loading;
    private boolean actionInFlight;
    private boolean autostartUpdating;
    private boolean applyingAutostart;
    private int requestSequence;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prepareEdgeToEdge();
        setContentView(R.layout.activity_backend_management);
        bindViews();
        applySystemBarInsets();
        bindActions();
        refreshStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (backendStatus != null) refreshStatus();
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
        swipeRefresh = findViewById(R.id.backend_management_root);
        statusDot = findViewById(R.id.backend_management_status_dot);
        stateText = findViewById(R.id.backend_management_state);
        addressText = findViewById(R.id.backend_management_address);
        processText = findViewById(R.id.backend_management_process);
        instanceText = findViewById(R.id.backend_management_instance);
        startedText = findViewById(R.id.backend_management_started);
        uptimeText = findViewById(R.id.backend_management_uptime);
        controlsText = findViewById(R.id.backend_management_controls);
        messageText = findViewById(R.id.backend_management_message);
        restartButton = findViewById(R.id.backend_management_restart);
        stopButton = findViewById(R.id.backend_management_stop);
        autostartSwitch = findViewById(R.id.backend_management_autostart_switch);
        autostartDetailText = findViewById(R.id.backend_management_autostart_detail);
        autostartModeGroup = findViewById(R.id.backend_management_autostart_mode_group);
        autostartAlwaysButton = findViewById(R.id.backend_management_autostart_always);
        autostartCcSwitchButton = findViewById(R.id.backend_management_autostart_cc_switch);
    }

    private void bindActions() {
        findViewById(R.id.backend_management_back).setOnClickListener(view -> finish());
        findViewById(R.id.backend_management_refresh).setOnClickListener(view -> refreshStatus());
        swipeRefresh.setOnRefreshListener(this::refreshStatus);
        restartButton.setOnClickListener(view -> confirmBackendAction("restart"));
        stopButton.setOnClickListener(view -> confirmBackendAction("stop"));
        autostartSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (applyingAutostart || autostartStatus == null || !autostartStatus.supported) return;
            updateAutostart(checked, checked ? selectedAutostartMode() : "always");
        });
        autostartModeGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked || applyingAutostart || autostartStatus == null
                    || !autostartStatus.supported || !autostartStatus.enabled) return;
            String requested = modeForButton(checkedId);
            if (requested != null && !requested.equals(autostartStatus.mode)) {
                updateAutostart(true, requested);
            }
        });
    }

    private void refreshStatus() {
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        if (!config.isConfigured()) {
            swipeRefresh.setRefreshing(false);
            renderNotConfigured();
            return;
        }
        if (loading || actionInFlight || autostartUpdating) {
            swipeRefresh.setRefreshing(false);
            return;
        }
        loading = true;
        swipeRefresh.setRefreshing(true);
        messageText.setVisibility(View.GONE);
        int requestId = ++requestSequence;
        executor.execute(() -> {
            DashboardClient.BackendStatus status = null;
            DashboardClient.AutostartStatus autostart = null;
            Exception backendError = null;
            Exception autostartError = null;
            try {
                status = DashboardClient.fetchBackend(config);
            } catch (Exception error) {
                backendError = error;
            }
            try {
                autostart = DashboardClient.fetchAutostart(config);
            } catch (Exception error) {
                autostartError = error;
            }
            final DashboardClient.BackendStatus finalStatus = status;
            final DashboardClient.AutostartStatus finalAutostart = autostart;
            final Exception finalBackendError = backendError;
            final Exception finalAutostartError = autostartError;
            main.post(() -> {
                if (requestId != requestSequence || isFinishing()) return;
                loading = false;
                swipeRefresh.setRefreshing(false);
                if (finalBackendError == null && finalStatus != null) {
                    renderBackendStatus(finalStatus);
                } else {
                    renderBackendUnavailable();
                }
                if (finalAutostartError == null && finalAutostart != null) {
                    renderAutostart(finalAutostart);
                } else {
                    renderAutostartUnavailable();
                }
            });
        });
    }

    private void renderNotConfigured() {
        backendStatus = null;
        stateText.setText(R.string.backend_management_needs_configuration);
        addressText.setText(R.string.backend_management_no_connection);
        processText.setText("--");
        instanceText.setText("--");
        startedText.setText("--");
        uptimeText.setText("--");
        controlsText.setText(R.string.backend_management_needs_configuration);
        restartButton.setEnabled(false);
        stopButton.setEnabled(false);
        setStatusTone(getColor(R.color.amber));
        renderAutostartUnavailable();
        messageText.setText(R.string.backend_management_connection_required);
        messageText.setVisibility(View.VISIBLE);
    }

    private void renderBackendStatus(DashboardClient.BackendStatus status) {
        backendStatus = status;
        String address = backendAddress(status);
        if ("stopping".equals(status.status)) {
            stateText.setText(R.string.backend_management_stopping);
            setStatusTone(getColor(R.color.amber));
        } else {
            stateText.setText(R.string.backend_management_running);
            setStatusTone(getColor(R.color.green));
        }
        addressText.setText(address);
        processText.setText(emptyValue(status.processId));
        instanceText.setText(emptyValue(status.instanceId));
        startedText.setText(displayDateTime(status.startedAt));
        uptimeText.setText(formatUptime(status.uptimeSeconds));
        controlsText.setText(status.controlsEnabled
                ? getString(R.string.backend_management_controls_available)
                : getString(R.string.backend_management_controls_disabled));
        restartButton.setEnabled(status.canRestart() && !actionInFlight);
        stopButton.setEnabled(status.canStop() && !actionInFlight);
    }

    private void renderBackendUnavailable() {
        backendStatus = null;
        stateText.setText(R.string.backend_management_unavailable);
        addressText.setText(R.string.backend_management_unavailable);
        processText.setText("--");
        instanceText.setText("--");
        startedText.setText("--");
        uptimeText.setText("--");
        controlsText.setText(R.string.backend_management_controls_disabled);
        restartButton.setEnabled(false);
        stopButton.setEnabled(false);
        setStatusTone(getColor(R.color.status_error));
        messageText.setText(R.string.backend_management_status_failed);
        messageText.setVisibility(View.VISIBLE);
    }

    private void renderAutostart(DashboardClient.AutostartStatus status) {
        autostartStatus = status;
        applyingAutostart = true;
        autostartSwitch.setChecked(status.enabled);
        autostartModeGroup.check("cc-switch".equals(status.mode)
                ? R.id.backend_management_autostart_cc_switch
                : R.id.backend_management_autostart_always);
        applyingAutostart = false;
        boolean enabled = status.supported && !autostartUpdating;
        autostartSwitch.setEnabled(enabled);
        setAutostartModeEnabled(enabled && status.enabled);
        if (!status.supported) {
            autostartDetailText.setText(R.string.backend_management_autostart_unsupported);
        } else if (!status.detail.isEmpty()) {
            autostartDetailText.setText(status.detail);
        } else if (status.enabled && "cc-switch".equals(status.mode)) {
            autostartDetailText.setText(R.string.backend_management_autostart_cc_switch_detail);
        } else if (status.enabled) {
            autostartDetailText.setText(R.string.backend_management_autostart_always_detail);
        } else {
            autostartDetailText.setText(R.string.backend_management_autostart_disabled_detail);
        }
    }

    private void renderAutostartUnavailable() {
        autostartStatus = null;
        applyingAutostart = true;
        autostartSwitch.setChecked(false);
        autostartModeGroup.check(R.id.backend_management_autostart_always);
        applyingAutostart = false;
        autostartSwitch.setEnabled(false);
        setAutostartModeEnabled(false);
        autostartDetailText.setText(R.string.backend_management_autostart_unavailable);
    }

    private void setAutostartModeEnabled(boolean enabled) {
        autostartModeGroup.setEnabled(enabled);
        autostartAlwaysButton.setEnabled(enabled);
        autostartCcSwitchButton.setEnabled(enabled);
    }

    private void confirmBackendAction(String action) {
        if (backendStatus == null || actionInFlight) return;
        boolean restart = "restart".equals(action);
        if (restart ? !backendStatus.canRestart() : !backendStatus.canStop()) return;
        new MaterialAlertDialogBuilder(this)
                .setTitle(restart
                        ? R.string.dashboard_backend_restart_confirm_title
                        : R.string.dashboard_backend_stop_confirm_title)
                .setMessage(restart
                        ? R.string.dashboard_backend_restart_confirm_message
                        : R.string.dashboard_backend_stop_confirm_message)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(restart
                        ? R.string.dashboard_backend_restart
                        : R.string.dashboard_backend_stop,
                        (dialog, which) -> runBackendAction(action))
                .show();
    }

    private void runBackendAction(String action) {
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        if (!config.isConfigured()) return;
        actionInFlight = true;
        restartButton.setEnabled(false);
        stopButton.setEnabled(false);
        messageText.setText(getString(
                R.string.dashboard_backend_action_pending,
                "restart".equals(action)
                        ? getString(R.string.dashboard_backend_restart)
                        : getString(R.string.dashboard_backend_stop)
        ));
        messageText.setVisibility(View.VISIBLE);
        executor.execute(() -> {
            try {
                DashboardClient.controlBackend(config, action);
                main.post(() -> {
                    if (isFinishing()) return;
                    actionInFlight = false;
                    if ("restart".equals(action)) {
                        stateText.setText(R.string.backend_management_restarting);
                        setStatusTone(getColor(R.color.amber));
                        main.postDelayed(this::refreshStatus, 2_500L);
                    } else {
                        stateText.setText(R.string.dashboard_backend_stopped);
                        setStatusTone(getColor(R.color.status_error));
                    }
                    restartButton.setEnabled(false);
                    stopButton.setEnabled(false);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (isFinishing()) return;
                    actionInFlight = false;
                    Toast.makeText(this, R.string.dashboard_backend_action_failed, Toast.LENGTH_SHORT).show();
                    refreshStatus();
                });
            }
        });
    }

    private void updateAutostart(boolean enabled, String mode) {
        DashboardPrefs.Config config = DashboardPrefs.load(this);
        if (!config.isConfigured() || autostartUpdating) return;
        autostartUpdating = true;
        autostartSwitch.setEnabled(false);
        setAutostartModeEnabled(false);
        autostartDetailText.setText(R.string.backend_management_autostart_saving);
        executor.execute(() -> {
            try {
                DashboardClient.AutostartStatus status = DashboardClient.updateAutostart(config, enabled, mode);
                main.post(() -> {
                    if (isFinishing()) return;
                    autostartUpdating = false;
                    renderAutostart(status);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (isFinishing()) return;
                    autostartUpdating = false;
                    Toast.makeText(this, R.string.backend_management_autostart_failed, Toast.LENGTH_SHORT).show();
                    if (autostartStatus != null) renderAutostart(autostartStatus);
                    else renderAutostartUnavailable();
                });
            }
        });
    }

    private String selectedAutostartMode() {
        return modeForButton(autostartModeGroup.getCheckedButtonId());
    }

    private String modeForButton(int id) {
        if (id == R.id.backend_management_autostart_cc_switch) return "cc-switch";
        return "always";
    }

    private String backendAddress(DashboardClient.BackendStatus status) {
        String host = status.bindHost == null || status.bindHost.isEmpty()
                ? getString(R.string.dashboard_backend_unknown_address)
                : status.bindHost;
        return status.port > 0 ? host + ":" + status.port : host;
    }

    private String emptyValue(String value) {
        return value == null || value.isEmpty() ? "--" : value;
    }

    private String formatUptime(long seconds) {
        long total = Math.max(0L, seconds);
        if (total < 60L) return getString(R.string.dashboard_backend_uptime_just_started);
        long days = total / 86_400L;
        long hours = (total % 86_400L) / 3_600L;
        long minutes = (total % 3_600L) / 60L;
        if (days > 0L) return getString(R.string.dashboard_backend_uptime_days, days, hours);
        if (hours > 0L) return getString(R.string.dashboard_backend_uptime_hours, hours, minutes);
        return getString(R.string.dashboard_backend_uptime_minutes, minutes);
    }

    private String displayDateTime(String value) {
        if (value == null || value.isEmpty()) return "--";
        try {
            return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
                    .withZone(ZoneId.systemDefault())
                    .format(Instant.parse(value));
        } catch (DateTimeParseException ignored) {
            return value;
        }
    }

    private void setStatusTone(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        statusDot.setBackground(drawable);
        ViewCompat.setBackgroundTintList(statusDot, ColorStateList.valueOf(color));
    }

    @Override
    protected void onDestroy() {
        requestSequence++;
        executor.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
