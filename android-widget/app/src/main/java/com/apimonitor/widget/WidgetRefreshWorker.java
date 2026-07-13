package com.apimonitor.widget;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Runs a bounded all-widget refresh from WorkManager's network-constrained background job. */
public final class WidgetRefreshWorker extends Worker {
    private static final long UPDATE_TIMEOUT_SECONDS = 45L;

    public WidgetRefreshWorker(@NonNull Context appContext, @NonNull WorkerParameters parameters) {
        super(appContext, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        int[] widgetIds = WidgetRefreshScheduler.widgetIds(getApplicationContext());
        if (widgetIds.length == 0) return Result.success();

        CountDownLatch finished = new CountDownLatch(1);
        WidgetUpdater.updateAllForWorker(getApplicationContext(), widgetIds, finished::countDown);
        try {
            return finished.await(UPDATE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                    ? Result.success()
                    : Result.retry();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return Result.retry();
        }
    }
}
