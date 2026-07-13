package com.apimonitor.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.RemoteViews;

import java.text.NumberFormat;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Renders widget data without doing network I/O on the main thread. */
final class WidgetUpdater {
    // Android gives a BroadcastReceiver only a short window after goAsync().
    private static final long BROADCAST_BUDGET_MS = 8_000L;
    private static final int MAX_RECENT_ROWS = 5;
    private static final ExecutorService NETWORK = Executors.newFixedThreadPool(2);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private WidgetUpdater() {
    }

    static void update(Context context, int widgetId) {
        updateAsync(context, widgetId, () -> {
        });
    }

    static void updateAll(Context context, int[] widgetIds, Runnable finished) {
        Runnable boundedFinished = boundedFinish(finished);
        updateAllWithoutBroadcastBudget(context, widgetIds, boundedFinished);
        // A queued widget must not keep the system broadcast open indefinitely.
        MAIN.postDelayed(boundedFinished, BROADCAST_BUDGET_MS);
    }

    /**
     * WorkManager owns a longer background execution window, so it must wait for every widget
     * instead of applying the short BroadcastReceiver watchdog used by {@link #updateAll}.
     */
    static void updateAllForWorker(Context context, int[] widgetIds, Runnable finished) {
        updateAllWithoutBroadcastBudget(context, widgetIds, finished);
    }

    private static void updateAllWithoutBroadcastBudget(Context context, int[] widgetIds, Runnable finished) {
        if (widgetIds == null || widgetIds.length == 0) {
            finished.run();
            return;
        }
        AtomicInteger remaining = new AtomicInteger(widgetIds.length);
        for (int widgetId : widgetIds) {
            updateAsync(context, widgetId, () -> {
                if (remaining.decrementAndGet() == 0) finished.run();
            });
        }
    }

    /** Starts one refresh while guaranteeing that its BroadcastReceiver can finish on time. */
    static void updateForBroadcast(Context context, int widgetId, Runnable finished) {
        Runnable boundedFinished = boundedFinish(finished);
        updateAsync(context, widgetId, boundedFinished);
        // updateAsync normally calls its callback after the request timeout. This second guard
        // covers a stalled DNS/read path and keeps goAsync within Android's broadcast budget.
        MAIN.postDelayed(boundedFinished, BROADCAST_BUDGET_MS);
    }

    private static Runnable boundedFinish(Runnable finished) {
        AtomicBoolean called = new AtomicBoolean();
        return () -> {
            if (called.compareAndSet(false, true)) finished.run();
        };
    }

    static void updateAsync(Context context, int widgetId, Runnable finished) {
        Context appContext = context.getApplicationContext();
        WidgetPrefs.Config config = resolveConfig(appContext, widgetId);
        if (!config.isConfigured()) {
            WidgetPrefs.Config unresolved = config;
            MAIN.post(() -> {
                RemoteViews views = baseViews(appContext, widgetId);
                renderNotConfigured(appContext, views, unresolved);
                AppWidgetManager.getInstance(appContext).updateAppWidget(widgetId, views);
                finished.run();
            });
            return;
        }

        WidgetPrefs.Config requestConfig = config;
        MAIN.post(() -> {
            RemoteViews loading = baseViews(appContext, widgetId);
            renderLoading(appContext, loading, requestConfig);
            AppWidgetManager.getInstance(appContext).updateAppWidget(widgetId, loading);
        });

        NETWORK.execute(() -> {
            DashboardClient.Snapshot snapshot = null;
            try {
                snapshot = DashboardClient.fetch(requestConfig);
            } catch (Exception ignored) {
                // Render a generic error; do not expose endpoint or credential details in the widget.
            }
            DashboardClient.Snapshot result = snapshot;
            MAIN.post(() -> {
                WidgetPrefs.Config current = WidgetPrefs.load(appContext, widgetId);
                if (!current.isConfigured()
                        || !current.baseUrl.equals(requestConfig.baseUrl)
                        || !current.password.equals(requestConfig.password)) {
                    finished.run();
                    return;
                }
                RemoteViews views = baseViews(appContext, widgetId);
                if (result != null) {
                    WidgetPrefs.markUpdated(appContext, widgetId, System.currentTimeMillis());
                    renderSuccess(appContext, views, result);
                } else {
                    renderError(appContext, views, current);
                }
                AppWidgetManager.getInstance(appContext).updateAppWidget(widgetId, views);
                finished.run();
            });
        });
    }

