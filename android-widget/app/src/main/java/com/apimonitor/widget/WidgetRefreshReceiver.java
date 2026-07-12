package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.BroadcastReceiver.PendingResult;
import android.content.Context;
import android.content.Intent;

/** Private receiver used only by the immutable refresh PendingIntent in each widget. */
public final class WidgetRefreshReceiver extends BroadcastReceiver {
    public static final String ACTION_REFRESH = "com.apimonitor.widget.ACTION_REFRESH";
    public static final String EXTRA_REFRESH_TOKEN = "com.apimonitor.widget.EXTRA_REFRESH_TOKEN";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_REFRESH.equals(intent.getAction())) return;
        if (intent.getComponent() == null
                || !context.getPackageName().equals(intent.getComponent().getPackageName())) {
            return;
        }
        int widgetId = intent.getIntExtra(
                AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID
        );
        String token = intent.getStringExtra(EXTRA_REFRESH_TOKEN);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID
                || !WidgetPrefs.matchesRefreshToken(context, widgetId, token)) {
            return;
        }
        PendingResult pending = goAsync();
        WidgetUpdater.updateForBroadcast(context, widgetId, pending::finish);
    }
}
