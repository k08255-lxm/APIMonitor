package com.apimonitor.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** Schedules best-effort network refreshes independently of launcher-specific widget polling. */
final class WidgetRefreshScheduler {
    private static final String PERIODIC_WORK_NAME = "api-monitor-widget-periodic-refresh";
    private static final String IMMEDIATE_WORK_NAME = "api-monitor-widget-immediate-refresh";
    private static final long REFRESH_INTERVAL_MINUTES = 30L;
    private static final long REFRESH_FLEX_MINUTES = 5L;

    private WidgetRefreshScheduler() {
    }

    static void ensureScheduled(Context context) {
        Context appContext = context.getApplicationContext();
        if (widgetIds(appContext).length == 0) {
            cancel(appContext);
            return;
        }
        WorkManager.getInstance(appContext).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodicRequest()
        );
    }

    static void requestImmediateRefresh(Context context) {
        Context appContext = context.getApplicationContext();
        if (widgetIds(appContext).length == 0) {
            cancel(appContext);
            return;
        }
        WorkManager.getInstance(appContext).enqueueUniqueWork(
                IMMEDIATE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                oneTimeRequest()
        );
    }

    static void cancelIfUnused(Context context) {
        if (widgetIds(context.getApplicationContext()).length == 0) cancel(context);
    }

    static void cancel(Context context) {
        WorkManager manager = WorkManager.getInstance(context.getApplicationContext());
        manager.cancelUniqueWork(PERIODIC_WORK_NAME);
        manager.cancelUniqueWork(IMMEDIATE_WORK_NAME);
    }

    static int[] widgetIds(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context.getApplicationContext());
        return manager.getAppWidgetIds(new ComponentName(context, MonitorWidgetProvider.class));
    }

    private static PeriodicWorkRequest periodicRequest() {
        return new PeriodicWorkRequest.Builder(
                WidgetRefreshWorker.class,
                REFRESH_INTERVAL_MINUTES,
                TimeUnit.MINUTES,
                REFRESH_FLEX_MINUTES,
                TimeUnit.MINUTES
        ).setConstraints(networkConstraints()).build();
    }

    private static OneTimeWorkRequest oneTimeRequest() {
        return new OneTimeWorkRequest.Builder(WidgetRefreshWorker.class)
                .setConstraints(networkConstraints())
                .build();
    }

    private static Constraints networkConstraints() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }
}