    /**
     * Pinning a widget from the app does not give us a configuration Activity result. Seed it from
     * the app dashboard once, while retaining per-widget settings for later edits.
     */
    private static WidgetPrefs.Config resolveConfig(Context context, int widgetId) {
        WidgetPrefs.Config widgetConfig = WidgetPrefs.load(context, widgetId);
        if (widgetConfig.isConfigured()) return widgetConfig;
        DashboardPrefs.Config dashboardConfig = DashboardPrefs.load(context);
        if (!dashboardConfig.isConfigured()) return widgetConfig;
        WidgetPrefs.save(context, widgetId, dashboardConfig.baseUrl, dashboardConfig.password);
        return WidgetPrefs.load(context, widgetId);
    }

    private static RemoteViews baseViews(Context context, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_dashboard);
        attachActions(context, views, widgetId);
        return views;
    }

    private static void attachActions(Context context, RemoteViews views, int widgetId) {
        Intent refresh = new Intent(context, WidgetRefreshReceiver.class)
                .setAction(WidgetRefreshReceiver.ACTION_REFRESH)
                .setPackage(context.getPackageName())
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra(WidgetRefreshReceiver.EXTRA_REFRESH_TOKEN, WidgetPrefs.refreshToken(context, widgetId));
        PendingIntent refreshPending = PendingIntent.getBroadcast(
                context, requestCode(widgetId, 1), refresh,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshPending);
        views.setOnClickPendingIntent(R.id.widget_error, refreshPending);

        // This is explicitly MainActivity, rather than an ACTION_VIEW URL, so a widget tap stays
        // inside the native Material dashboard and never opens a browser.
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(
                context, requestCode(widgetId, 2), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        int[] openTargets = {
                R.id.widget_root, R.id.widget_title, R.id.widget_status, R.id.widget_last_updated,
                R.id.widget_loading, R.id.widget_content, R.id.widget_recent_empty,
                R.id.widget_recent_rows, R.id.widget_recent_row_1, R.id.widget_recent_row_2,
                R.id.widget_recent_row_3, R.id.widget_recent_row_4, R.id.widget_recent_row_5
        };
        for (int id : openTargets) views.setOnClickPendingIntent(id, openPending);
    }

    private static int requestCode(int widgetId, int action) {
        return widgetId * 31 + action;
    }

    private static void renderNotConfigured(Context context, RemoteViews views, WidgetPrefs.Config config) {
        views.setViewVisibility(R.id.widget_loading, View.GONE);
        views.setViewVisibility(R.id.widget_error, View.GONE);
        views.setViewVisibility(R.id.widget_content, View.VISIBLE);
        views.setTextViewText(R.id.widget_status, context.getString(R.string.widget_status_needs_setup));
        views.setTextViewText(R.id.widget_last_updated, lastUpdatedText(context, config.lastUpdated));
        setValuesToPlaceholder(views);
    }

    private static void renderLoading(Context context, RemoteViews views, WidgetPrefs.Config config) {
        views.setViewVisibility(R.id.widget_loading, View.VISIBLE);
        views.setViewVisibility(R.id.widget_error, View.GONE);
        views.setViewVisibility(R.id.widget_content, View.VISIBLE);
        views.setTextViewText(R.id.widget_status, context.getString(R.string.widget_status_loading));
        views.setTextViewText(R.id.widget_last_updated, lastUpdatedText(context, config.lastUpdated));
        setValuesToPlaceholder(views);
    }

    private static void renderError(Context context, RemoteViews views, WidgetPrefs.Config config) {
        views.setViewVisibility(R.id.widget_loading, View.GONE);
        views.setViewVisibility(R.id.widget_error, View.VISIBLE);
        views.setViewVisibility(R.id.widget_content, View.GONE);
        views.setTextViewText(R.id.widget_status, context.getString(R.string.widget_status_error));
        views.setTextViewText(R.id.widget_error, context.getString(R.string.widget_error));
        views.setTextViewText(R.id.widget_last_updated, lastUpdatedText(context, config.lastUpdated));
    }

    private static void renderSuccess(Context context, RemoteViews views, DashboardClient.Snapshot snapshot) {
        views.setViewVisibility(R.id.widget_loading, View.GONE);
        views.setViewVisibility(R.id.widget_error, View.GONE);
        views.setViewVisibility(R.id.widget_content, View.VISIBLE);
        views.setTextViewText(
                R.id.widget_status,
                context.getString(R.string.widget_status_service, serviceValue(snapshot))
        );
        views.setTextViewText(
                R.id.widget_last_updated,
                context.getString(R.string.widget_last_updated_format, displayTime(snapshot.generatedAt))
        );
        views.setTextViewText(R.id.widget_tokens, compact(snapshot.tokens));
        views.setTextViewText(R.id.widget_cost, money(snapshot.cost));
        views.setTextViewText(R.id.widget_cost_short, money(snapshot.cost));
        views.setTextViewText(R.id.widget_requests, compact(snapshot.requests));
        views.setTextViewText(R.id.widget_latency, latency(snapshot.avgLatencyMs));
        views.setTextViewText(R.id.widget_rpm, compact(snapshot.rpm));
        views.setTextViewText(R.id.widget_tpm, compact(snapshot.tpm));
        views.setTextViewText(R.id.widget_success, rate(snapshot.successRate));
        views.setTextViewText(R.id.widget_keys, compact(snapshot.activeKeys));
        views.setTextViewText(R.id.widget_service, serviceValue(snapshot));
        views.setTextViewText(R.id.widget_lifetime_tokens, compact(snapshot.lifetimeTokens));
        views.setTextViewText(R.id.widget_lifetime_requests, compact(snapshot.lifetimeRequests));
        views.setTextViewText(R.id.widget_lifetime_cost, money(snapshot.lifetimeCost));
        renderTopModel(context, views, snapshot.models);
        renderRecent(context, views, snapshot.recent);
    }

    private static void setValuesToPlaceholder(RemoteViews views) {
        int[] ids = {
                R.id.widget_tokens, R.id.widget_cost, R.id.widget_cost_short, R.id.widget_requests,
                R.id.widget_latency, R.id.widget_rpm, R.id.widget_tpm, R.id.widget_success,
                R.id.widget_keys, R.id.widget_service, R.id.widget_model_name, R.id.widget_model_detail,
                R.id.widget_lifetime_tokens, R.id.widget_lifetime_requests, R.id.widget_lifetime_cost
        };
        for (int id : ids) views.setTextViewText(id, "--");
        views.setViewVisibility(R.id.widget_recent_rows, View.GONE);
        views.setViewVisibility(R.id.widget_recent_empty, View.VISIBLE);
        for (int index = 1; index <= MAX_RECENT_ROWS; index++) {
            views.setViewVisibility(recentRowId(index), View.GONE);
        }
    }

    private static void renderTopModel(
            Context context,
            RemoteViews views,
            List<DashboardClient.Model> models
    ) {
        if (models == null || models.isEmpty()) {
            views.setTextViewText(R.id.widget_model_name, "--");
            views.setTextViewText(R.id.widget_model_detail, "--");
            return;
        }
        DashboardClient.Model model = models.get(0);
        views.setTextViewText(R.id.widget_model_name, textOrPlaceholder(model.model));
        views.setTextViewText(
                R.id.widget_model_detail,
                context.getString(
                        R.string.widget_model_detail_format,
                        compact(model.tokens),
                        money(model.cost)
                )
        );
    }

    private static void renderRecent(
            Context context,
            RemoteViews views,
            List<DashboardClient.Recent> recent
    ) {
        boolean hasRecent = recent != null && !recent.isEmpty();
        views.setViewVisibility(R.id.widget_recent_rows, hasRecent ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_recent_empty, hasRecent ? View.GONE : View.VISIBLE);
        for (int index = 1; index <= MAX_RECENT_ROWS; index++) {
            int rowId = recentRowId(index);
            if (hasRecent && index <= recent.size()) {
                DashboardClient.Recent item = recent.get(index - 1);
                views.setViewVisibility(rowId, View.VISIBLE);
                views.setTextViewText(recentId(index, 1), displayTime(item.timestamp));
                views.setTextViewText(
                        recentId(index, 2),
                        context.getString(
                                R.string.widget_recent_label_format,
                                textOrPlaceholder(item.project),
                                textOrPlaceholder(item.model)
                        )
                );
                views.setTextViewText(
                        recentId(index, 3),
                        context.getString(
                                R.string.widget_recent_detail_format,
                                compact(item.tokens),
                                latency(item.latencyMs)
                        )
                );
                views.setTextViewText(recentId(index, 4), money(item.cost));
            } else {
                views.setViewVisibility(rowId, View.GONE);
            }
        }
    }

    private static int recentRowId(int index) {
        switch (index) {
            case 1:
                return R.id.widget_recent_row_1;
            case 2:
                return R.id.widget_recent_row_2;
            case 3:
                return R.id.widget_recent_row_3;
            case 4:
                return R.id.widget_recent_row_4;
            default:
                return R.id.widget_recent_row_5;
        }
    }

    private static int recentId(int row, int part) {
        switch (row) {
            case 1:
                return recent1Id(part);
            case 2:
                return recent2Id(part);
            case 3:
                return recent3Id(part);
            case 4:
                return recent4Id(part);
            default:
                return recent5Id(part);
        }
    }

    private static int recent1Id(int part) {
        switch (part) {
            case 1:
                return R.id.widget_recent_1_time;
            case 2:
                return R.id.widget_recent_1_label;
            case 3:
                return R.id.widget_recent_1_detail;
            default:
                return R.id.widget_recent_1_cost;
        }
    }

    private static int recent2Id(int part) {
        switch (part) {
            case 1:
                return R.id.widget_recent_2_time;
            case 2:
                return R.id.widget_recent_2_label;
            case 3:
                return R.id.widget_recent_2_detail;
            default:
                return R.id.widget_recent_2_cost;
        }
    }

    private static int recent3Id(int part) {
        switch (part) {
            case 1:
                return R.id.widget_recent_3_time;
            case 2:
                return R.id.widget_recent_3_label;
            case 3:
                return R.id.widget_recent_3_detail;
            default:
                return R.id.widget_recent_3_cost;
        }
    }

    private static int recent4Id(int part) {
        switch (part) {
            case 1:
                return R.id.widget_recent_4_time;
            case 2:
                return R.id.widget_recent_4_label;
            case 3:
                return R.id.widget_recent_4_detail;
            default:
                return R.id.widget_recent_4_cost;
        }
    }

    private static int recent5Id(int part) {
        switch (part) {
            case 1:
                return R.id.widget_recent_5_time;
            case 2:
                return R.id.widget_recent_5_label;
            case 3:
                return R.id.widget_recent_5_detail;
            default:
                return R.id.widget_recent_5_cost;
        }
    }

    private static String serviceValue(DashboardClient.Snapshot snapshot) {
        if (snapshot.servicesTotal <= 0) return "--";
        return snapshot.servicesHealthy + "/" + snapshot.servicesTotal;
    }

    private static String lastUpdatedText(Context context, long timestamp) {
        if (timestamp <= 0) return context.getString(R.string.widget_not_updated);
        return context.getString(
                R.string.widget_previous_updated_format,
                displayTime(String.valueOf(timestamp))
        );
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
            // Fall back to the server's short label below.
        }
        int timeStart = value.indexOf('T');
        if (timeStart >= 0 && value.length() >= timeStart + 9) {
            return value.substring(timeStart + 1, timeStart + 9);
        }
        if (value.length() >= 8 && value.charAt(2) == ':') return value.substring(0, 8);
        return value.length() > 16 ? value.substring(0, 16) : value;
    }

    private static String compact(long value) {
        double number = value;
        String suffix = "";
        if (number >= 1_000_000_000_000d) {
            number /= 1_000_000_000_000d;
            suffix = "T";
        } else if (number >= 1_000_000_000d) {
            number /= 1_000_000_000d;
            suffix = "B";
        } else if (number >= 1_000_000d) {
            number /= 1_000_000d;
            suffix = "M";
        } else if (number >= 1_000d) {
            number /= 1_000d;
            suffix = "K";
        }
        if (suffix.isEmpty()) return NumberFormat.getIntegerInstance(Locale.getDefault()).format(value);
        return String.format(Locale.getDefault(), "%.1f%s", number, suffix);
    }

    private static String money(double value) {
        double absolute = Math.abs(value);
        if (absolute >= 1_000_000d) return String.format(Locale.US, "$%.1fM", value / 1_000_000d);
        if (absolute >= 1_000d) return String.format(Locale.US, "$%.1fK", value / 1_000d);
        return String.format(Locale.US, "$%.2f", value);
    }

    private static String latency(long value) {
        return value >= 1_000
                ? String.format(Locale.getDefault(), "%.1fs", value / 1_000d)
                : value + "ms";
    }

    private static String rate(double value) {
        return String.format(Locale.getDefault(), "%.1f%%", value);
    }

    private static String textOrPlaceholder(String value) {
        return value == null || value.trim().isEmpty() ? "--" : value;
    }
}
