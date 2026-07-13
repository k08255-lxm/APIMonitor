package com.apimonitor.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores periodic refreshes for widgets that already existed before an APK upgrade. */
public final class WidgetRefreshScheduleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        WidgetRefreshScheduler.ensureScheduled(context);
        WidgetRefreshScheduler.requestImmediateRefresh(context);
    }
}
