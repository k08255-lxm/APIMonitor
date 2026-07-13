package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** Per-widget settings. Values are deliberately scoped by AppWidget id. */
final class WidgetPrefs {
    private static final String PREFS = "widget_settings";
    private static final String URL = "url";
    private static final String PASSWORD = "password";
    private static final String LAST_UPDATED = "last_updated";
    private static final String REFRESH_TOKEN = "refresh_token";

    private WidgetPrefs() {
    }

    static final class Config {
        final String baseUrl;
        final String password;
        final long lastUpdated;
        final String refreshToken;

        Config(String baseUrl, String password, long lastUpdated) {
            this(baseUrl, password, lastUpdated, "");
        }

        Config(String baseUrl, String password, long lastUpdated, String refreshToken) {
            this.baseUrl = baseUrl;
            this.password = password;
            this.lastUpdated = lastUpdated;
            this.refreshToken = refreshToken;
        }

        boolean isConfigured() {
            return !baseUrl.isEmpty();
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String key(int widgetId, String name) {
        return "widget_" + widgetId + "_" + name;
    }

    static Config load(Context context, int widgetId) {
        SharedPreferences prefs = preferences(context);
        return new Config(
                prefs.getString(key(widgetId, URL), ""),
                prefs.getString(key(widgetId, PASSWORD), ""),
                prefs.getLong(key(widgetId, LAST_UPDATED), 0L),
                prefs.getString(key(widgetId, REFRESH_TOKEN), "")
        );
    }

    static void save(Context context, int widgetId, String baseUrl, String password) {
        preferences(context).edit()
                .putString(key(widgetId, URL), baseUrl)
                .putString(key(widgetId, PASSWORD), password)
                .putString(key(widgetId, REFRESH_TOKEN), UUID.randomUUID().toString())
                .remove(key(widgetId, LAST_UPDATED))
                .apply();
    }

    static String refreshToken(Context context, int widgetId) {
        SharedPreferences prefs = preferences(context);
        String token = prefs.getString(key(widgetId, REFRESH_TOKEN), "");
        if (token == null || token.isEmpty()) {
            token = UUID.randomUUID().toString();
            prefs.edit().putString(key(widgetId, REFRESH_TOKEN), token).apply();
        }
        return token;
    }

    static boolean matchesRefreshToken(Context context, int widgetId, String supplied) {
        String expected = preferences(context).getString(key(widgetId, REFRESH_TOKEN), "");
        return expected != null && !expected.isEmpty() && expected.equals(supplied);
    }

    static void markUpdated(Context context, int widgetId, long timestamp) {
        preferences(context).edit().putLong(key(widgetId, LAST_UPDATED), timestamp).apply();
    }

    static void delete(Context context, int widgetId) {
        preferences(context).edit()
                .remove(key(widgetId, URL))
                .remove(key(widgetId, PASSWORD))
                .remove(key(widgetId, REFRESH_TOKEN))
                .remove(key(widgetId, LAST_UPDATED))
                .apply();
    }

    /**
     * Keep widgets that were seeded from the app connection in sync without overwriting an
     * instance that has deliberately been configured with a different monitor endpoint.
     */
    static void syncDashboardBackedWidgets(
            Context context,
            DashboardPrefs.Config previous,
            DashboardPrefs.Config replacement
    ) {
        if (replacement == null || !replacement.isConfigured()) return;
        Context appContext = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(appContext);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(appContext, MonitorWidgetProvider.class));
        for (int widgetId : widgetIds) {
            Config widget = load(appContext, widgetId);
            boolean matchesPrevious = previous != null
                    && previous.isConfigured()
                    && widget.baseUrl.equals(previous.baseUrl)
                    && widget.password.equals(previous.password);
            if (!widget.isConfigured() || matchesPrevious) {
                updateConnection(appContext, widgetId, replacement.baseUrl, replacement.password);
            }
        }
    }

    private static void updateConnection(Context context, int widgetId, String baseUrl, String password) {
        preferences(context).edit()
                .putString(key(widgetId, URL), baseUrl)
                .putString(key(widgetId, PASSWORD), password)
                .remove(key(widgetId, LAST_UPDATED))
                .apply();
    }
}
