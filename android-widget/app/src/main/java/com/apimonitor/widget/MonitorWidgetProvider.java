package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.BroadcastReceiver.PendingResult;

/** AppWidgetProvider entry point for system updates and the widget refresh button. */
public final class MonitorWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        PendingResult pending = goAsync();
        WidgetUpdater.updateAll(context, appWidgetIds, pending::finish);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        for (int widgetId : appWidgetIds) WidgetPrefs.delete(context, widgetId);
        super.onDeleted(context, appWidgetIds);
    }
}
