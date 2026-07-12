package com.apimonitor.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Compact horizontal bar chart for the dashboard's model ranking. */
public final class ModelBarChartView extends View {
    private static final int[] BAR_COLORS = {
            R.color.teal, R.color.blue, R.color.green, R.color.amber, R.color.md_tertiary
    };

    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint valuePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint barPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint emptyPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private List<DashboardClient.Model> models = Collections.emptyList();
    private boolean preciseNumbers;

    public ModelBarChartView(Context context) {
        this(context, null);
    }

    public ModelBarChartView(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public ModelBarChartView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        labelPaint.setColor(context.getColor(R.color.ink));
        labelPaint.setTextSize(dp(14));
        valuePaint.setColor(context.getColor(R.color.muted));
        valuePaint.setTextSize(dp(12));
        valuePaint.setTextAlign(Paint.Align.RIGHT);
        trackPaint.setColor(context.getColor(R.color.line));
        emptyPaint.setColor(context.getColor(R.color.muted));
        emptyPaint.setTextSize(dp(14));
        setMinimumHeight(dp(68));
        setContentDescription(context.getString(R.string.dashboard_models_title));
    }

    void setModels(List<DashboardClient.Model> values, boolean showPreciseNumbers) {
        models = values == null ? Collections.emptyList() : new ArrayList<>(values);
        preciseNumbers = showPreciseNumbers;
        requestLayout();
        invalidate();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int visibleRows = Math.max(1, models.size());
        int wantedHeight = getPaddingTop() + getPaddingBottom() + visibleRows * dp(52);
        int wantedWidth = getPaddingLeft() + getPaddingRight() + dp(180);
        setMeasuredDimension(
                resolveSize(wantedWidth, widthMeasureSpec),
                resolveSize(wantedHeight, heightMeasureSpec)
        );
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float left = getPaddingLeft();
        float right = getWidth() - getPaddingRight();
        float top = getPaddingTop();
        float bottom = getHeight() - getPaddingBottom();
        if (right <= left || bottom <= top) return;

        if (models.isEmpty()) {
            Paint.FontMetrics metrics = emptyPaint.getFontMetrics();
            float baseline = (top + bottom - metrics.top - metrics.bottom) / 2f;
            canvas.drawText(getContext().getString(R.string.dashboard_no_models), left, baseline, emptyPaint);
            return;
        }

        long maximum = 1L;
        for (DashboardClient.Model model : models) maximum = Math.max(maximum, model.tokens);
        float rowHeight = (bottom - top) / models.size();
        float radius = dp(4);
        for (int index = 0; index < models.size(); index++) {
            DashboardClient.Model model = models.get(index);
            float rowTop = top + index * rowHeight;
            float labelBaseline = rowTop + dp(15);
            String value = number(model.tokens);
            float valueWidth = valuePaint.measureText(value);
            float labelRight = Math.max(left, right - valueWidth - dp(12));
            String label = ellipsize(model.model, labelPaint, Math.max(0f, labelRight - left));
            canvas.drawText(label, left, labelBaseline, labelPaint);
            canvas.drawText(value, right, labelBaseline, valuePaint);

            float barTop = rowTop + dp(25);
            float barBottom = Math.min(bottom, barTop + dp(12));
            RectF track = new RectF(left, barTop, right, barBottom);
            canvas.drawRoundRect(track, radius, radius, trackPaint);
            float ratio = Math.max(0f, Math.min(1f, (float) model.tokens / (float) maximum));
            RectF bar = new RectF(left, barTop, left + (right - left) * ratio, barBottom);
            barPaint.setColor(getContext().getColor(BAR_COLORS[index % BAR_COLORS.length]));
            canvas.drawRoundRect(bar, radius, radius, barPaint);
        }
    }

    private String ellipsize(String value, Paint paint, float maxWidth) {
        String source = value == null || value.isEmpty() ? "unknown" : value;
        if (paint.measureText(source) <= maxWidth) return source;
        String suffix = "...";
        float available = Math.max(0f, maxWidth - paint.measureText(suffix));
        int count = paint.breakText(source, true, available, null);
        return count <= 0 ? suffix : source.substring(0, count) + suffix;
    }

    private String number(long value) {
        if (preciseNumbers) return NumberFormat.getIntegerInstance(Locale.getDefault()).format(value);
        double number = value;
        String suffix = "";
        if (number >= 1_000_000_000_000d) { number /= 1_000_000_000_000d; suffix = "T"; }
        else if (number >= 1_000_000_000d) { number /= 1_000_000_000d; suffix = "B"; }
        else if (number >= 1_000_000d) { number /= 1_000_000d; suffix = "M"; }
        else if (number >= 1_000d) { number /= 1_000d; suffix = "K"; }
        if (suffix.isEmpty()) return NumberFormat.getIntegerInstance(Locale.getDefault()).format(value);
        return String.format(Locale.getDefault(), "%.1f%s", number, suffix);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
