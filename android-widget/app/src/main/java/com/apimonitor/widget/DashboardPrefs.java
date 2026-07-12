package com.apimonitor.widget;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Application-wide monitor connection. Widget instances still retain their own credentials,
 * while this copy lets the native dashboard and newly pinned widgets share a sensible default.
 */
final class DashboardPrefs {
    private static final String PREFS = "dashboard_settings";
    private static final String URL = "url";
    private static final String PASSWORD = "password";
    private static final String RANGE = "range";
    private static final String SOURCE = "source";

    private DashboardPrefs() {
    }

    static final class Config {
        final String baseUrl;
        final String password;
        final String range;
        final String source;

        Config(String baseUrl, String password, String range, String source) {
            this.baseUrl = baseUrl == null ? "" : baseUrl;
            this.password = password == null ? "" : password;
            this.range = validRange(range) ? range : "today";
            this.source = validSource(source) ? source : "auto";
        }

        boolean isConfigured() {
            return !baseUrl.isEmpty();
        }
    }

    static Config load(Context context) {
        SharedPreferences preferences = preferences(context);
        return new Config(
                preferences.getString(URL, ""),
                preferences.getString(PASSWORD, ""),
                preferences.getString(RANGE, "today"),
                preferences.getString(SOURCE, "auto")
        );
    }

    static void saveConnection(Context context, String baseUrl, String password) {
        preferences(context).edit()
                .putString(URL, baseUrl == null ? "" : baseUrl)
                .putString(PASSWORD, password == null ? "" : password)
                .apply();
    }

    static void saveSelection(Context context, String range, String source) {
        preferences(context).edit()
                .putString(RANGE, validRange(range) ? range : "today")
                .putString(SOURCE, validSource(source) ? source : "auto")
                .apply();
    }

    static boolean validRange(String value) {
        return "today".equals(value) || "24h".equals(value) || "7d".equals(value);
    }

    static boolean validSource(String value) {
        return "auto".equals(value)
                || "local".equals(value)
                || "sub2api".equals(value)
                || "cc-switch".equals(value)
                || "all".equals(value);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
