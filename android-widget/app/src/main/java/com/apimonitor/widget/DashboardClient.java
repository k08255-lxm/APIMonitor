package com.apimonitor.widget;

import android.net.Uri;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Small bounded client for the monitor's read-only dashboard endpoint. */
public final class DashboardClient {
    // Keep a widget broadcast inside Android's short goAsync budget.
    private static final int CONNECT_TIMEOUT_MS = 3_000;
    private static final int READ_TIMEOUT_MS = 5_000;
    private static final long REQUEST_DEADLINE_MS = 7_000L;
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final int MAX_RECENT = 5;
    private static final int MAX_MODELS = 5;

    private DashboardClient() {
    }

    /** Compatibility entry point used by the home-screen widget. */
    static Snapshot fetch(WidgetPrefs.Config config) throws IOException {
        if (config == null || !config.isConfigured()) throw new IOException("Widget is not configured");
        return fetch(config.baseUrl, config.password, "today", "auto");
    }

    static Snapshot fetch(DashboardPrefs.Config config, String range, String source) throws IOException {
        if (config == null || !config.isConfigured()) throw new IOException("Dashboard is not configured");
        return fetch(config.baseUrl, config.password, range, source);
    }

    /** Public form for code that already owns a validated monitor origin. */
    public static Snapshot fetch(String baseUrl, String password, String range, String source) throws IOException {
        if (baseUrl == null || baseUrl.trim().isEmpty()) throw new IOException("Dashboard is not configured");
        String safeRange = DashboardPrefs.validRange(range) ? range : "today";
        String safeSource = DashboardPrefs.validSource(source) ? source : "auto";
        URL endpoint = new URL(baseUrl + "/api/dashboard?range=" + Uri.encode(safeRange)
                + "&source=" + Uri.encode(safeSource));
        HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");
        if (password != null && !password.isEmpty()) {
            String credentials = "monitor:" + password;
            String encoded = Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            connection.setRequestProperty("Authorization", "Basic " + encoded);
        }

        long deadlineNanos = System.nanoTime() + REQUEST_DEADLINE_MS * 1_000_000L;
        try {
            int responseCode = connection.getResponseCode();
            if (System.nanoTime() - deadlineNanos >= 0) {
                throw new SocketTimeoutException("Dashboard request timed out");
            }
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("Dashboard returned HTTP " + responseCode);
            }
            try (InputStream input = connection.getInputStream()) {
                String body = readLimited(input, deadlineNanos);
                return Snapshot.fromJson(new JSONObject(body));
            } catch (org.json.JSONException error) {
                throw new IOException("Dashboard response was not valid JSON", error);
            }
        } finally {
            connection.disconnect();
        }
    }

    static BackendStatus fetchBackend(DashboardPrefs.Config config) throws IOException {
        if (config == null || !config.isConfigured()) throw new IOException("Dashboard is not configured");
        return fetchBackend(config.baseUrl, config.password);
    }

    static BackendStatus fetchBackend(String baseUrl, String password) throws IOException {
        if (baseUrl == null || baseUrl.trim().isEmpty()) throw new IOException("Dashboard is not configured");
        URL endpoint = new URL(baseUrl + "/api/backend");
        HttpURLConnection connection = openJsonConnection(endpoint, "GET", password);
        long deadlineNanos = System.nanoTime() + REQUEST_DEADLINE_MS * 1_000_000L;
        try {
            int responseCode = connection.getResponseCode();
            if (System.nanoTime() - deadlineNanos >= 0) {
                throw new SocketTimeoutException("Backend status request timed out");
            }
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("Backend returned HTTP " + responseCode);
            }
            try (InputStream input = connection.getInputStream()) {
                return BackendStatus.fromJson(new JSONObject(readLimited(input, deadlineNanos)));
            } catch (org.json.JSONException error) {
                throw new IOException("Backend response was not valid JSON", error);
            }
        } finally {
            connection.disconnect();
        }
    }

    static void controlBackend(DashboardPrefs.Config config, String action) throws IOException {
        if (config == null || !config.isConfigured()) throw new IOException("Dashboard is not configured");
        if (!"restart".equals(action) && !"stop".equals(action)) {
            throw new IOException("Unsupported backend action");
        }

        URL endpoint = new URL(config.baseUrl + "/api/backend");
        HttpURLConnection connection = openJsonConnection(endpoint, "POST", config.password);
        byte[] requestBody = ("{\"action\":\"" + action + "\"}").getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(requestBody.length);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        long deadlineNanos = System.nanoTime() + REQUEST_DEADLINE_MS * 1_000_000L;
        try {
            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBody);
            }
            int responseCode = connection.getResponseCode();
            if (System.nanoTime() - deadlineNanos >= 0) {
                throw new SocketTimeoutException("Backend control request timed out");
            }
            if (responseCode != HttpURLConnection.HTTP_ACCEPTED) {
                throw new IOException("Backend control returned HTTP " + responseCode);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection openJsonConnection(URL endpoint, String method, String password) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");
        if (password != null && !password.isEmpty()) {
            String credentials = "monitor:" + password;
            String encoded = Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            connection.setRequestProperty("Authorization", "Basic " + encoded);
        }
        return connection;
    }

    private static String readLimited(InputStream input, long deadlineNanos) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8_192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (System.nanoTime() - deadlineNanos >= 0) {
                throw new SocketTimeoutException("Dashboard response timed out");
            }
            total += read;
            if (total > MAX_RESPONSE_BYTES) throw new IOException("Dashboard response is too large");
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    public static final class Snapshot {
        public final String generatedAt;
        public final String range;
        public final String activeSource;
        public final long tokens;
        public final double cost;
        public final long requests;
        public final long avgLatencyMs;
        public final long rpm;
        public final long tpm;
        public final double successRate;
        public final long servicesHealthy;
        public final long servicesTotal;
        public final long activeKeys;
        public final long lifetimeTokens;
        public final double lifetimeCost;
        public final long lifetimeRequests;
        public final List<Recent> recent;
        public final List<Model> models;
        public final List<TimelinePoint> timeline;

        Snapshot(String generatedAt, String range, String activeSource, long tokens, double cost,
                 long requests, long avgLatencyMs, long rpm, long tpm, double successRate,
                 long servicesHealthy, long servicesTotal, long activeKeys, long lifetimeTokens,
                 double lifetimeCost, long lifetimeRequests, List<Recent> recent, List<Model> models,
                 List<TimelinePoint> timeline) {
            this.generatedAt = generatedAt;
            this.range = range;
            this.activeSource = activeSource;
            this.tokens = tokens;
            this.cost = cost;
            this.requests = requests;
            this.avgLatencyMs = avgLatencyMs;
            this.rpm = rpm;
            this.tpm = tpm;
            this.successRate = successRate;
            this.servicesHealthy = servicesHealthy;
            this.servicesTotal = servicesTotal;
            this.activeKeys = activeKeys;
            this.lifetimeTokens = lifetimeTokens;
            this.lifetimeCost = lifetimeCost;
            this.lifetimeRequests = lifetimeRequests;
            this.recent = Collections.unmodifiableList(new ArrayList<>(recent));
            this.models = Collections.unmodifiableList(new ArrayList<>(models));
            this.timeline = Collections.unmodifiableList(new ArrayList<>(timeline));
        }

        static Snapshot fromJson(JSONObject root) {
            JSONObject summary = root.optJSONObject("summary");
            if (summary == null) summary = new JSONObject();
            JSONObject lifetime = root.optJSONObject("lifetime");
            if (lifetime == null) lifetime = new JSONObject();

            List<Recent> recent = new ArrayList<>();
            JSONArray recentArray = root.optJSONArray("recent");
            if (recentArray != null) {
                for (int index = 0; index < Math.min(recentArray.length(), MAX_RECENT); index++) {
                    JSONObject row = recentArray.optJSONObject(index);
                    if (row != null) recent.add(Recent.fromJson(row));
                }
            }

            List<Model> models = new ArrayList<>();
            JSONArray modelArray = root.optJSONArray("models");
            if (modelArray != null) {
                for (int index = 0; index < Math.min(modelArray.length(), MAX_MODELS); index++) {
                    JSONObject row = modelArray.optJSONObject(index);
                    if (row != null) models.add(Model.fromJson(row));
                }
            }

            List<TimelinePoint> timeline = new ArrayList<>();
            JSONArray timelineArray = root.optJSONArray("timeline");
            if (timelineArray != null) {
                for (int index = 0; index < timelineArray.length(); index++) {
                    JSONObject row = timelineArray.optJSONObject(index);
                    if (row != null) timeline.add(TimelinePoint.fromJson(row));
                }
            }

            return new Snapshot(
                    firstString(root, "generatedAt"),
                    firstString(root, "range"),
                    firstString(root, "activeSource"),
                    nonNegativeLong(summary, "tokens"),
                    nonNegativeDouble(summary, "cost"),
                    nonNegativeLong(summary, "requests"),
                    nonNegativeLong(summary, "avgLatencyMs"),
                    nonNegativeLong(summary, "rpm"),
                    nonNegativeLong(summary, "tpm"),
                    nonNegativeDouble(summary, "successRate"),
                    nonNegativeLong(summary, "servicesHealthy"),
                    nonNegativeLong(summary, "servicesTotal"),
                    nonNegativeLong(summary, "activeKeys"),
                    nonNegativeLong(lifetime, "tokens"),
                    nonNegativeDouble(lifetime, "cost"),
                    nonNegativeLong(lifetime, "requests"),
                    recent,
                    models,
                    timeline
            );
        }
    }

    static final class BackendStatus {
        final String status;
        final String bindHost;
        final long port;
        final String startedAt;
        final long uptimeSeconds;
        final boolean controlsEnabled;
        final List<String> availableActions;

        BackendStatus(String status, String bindHost, long port, String startedAt, long uptimeSeconds,
                      boolean controlsEnabled, List<String> availableActions) {
            this.status = "stopping".equals(status) ? "stopping" : "running";
            this.bindHost = bindHost;
            this.port = port;
            this.startedAt = startedAt;
            this.uptimeSeconds = uptimeSeconds;
            this.controlsEnabled = controlsEnabled;
            this.availableActions = Collections.unmodifiableList(new ArrayList<>(availableActions));
        }

        boolean canRestart() {
            return controlsEnabled && availableActions.contains("restart") && "running".equals(status);
        }

        boolean canStop() {
            return controlsEnabled && availableActions.contains("stop") && "running".equals(status);
        }

        static BackendStatus fromJson(JSONObject root) {
            JSONObject control = root.optJSONObject("control");
            if (control == null) control = new JSONObject();
            List<String> actions = new ArrayList<>();
            JSONArray values = control.optJSONArray("availableActions");
            if (values != null) {
                for (int index = 0; index < values.length(); index++) {
                    String action = values.optString(index, "");
                    if (("restart".equals(action) || "stop".equals(action)) && !actions.contains(action)) {
                        actions.add(action);
                    }
                }
            }
            return new BackendStatus(
                    firstString(root, "status"),
                    firstString(root, "bindHost"),
                    nonNegativeLong(root, "port"),
                    firstString(root, "startedAt"),
                    nonNegativeLong(root, "uptimeSeconds"),
                    booleanValue(control, "enabled", false),
                    actions
            );
        }
    }

    public static final class TimelinePoint {
        public final String timestamp;
        public final String label;
        public final long tokens;
        public final long requests;
        public final double cost;
        public final long avgLatencyMs;

        TimelinePoint(String timestamp, String label, long tokens, long requests,
                      double cost, long avgLatencyMs) {
            this.timestamp = timestamp;
            this.label = label;
            this.tokens = tokens;
            this.requests = requests;
            this.cost = cost;
            this.avgLatencyMs = avgLatencyMs;
        }

        static TimelinePoint fromJson(JSONObject row) {
            return new TimelinePoint(
                    firstString(row, "timestamp"),
                    firstString(row, "time", "label", "timestamp"),
                    nonNegativeLong(row, "tokens"),
                    nonNegativeLong(row, "requests"),
                    nonNegativeDouble(row, "cost"),
                    nonNegativeLong(row, "avgLatencyMs")
            );
        }
    }

    public static final class Model {
        public final String model;
        public final long tokens;
        public final double cost;
        public final long requests;
        public final double share;

        Model(String model, long tokens, double cost, long requests, double share) {
            this.model = model;
            this.tokens = tokens;
            this.cost = cost;
            this.requests = requests;
            this.share = share;
        }

        static Model fromJson(JSONObject row) {
            String model = firstString(row, "model", "name");
            if (model.isEmpty()) model = "unknown";
            return new Model(
                    model,
                    nonNegativeLong(row, "tokens"),
                    nonNegativeDouble(row, "cost"),
                    nonNegativeLong(row, "requests"),
                    nonNegativeDouble(row, "share")
            );
        }
    }

    public static final class Recent {
        public final String timestamp;
        public final String project;
        public final String model;
        public final long tokens;
        public final double cost;
        public final long latencyMs;
        public final String status;
        public final boolean success;

        Recent(String timestamp, String project, String model, long tokens, double cost,
               long latencyMs, String status, boolean success) {
            this.timestamp = timestamp;
            this.project = project;
            this.model = model;
            this.tokens = tokens;
            this.cost = cost;
            this.latencyMs = latencyMs;
            this.status = status;
            this.success = success;
        }

        static Recent fromJson(JSONObject row) {
            long inputTokens = nonNegativeLong(row, "inputTokens");
            long outputTokens = nonNegativeLong(row, "outputTokens");
            long tokens = firstLong(row, "totalTokens", "tokens");
            if (tokens == 0) tokens = inputTokens + outputTokens;
            String project = firstString(row, "project", "service", "source");
            if (project.isEmpty()) project = "upstream";
            String model = firstString(row, "model");
            if (model.isEmpty()) model = "unknown";
            return new Recent(
                    firstString(row, "time", "timestamp"),
                    project,
                    model,
                    tokens,
                    nonNegativeDouble(row, "cost"),
                    nonNegativeLong(row, "latencyMs"),
                    statusText(row),
                    booleanValue(row, "success", statusLooksSuccessful(row))
            );
        }

        private static String statusText(JSONObject row) {
            String outcome = firstString(row, "outcome");
            if (!outcome.isEmpty()) return outcome;
            Object status = row.opt("status");
            if (status instanceof Number) return String.valueOf(((Number) status).intValue());
            return status == null || status == JSONObject.NULL ? "" : String.valueOf(status);
        }

        private static boolean statusLooksSuccessful(JSONObject row) {
            long status = firstLong(row, "status");
            return status == 0L || (status >= 200L && status < 400L);
        }
    }

    private static String firstString(JSONObject object, String... keys) {
        for (String key : keys) {
            Object value = object.opt(key);
            if (value != null && value != JSONObject.NULL) {
                String text = String.valueOf(value).trim();
                if (!text.isEmpty()) return text;
            }
        }
        return "";
    }

    private static long firstLong(JSONObject object, String... keys) {
        for (String key : keys) {
            Object value = object.opt(key);
            if (value == null || value == JSONObject.NULL) continue;
            try {
                double parsed = value instanceof Number
                        ? ((Number) value).doubleValue()
                        : Double.parseDouble(String.valueOf(value));
                if (Double.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
            } catch (NumberFormatException ignored) {
                // Try the next compatible alias.
            }
        }
        return 0L;
    }

    private static long nonNegativeLong(JSONObject object, String key) {
        return firstLong(object, key);
    }

    private static double nonNegativeDouble(JSONObject object, String key) {
        Object value = object.opt(key);
        if (value == null || value == JSONObject.NULL) return 0d;
        try {
            double parsed = value instanceof Number
                    ? ((Number) value).doubleValue()
                    : Double.parseDouble(String.valueOf(value));
            return Double.isFinite(parsed) && parsed >= 0 ? parsed : 0d;
        } catch (NumberFormatException ignored) {
            return 0d;
        }
    }

    private static boolean booleanValue(JSONObject object, String key, boolean fallback) {
        Object value = object.opt(key);
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof Number) return ((Number) value).intValue() != 0;
        if (value != null && value != JSONObject.NULL) {
            String text = String.valueOf(value).trim();
            if ("true".equalsIgnoreCase(text) || "1".equals(text)) return true;
            if ("false".equalsIgnoreCase(text) || "0".equals(text)) return false;
        }
        return fallback;
    }
}
