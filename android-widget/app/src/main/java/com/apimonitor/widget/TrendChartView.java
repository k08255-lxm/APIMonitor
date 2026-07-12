package com.apimonitor.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Small dependency-free line chart for the dashboard's token and request timeline. */
public final class TrendChartView extends View {
    interface OnPointSelectedListener {
        void onPointSelected(DashboardClient.TimelinePoint point, boolean requestsMode);
    }

    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint linePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pointPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint selectionPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint selectionFillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tooltipPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tooltipTextPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint emptyPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private List<DashboardClient.TimelinePoint> points = Collections.emptyList();
    private boolean requestsMode;
    private int selectedIndex = -1;
    private OnPointSelectedListener pointSelectedListener;

    public TrendChartView(Context context) {
        this(context, null);
    }

    public TrendChartView(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public TrendChartView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        gridPaint.setColor(context.getColor(R.color.line));
        gridPaint.setStrokeWidth(dp(1));
        linePaint.setColor(context.getColor(R.color.teal));
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setStrokeWidth(dp(3));
        linePaint.setStrokeCap(Paint.Cap.ROUND);
        linePaint.setStrokeJoin(Paint.Join.ROUND);
        pointPaint.setColor(context.getColor(R.color.teal));
        selectionPaint.setColor(context.getColor(R.color.md_primary));
        selectionPaint.setStrokeWidth(dp(1));
        selectionFillPaint.setColor(context.getColor(R.color.md_primary));
        tooltipPaint.setColor(context.getColor(R.color.md_primary_container));
        tooltipTextPaint.setColor(context.getColor(R.color.md_on_primary_container));
        tooltipTextPaint.setTextSize(dp(11));
        emptyPaint.setColor(context.getColor(R.color.muted));
        emptyPaint.setTextSize(dp(13));
        setMinimumHeight(dp(144));
        setContentDescription(context.getString(R.string.dashboard_trend_title));
    }

    void setTrend(List<DashboardClient.TimelinePoint> timeline, boolean showRequests) {
        points = timeline == null ? Collections.emptyList() : new ArrayList<>(timeline);
        requestsMode = showRequests;
        selectedIndex = points.isEmpty() ? -1 : points.size() - 1;
        notifyPointSelected();
        invalidate();
    }

    void setOnPointSelectedListener(OnPointSelectedListener listener) {
        pointSelectedListener = listener;
        notifyPointSelected();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float left = getPaddingLeft() + dp(4);
        float right = getWidth() - getPaddingRight() - dp(4);
        float top = getPaddingTop() + dp(8);
        float bottom = getHeight() - getPaddingBottom() - dp(8);
        if (right <= left || bottom <= top) return;

        long maximum = 0;
        for (DashboardClient.TimelinePoint point : points) {
            maximum = Math.max(maximum, valueOf(point));
        }
        if (points.isEmpty() || maximum <= 0) {
            String text = getContext().getString(R.string.dashboard_no_trend);
            Paint.FontMetrics metrics = emptyPaint.getFontMetrics();
            float baseline = (top + bottom - metrics.top - metrics.bottom) / 2f;
            canvas.drawText(text, left, baseline, emptyPaint);
            return;
        }

        for (int line = 1; line <= 3; line++) {
            float y = top + ((bottom - top) * line / 4f);
            canvas.drawLine(left, y, right, y, gridPaint);
        }

        Path path = new Path();
        for (int index = 0; index < points.size(); index++) {
            float x = points.size() == 1
                    ? (left + right) / 2f
                    : left + ((right - left) * index / (points.size() - 1f));
            float y = bottom - ((bottom - top) * valueOf(points.get(index)) / maximum);
            if (index == 0) path.moveTo(x, y);
            else path.lineTo(x, y);
        }
        canvas.drawPath(path, linePaint);

        // Dense seven-day timelines stay legible as a line; short ranges retain touch-friendly points.
        if (points.size() <= 32) {
            for (int index = 0; index < points.size(); index++) {
                float x = points.size() == 1
                        ? (left + right) / 2f
                        : left + ((right - left) * index / (points.size() - 1f));
                float y = bottom - ((bottom - top) * valueOf(points.get(index)) / maximum);
                canvas.drawCircle(x, y, dp(3), pointPaint);
            }
        }

        drawSelection(canvas, left, right, top, bottom, maximum);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (points.isEmpty()) return super.onTouchEvent(event);
        if (event.getAction() == MotionEvent.ACTION_DOWN) return true;
        if (event.getAction() == MotionEvent.ACTION_UP) {
            selectNearestPoint(event.getX());
            performClick();
            return true;
        }
        return true;
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }

    private void selectNearestPoint(float touchX) {
        if (points.size() == 1) {
            selectedIndex = 0;
        } else {
            float left = getPaddingLeft() + dp(4);
            float right = getWidth() - getPaddingRight() - dp(4);
            float ratio = right <= left ? 0f : (touchX - left) / (right - left);
            int candidate = Math.round(ratio * (points.size() - 1));
            selectedIndex = Math.max(0, Math.min(points.size() - 1, candidate));
        }
        notifyPointSelected();
        invalidate();
    }

    private void drawSelection(
            Canvas canvas,
            float left,
            float right,
            float top,
            float bottom,
            long maximum
    ) {
        if (selectedIndex < 0 || selectedIndex >= points.size()) return;
        DashboardClient.TimelinePoint point = points.get(selectedIndex);
        float x = points.size() == 1
                ? (left + right) / 2f
                : left + ((right - left) * selectedIndex / (points.size() - 1f));
        float y = bottom - ((bottom - top) * valueOf(point) / maximum);
        canvas.drawLine(x, top, x, bottom, selectionPaint);
        canvas.drawCircle(x, y, dp(6), selectionFillPaint);
        canvas.drawCircle(x, y, dp(3), tooltipPaint);

        String label = point.label == null || point.label.isEmpty() ? "--" : point.label;
        String value = exactNumber(valueOf(point)) + (requestsMode ? " req" : " Token");
        String text = label + "  " + value;
        float padding = dp(7);
        float height = dp(24);
        float width = Math.min(right - left, tooltipTextPaint.measureText(text) + padding * 2);
        float bubbleLeft = Math.max(left, Math.min(x - width / 2f, right - width));
        float bubbleTop = y < top + height + dp(8) ? y + dp(8) : y - height - dp(8);
        RectF bubble = new RectF(bubbleLeft, bubbleTop, bubbleLeft + width, bubbleTop + height);
        canvas.drawRoundRect(bubble, dp(12), dp(12), tooltipPaint);
        Paint.FontMetrics metrics = tooltipTextPaint.getFontMetrics();
        float baseline = bubble.centerY() - (metrics.ascent + metrics.descent) / 2f;
        canvas.save();
        canvas.clipRect(bubble.left + padding, bubble.top, bubble.right - padding, bubble.bottom);
        canvas.drawText(text, bubble.left + padding, baseline, tooltipTextPaint);
        canvas.restore();
    }

    private void notifyPointSelected() {
        if (pointSelectedListener != null && selectedIndex >= 0 && selectedIndex < points.size()) {
            pointSelectedListener.onPointSelected(points.get(selectedIndex), requestsMode);
        }
    }

    private long valueOf(DashboardClient.TimelinePoint point) {
        return requestsMode ? point.requests : point.tokens;
    }

    private String exactNumber(long value) {
        return java.text.NumberFormat.getIntegerInstance().format(value);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
