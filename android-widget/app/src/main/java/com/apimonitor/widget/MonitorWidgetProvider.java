package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.BroadcastReceiver.PendingResult;

/** AppWidgetProvider entry point for system updates and the widget refresh button. */
public final class MonitorWidgetProvider extends AppWidgetProvider {
    @Override
    public void onEnabled(Context context) {
        WidgetRefreshScheduler.ensureScheduled(context);
        WidgetRefreshScheduler.requestImmediateRefresh(context);
        super.onEnabled(context);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        WidgetRefreshScheduler.ensureScheduled(context);
        PendingResult pending = goAsync();
        WidgetUpdater.updateAll(context, appWidgetIds, pending::finish);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        for (int widgetId : appWidgetIds) WidgetPrefs.delete(context, widgetId);
        WidgetRefreshScheduler.cancelIfUnused(context);
        super.onDeleted(context, appWidgetIds);
    }

    @Override
    public void onDisabled(Context context) {
        WidgetRefreshScheduler.cancel(context);
        super.onDisabled(context);
    }
}
