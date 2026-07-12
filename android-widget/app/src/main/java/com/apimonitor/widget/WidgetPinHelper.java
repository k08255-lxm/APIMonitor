package com.apimonitor.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.widget.Toast;

/** Requests a launcher-managed widget pin after the dashboard connection has been configured. */
final class WidgetPinHelper {
    private WidgetPinHelper() {
    }

    static void requestPin(Activity activity) {
        AppWidgetManager manager = AppWidgetManager.getInstance(activity);
        if (!manager.isRequestPinAppWidgetSupported()) {
            Toast.makeText(activity, R.string.widget_pin_not_supported, Toast.LENGTH_LONG).show();
            return;
        }

        ComponentName provider = new ComponentName(activity, MonitorWidgetProvider.class);
        if (manager.requestPinAppWidget(provider, null, null)) {
            Toast.makeText(activity, R.string.widget_pin_requested, Toast.LENGTH_LONG).show();
        } else {
            Toast.makeText(activity, R.string.widget_pin_not_supported, Toast.LENGTH_LONG).show();
        }
    }
}
