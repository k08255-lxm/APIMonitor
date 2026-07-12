package com.apimonitor.widget;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Bounded GitHub release checker and APK downloader for explicit in-app update actions. */
public final class UpdateClient {
    public static final String LATEST_RELEASE_URL =
            "https://api.github.com/repos/k08255-lxm/APIMonitor/releases/latest";

    private static final String USER_AGENT = "APIMonitor-Android-Update-Check";
    private static final String GITHUB_ACCEPT = "application/vnd.github+json";
    private static final String APK_ACCEPT = "application/octet-stream";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int API_READ_TIMEOUT_MS = 20_000;
    private static final int DOWNLOAD_READ_TIMEOUT_MS = 60_000;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_RELEASE_BYTES = 512 * 1024;
    private static final long MAX_APK_BYTES = 250L * 1024L * 1024L;
    private static final long PROGRESS_INTERVAL_MS = 250L;
    private static final Pattern RELEASE_TAG = Pattern.compile(
            "^[vV]?([0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$"
    );
    private static final Pattern RELEASE_VERSION_CODE = Pattern.compile(
            "(?m)^[ \\t]*Android-Version-Code:[ \\t]*([1-9][0-9]{0,18})[ \\t]*\\r?$"
    );
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final AtomicInteger THREAD_NUMBER = new AtomicInteger();
    // Serialize update work so repeated taps cannot write the same temporary APK concurrently.
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(
                runnable,
                "api-monitor-update-" + THREAD_NUMBER.incrementAndGet()
        );
        thread.setDaemon(true);
        return thread;
    });

    private UpdateClient() {
    }

    public enum ErrorKind {
        CANCELLED,
        NETWORK,
        API_RESPONSE,
        INVALID_RELEASE,
        NO_APK,
        STORAGE,
        DOWNLOAD,
        APK_MISMATCH,
        INSTALL,
        ACTIVITY_UNAVAILABLE
    }

    public static final class UpdateException extends Exception {
        private static final long serialVersionUID = 1L;

        public final ErrorKind kind;

        UpdateException(ErrorKind kind, String message) {
            super(message);
            this.kind = kind;
        }

        UpdateException(ErrorKind kind, String message, Throwable cause) {
            super(message, cause);
            this.kind = kind;
        }
    }

    public static final class ReleaseInfo {
        public final String tagName;
        public final String versionName;
        /** Parsed from the unique machine-readable Android-Version-Code release-note line. */
        public final long versionCode;
        public final String releaseName;
        public final String releaseNotes;
        public final String releasePageUrl;
        public final String publishedAt;
        public final String apkName;
        public final String apkDownloadUrl;
        public final long apkBytes;
        /** Lower-case SHA-256 hex, or an empty string when GitHub did not provide a digest. */
        public final String apkSha256;

        ReleaseInfo(String tagName, String versionName, long versionCode, String releaseName,
                    String releaseNotes, String releasePageUrl, String publishedAt, String apkName,
                    String apkDownloadUrl, long apkBytes, String apkSha256) {
            this.tagName = tagName;
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.releaseName = releaseName;
            this.releaseNotes = releaseNotes;
            this.releasePageUrl = releasePageUrl;
            this.publishedAt = publishedAt;
            this.apkName = apkName;
            this.apkDownloadUrl = apkDownloadUrl;
            this.apkBytes = apkBytes;
            this.apkSha256 = apkSha256;
        }
    }

    public static final class CheckResult {
        public final String installedVersionName;
        public final long installedVersionCode;
        public final ReleaseInfo latestRelease;
        public final boolean updateAvailable;

        CheckResult(String installedVersionName, long installedVersionCode,
                    ReleaseInfo latestRelease, boolean updateAvailable) {
            this.installedVersionName = installedVersionName;
            this.installedVersionCode = installedVersionCode;
            this.latestRelease = latestRelease;
            this.updateAvailable = updateAvailable;
        }
    }

    /** All callbacks run on Android's main thread. */
    public interface Listener {
        default void onChecking() {
        }

        default void onCheckComplete(CheckResult result) {
        }

        default void onDownloadStarted(ReleaseInfo release) {
        }

        default void onDownloadProgress(ReleaseInfo release, long downloadedBytes, long totalBytes) {
        }

        default void onDownloaded(ReleaseInfo release, File apk) {
        }

        default void onInstallAction(ReleaseInfo release, File apk,
                                     UpdateInstaller.InstallResult result) {
        }

        default void onError(UpdateException error) {
        }
    }

    /** A request can be cancelled from MainActivity.onDestroy(). */
    public static final class Request {
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final Object connectionLock = new Object();
        private volatile HttpURLConnection activeConnection;

        public void cancel() {
            HttpURLConnection connection;
            synchronized (connectionLock) {
                cancelled.set(true);
                connection = activeConnection;
                activeConnection = null;
            }
            if (connection != null) connection.disconnect();
        }

        public boolean isCancelled() {
            return cancelled.get();
        }

        private void attach(HttpURLConnection connection) throws UpdateException {
            boolean reject;
            synchronized (connectionLock) {
                reject = cancelled.get();
                if (!reject) activeConnection = connection;
            }
            if (reject) {
                connection.disconnect();
                throw cancelled();
            }
        }

        private void detach(HttpURLConnection connection) {
            synchronized (connectionLock) {
                if (activeConnection == connection) activeConnection = null;
            }
        }
    }

    /** Checks GitHub and reports whether the stable release is newer than the installed app. */
    public static Request checkForUpdate(Context context, Listener listener) {
        Context app = requireContext(context);
        Listener callbacks = listener == null ? new Listener() { } : listener;
        Request request = new Request();
        post(request, callbacks::onChecking);
        WORKER.execute(() -> {
            try {
                CheckResult result = performCheck(app, request);
                post(request, () -> callbacks.onCheckComplete(result));
            } catch (UpdateException error) {
                deliverError(request, callbacks, error);
            }
        });
        return request;
    }

    /** Downloads a previously checked release into the app external Download directory. */
    public static Request downloadUpdate(Context context, ReleaseInfo release, Listener listener) {
        Context app = requireContext(context);
        if (release == null) throw new IllegalArgumentException("release is required");
        Listener callbacks = listener == null ? new Listener() { } : listener;
        Request request = new Request();
        WORKER.execute(() -> {
            try {
                File apk = downloadRelease(app, release, callbacks, request);
                post(request, () -> callbacks.onDownloaded(release, apk));
            } catch (UpdateException error) {
                deliverError(request, callbacks, error);
            }
        });
        return request;
    }

    /**
     * Public one-click entry point for MainActivity.
     *
     * <p>It checks, downloads only when newer, verifies the APK, then delegates to
     * {@link UpdateInstaller}. Android's unknown-source settings and package installer remain
     * visible system surfaces and are never bypassed.</p>
     */
    public static Request checkDownloadAndInstall(Activity activity, Listener listener) {
        if (activity == null) throw new IllegalArgumentException("activity is required");
        Context app = activity.getApplicationContext();
        WeakReference<Activity> activityReference = new WeakReference<>(activity);
        Listener callbacks = listener == null ? new Listener() { } : listener;
        Request request = new Request();
        post(request, callbacks::onChecking);
        WORKER.execute(() -> {
            try {
                CheckResult result = performCheck(app, request);
                post(request, () -> callbacks.onCheckComplete(result));
                if (!result.updateAvailable) return;

                ReleaseInfo release = result.latestRelease;
                File apk = downloadRelease(app, release, callbacks, request);
                post(request, () -> {
                    callbacks.onDownloaded(release, apk);
                    Activity current = activityReference.get();
                    if (current == null || current.isFinishing() || current.isDestroyed()) {
                        callbacks.onError(new UpdateException(
                                ErrorKind.ACTIVITY_UNAVAILABLE,
                                "The activity closed before Android's installer could open"
                        ));
                        return;
                    }
                    try {
                        UpdateInstaller.InstallResult installResult =
                                UpdateInstaller.requestInstall(current, apk);
                        callbacks.onInstallAction(release, apk, installResult);
                    } catch (UpdateInstaller.InstallException error) {
                        callbacks.onError(new UpdateException(
                                ErrorKind.INSTALL,
                                error.getMessage(),
                                error
                        ));
                    }
                });
            } catch (UpdateException error) {
                deliverError(request, callbacks, error);
            }
        });
        return request;
    }

    private static CheckResult performCheck(Context context, Request request) throws UpdateException {
        InstalledVersion installed = installedVersion(context);
        ReleaseInfo latest = fetchLatestRelease(request);
        int versionNameComparison = compareVersionNames(latest.versionName, installed.versionName);
        boolean updateAvailable;
        if (latest.versionCode > 0L) {
            // Android's package manager treats versionCode as authoritative when it is supplied.
            if (latest.versionCode > installed.versionCode && versionNameComparison < 0) {
                throw new UpdateException(
                        ErrorKind.INVALID_RELEASE,
                        "The release versionCode is newer but versionName is older"
                );
            }
            updateAvailable = latest.versionCode > installed.versionCode;
        } else {
            updateAvailable = versionNameComparison > 0;
        }
        return new CheckResult(
                installed.versionName,
                installed.versionCode,
                latest,
                updateAvailable
        );
    }

    private static InstalledVersion installedVersion(Context context) throws UpdateException {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(
                    context.getPackageName(),
                    signingInfoFlags()
            );
            String versionName = info.versionName == null ? "0" : info.versionName;
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
            return new InstalledVersion(versionName, versionCode, signingDigests(info));
        } catch (PackageManager.NameNotFoundException error) {
            throw new UpdateException(
                    ErrorKind.INVALID_RELEASE,
                    "The installed app version could not be read",
                    error
            );
        }
    }

    private static ReleaseInfo fetchLatestRelease(Request request) throws UpdateException {
        HttpURLConnection connection = null;
        try {
            connection = openGet(
                    request,
                    new URL(LATEST_RELEASE_URL),
                    GITHUB_ACCEPT,
                    API_READ_TIMEOUT_MS,
                    true
            );
            int responseCode = connection.getResponseCode();
            if (responseCode != HttpURLConnection.HTTP_OK) {
                throw new UpdateException(
                        ErrorKind.API_RESPONSE,
                        "GitHub release API returned HTTP " + responseCode
                );
            }
            try (InputStream input = connection.getInputStream()) {
                String body = new String(
                        readLimited(input, MAX_RELEASE_BYTES, request),
                        StandardCharsets.UTF_8
                );
                return parseRelease(new JSONObject(body));
            }
        } catch (UpdateException error) {
            throw error;
        } catch (JSONException error) {
            throw new UpdateException(
                    ErrorKind.INVALID_RELEASE,
                    "GitHub returned invalid release metadata",
                    error
            );
        } catch (IOException error) {
            throw new UpdateException(
                    ErrorKind.NETWORK,
                    "Unable to reach the GitHub release API",
                    error
            );
        } finally {
            disconnect(request, connection);
        }
    }

    private static ReleaseInfo parseRelease(JSONObject root) throws UpdateException {
        if (root.optBoolean("draft") || root.optBoolean("prerelease")) {
            throw new UpdateException(ErrorKind.INVALID_RELEASE, "The latest release is not stable");
        }
        String tagName = root.optString("tag_name", "").trim();
        Matcher tagMatcher = RELEASE_TAG.matcher(tagName);
        if (!tagMatcher.matches()) {
            throw new UpdateException(
                    ErrorKind.INVALID_RELEASE,
                    "The release tag must be vMAJOR.MINOR.PATCH"
            );
        }
        String versionName = tagMatcher.group(1);

        Asset asset = selectApkAsset(root.optJSONArray("assets"));
        String releaseName = root.optString("name", tagName).trim();
        String releaseNotes = root.optString("body", "");
        long versionCode = extractVersionCode(releaseNotes);

        return new ReleaseInfo(
                tagName,
                versionName,
                versionCode,
                releaseName,
                releaseNotes,
                root.optString("html_url", ""),
                root.optString("published_at", ""),
                asset.name,
                asset.downloadUrl,
                asset.size,
                asset.sha256
        );
    }

    private static Asset selectApkAsset(JSONArray assets) throws UpdateException {
        if (assets == null) throw new UpdateException(ErrorKind.NO_APK, "The release has no APK asset");
        List<Asset> candidates = new ArrayList<>();
        for (int index = 0; index < assets.length(); index++) {
            JSONObject value = assets.optJSONObject(index);
            if (value == null || !"uploaded".equals(value.optString("state", "uploaded"))) continue;
            String name = value.optString("name", "").trim();
            String label = value.optString("label", "").trim();
            String contentType = value.optString("content_type", "").trim();
            String lowerName = name.toLowerCase(Locale.ROOT);
            boolean apkName = lowerName.endsWith(".apk");
            boolean apkType = "application/vnd.android.package-archive".equalsIgnoreCase(contentType);
            if (!apkName && !apkType) continue;

            long size = value.optLong("size", -1L);
            if (size > MAX_APK_BYTES) continue;
            String downloadUrl = value.optString("browser_download_url", "").trim();
            if (!isInitialGithubDownloadUrl(downloadUrl)) continue;
            String digest = value.optString("digest", "").trim().toLowerCase(Locale.ROOT);
            String sha256 = digest.matches("sha256:[0-9a-f]{64}")
                    ? digest.substring("sha256:".length())
                    : "";
            int score = (apkName ? 2 : 0) + (apkType ? 2 : 0)
                    + (lowerName.contains("release") ? 1 : 0);
            candidates.add(new Asset(name, label, downloadUrl, size, sha256, score));
        }
        Asset best = null;
        for (Asset candidate : candidates) {
            if (best == null || candidate.score > best.score) best = candidate;
        }
        if (best == null) throw new UpdateException(ErrorKind.NO_APK, "The release has no usable APK asset");
        return best;
    }

    private static File downloadRelease(Context context, ReleaseInfo release, Listener listener,
                                        Request request) throws UpdateException {
        throwIfCancelled(request);
        if (!isInitialGithubDownloadUrl(release.apkDownloadUrl)) {
            throw new UpdateException(ErrorKind.INVALID_RELEASE, "The APK download URL is not trusted GitHub HTTPS");
        }
        post(request, () -> listener.onDownloadStarted(release));
        File directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
            throw new UpdateException(ErrorKind.STORAGE, "The app external Download directory is unavailable");
        }
        if (release.apkBytes > MAX_APK_BYTES) {
            throw new UpdateException(ErrorKind.DOWNLOAD, "The release APK exceeds the download limit");
        }
        if (release.apkBytes > 0L && directory.getUsableSpace() < release.apkBytes + 1024L * 1024L) {
            throw new UpdateException(ErrorKind.STORAGE, "There is not enough storage for the update APK");
        }

        String safeVersion = release.versionName.replaceAll("[^0-9A-Za-z._-]", "_");
        File temporary = new File(directory, "api-monitor-" + safeVersion + ".download.apk");
        File destination = new File(directory, "api-monitor-" + safeVersion + ".apk");
        if (temporary.exists() && !temporary.delete()) {
            throw new UpdateException(ErrorKind.STORAGE, "A previous partial APK could not be removed");
        }

        HttpURLConnection connection = null;
        boolean completed = false;
        try {
            connection = openGet(
                    request,
                    new URL(release.apkDownloadUrl),
                    APK_ACCEPT,
                    DOWNLOAD_READ_TIMEOUT_MS,
                    false
            );
            int responseCode = connection.getResponseCode();
            if (responseCode != HttpURLConnection.HTTP_OK) {
                throw new UpdateException(
                        ErrorKind.DOWNLOAD,
                        "GitHub APK download returned HTTP " + responseCode
                );
            }
            long contentLength = connection.getContentLengthLong();
            if (contentLength > MAX_APK_BYTES) {
                throw new UpdateException(ErrorKind.DOWNLOAD, "The APK response exceeds the download limit");
            }
            long total = release.apkBytes > 0L ? release.apkBytes : contentLength;
            MessageDigest digest = sha256Digest();
            long downloaded = 0L;
            long lastProgressAt = 0L;
            try (InputStream input = connection.getInputStream();
                 FileOutputStream output = new FileOutputStream(temporary, false)) {
                byte[] buffer = new byte[32 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    throwIfCancelled(request);
                    downloaded += read;
                    if (downloaded > MAX_APK_BYTES) {
                        throw new UpdateException(ErrorKind.DOWNLOAD, "The APK exceeds the download limit");
                    }
                    output.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                        long progress = downloaded;
                        post(request, () -> listener.onDownloadProgress(release, progress, total));
                        lastProgressAt = now;
                    }
                }
                output.getFD().sync();
            }
            long finalBytes = downloaded;
            post(request, () -> listener.onDownloadProgress(release, finalBytes, total));
            if (downloaded <= 0L) {
                throw new UpdateException(ErrorKind.DOWNLOAD, "GitHub returned an empty APK");
            }
            if (release.apkBytes > 0L && downloaded != release.apkBytes) {
                throw new UpdateException(ErrorKind.DOWNLOAD, "The APK size does not match release metadata");
            }
            throwIfCancelled(request);
            String actualSha256 = hex(digest.digest());
            if (!release.apkSha256.isEmpty() && !release.apkSha256.equals(actualSha256)) {
                throw new UpdateException(ErrorKind.APK_MISMATCH, "The APK SHA-256 digest does not match GitHub");
            }

            throwIfCancelled(request);
            validateArchive(context, temporary, release);
            throwIfCancelled(request);
            if (destination.exists() && !destination.delete()) {
                throw new UpdateException(ErrorKind.STORAGE, "The previous update APK could not be replaced");
            }
            throwIfCancelled(request);
            if (!temporary.renameTo(destination)) {
                throw new UpdateException(ErrorKind.STORAGE, "The completed update APK could not be finalized");
            }
            completed = true;
            return destination;
        } catch (UpdateException error) {
            throw error;
        } catch (IOException error) {
            throw new UpdateException(ErrorKind.DOWNLOAD, "The APK download failed", error);
        } finally {
            disconnect(request, connection);
            if (!completed && temporary.exists()) temporary.delete();
        }
    }

    private static void validateArchive(Context context, File apk, ReleaseInfo release)
            throws UpdateException {
        PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(
                apk.getAbsolutePath(),
                signingInfoFlags()
        );
        if (archive == null) {
            throw new UpdateException(ErrorKind.APK_MISMATCH, "Android could not parse the downloaded APK");
        }
        if (!context.getPackageName().equals(archive.packageName)) {
            throw new UpdateException(ErrorKind.APK_MISMATCH, "The APK package name does not match this app");
        }
        String archiveVersionName = archive.versionName == null ? "" : archive.versionName;
        long archiveVersionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archive.getLongVersionCode()
                : archive.versionCode;
        if (compareVersionNames(archiveVersionName, release.versionName) != 0) {
            throw new UpdateException(ErrorKind.APK_MISMATCH, "The APK versionName does not match the release");
        }
        if (release.versionCode > 0L && archiveVersionCode != release.versionCode) {
            throw new UpdateException(ErrorKind.APK_MISMATCH, "The APK versionCode does not match the release");
        }
        InstalledVersion installed = installedVersion(context);
        if (!signaturesOverlap(installed.signingDigests, signingDigests(archive))) {
            throw new UpdateException(
                    ErrorKind.APK_MISMATCH,
                    "The APK signing certificate does not match the installed app"
            );
        }
        if (archiveVersionCode <= installed.versionCode) {
            throw new UpdateException(ErrorKind.APK_MISMATCH, "The downloaded APK is not newer than this app");
        }
    }

    private static int signingInfoFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
    }

    private static List<String> signingDigests(PackageInfo info) throws UpdateException {
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo != null) {
                signatures = signingInfo.hasMultipleSigners()
                        ? signingInfo.getApkContentsSigners()
                        : signingInfo.getSigningCertificateHistory();
            }
        } else {
            signatures = info.signatures;
        }
        List<String> result = new ArrayList<>();
        if (signatures == null) return result;
        for (Signature signature : signatures) {
            if (signature != null) result.add(hex(sha256Digest().digest(signature.toByteArray())));
        }
        return result;
    }

    private static boolean signaturesOverlap(List<String> installed, List<String> archive) {
        if (installed.isEmpty() || archive.isEmpty()) return false;
        for (String digest : archive) {
            if (installed.contains(digest)) return true;
        }
        return false;
    }

    private static HttpURLConnection openGet(Request request, URL initial, String accept,
                                             int readTimeoutMs, boolean githubApi)
        throws IOException, UpdateException {
        URL current = initial;
        requireHttps(current);
        if (!isAllowedGithubHost(current.getHost())) {
            throw new IOException("Update URL is outside the GitHub/CDN allowlist");
        }
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            throwIfCancelled(request);
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(readTimeoutMs);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", accept);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            if (githubApi) {
                connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            }
            request.attach(connection);
            int responseCode;
            try {
                responseCode = connection.getResponseCode();
            } catch (IOException error) {
                request.detach(connection);
                connection.disconnect();
                throw error;
            }
            if (!isRedirect(responseCode)) return connection;

            String location = connection.getHeaderField("Location");
            request.detach(connection);
            connection.disconnect();
            if (location == null || location.trim().isEmpty()) {
                throw new IOException("Redirect response did not include Location");
            }
            current = new URL(current, location);
            requireHttps(current);
            if (!isAllowedGithubHost(current.getHost())) {
                throw new IOException("Update redirect is outside the GitHub/CDN allowlist");
            }
        }
        throw new IOException("Too many HTTPS redirects");
    }

    private static boolean isRedirect(int code) {
        return code == HttpURLConnection.HTTP_MOVED_PERM
                || code == HttpURLConnection.HTTP_MOVED_TEMP
                || code == HttpURLConnection.HTTP_SEE_OTHER
                || code == 307
                || code == 308;
    }

    private static void requireHttps(URL url) throws IOException {
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new IOException("Update requests must use HTTPS");
        }
    }

    private static boolean isAllowedGithubHost(String value) {
        String host = value == null ? "" : value.toLowerCase(Locale.ROOT);
        return host.equals("github.com")
                || host.equals("api.github.com")
                || host.equals("objects.githubusercontent.com")
                || host.equals("release-assets.githubusercontent.com")
                || host.endsWith(".githubusercontent.com")
                || host.matches(
                        "github-production-release-asset-[a-z0-9-]+\\.s3(?:-[a-z0-9-]+)?\\.amazonaws\\.com"
                );
    }

    private static boolean isInitialGithubDownloadUrl(String value) {
        try {
            URL url = new URL(value);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return false;
            return isAllowedGithubHost(url.getHost());
        } catch (Exception ignored) {
            return false;
        }
    }

    private static byte[] readLimited(InputStream input, int maximum, Request request)
            throws IOException, UpdateException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            throwIfCancelled(request);
            total += read;
            if (total > maximum) throw new IOException("Response exceeds the size limit");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static long extractVersionCode(String releaseNotes) throws UpdateException {
        Matcher matcher = RELEASE_VERSION_CODE.matcher(releaseNotes == null ? "" : releaseNotes);
        if (!matcher.find()) {
            throw new UpdateException(
                    ErrorKind.INVALID_RELEASE,
                    "Release notes must contain one Android-Version-Code: N line"
            );
        }
        String value = matcher.group(1);
        if (matcher.find()) {
            throw new UpdateException(
                    ErrorKind.INVALID_RELEASE,
                    "Release notes contain more than one Android-Version-Code line"
            );
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ignored) {
            throw new UpdateException(ErrorKind.INVALID_RELEASE, "Android-Version-Code is invalid");
        }
    }

    static int compareVersionNames(String left, String right) {
        String[] leftParts = versionCore(left).split("\\.", -1);
        String[] rightParts = versionCore(right).split("\\.", -1);
        int length = Math.max(leftParts.length, rightParts.length);
        for (int index = 0; index < length; index++) {
            String leftPart = index < leftParts.length ? leftParts[index] : "0";
            String rightPart = index < rightParts.length ? rightParts[index] : "0";
            int comparison = compareNumericStrings(leftPart, rightPart);
            if (comparison != 0) return comparison;
        }
        boolean leftStable = !versionBase(left).contains("-");
        boolean rightStable = !versionBase(right).contains("-");
        if (leftStable != rightStable) return leftStable ? 1 : -1;
        if (leftStable) return 0;
        return versionBase(left).compareToIgnoreCase(versionBase(right));
    }

    private static String versionBase(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.startsWith("v") || normalized.startsWith("V")) {
            normalized = normalized.substring(1);
        }
        int build = normalized.indexOf('+');
        return build >= 0 ? normalized.substring(0, build) : normalized;
    }

    private static String versionCore(String value) {
        String base = versionBase(value);
        int prerelease = base.indexOf('-');
        return prerelease >= 0 ? base.substring(0, prerelease) : base;
    }

    private static int compareNumericStrings(String left, String right) {
        String normalizedLeft = stripLeadingZeros(left);
        String normalizedRight = stripLeadingZeros(right);
        if (normalizedLeft.length() != normalizedRight.length()) {
            return Integer.compare(normalizedLeft.length(), normalizedRight.length());
        }
        return normalizedLeft.compareTo(normalizedRight);
    }

    private static String stripLeadingZeros(String value) {
        int index = 0;
        while (index < value.length() - 1 && value.charAt(index) == '0') index++;
        return value.substring(index);
    }

    private static MessageDigest sha256Digest() throws UpdateException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new UpdateException(ErrorKind.DOWNLOAD, "SHA-256 is unavailable", error);
        }
    }

    private static String hex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte item : value) output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return output.toString();
    }

    private static Context requireContext(Context context) {
        if (context == null) throw new IllegalArgumentException("context is required");
        return context.getApplicationContext();
    }

    private static void throwIfCancelled(Request request) throws UpdateException {
        if (request.isCancelled()) throw cancelled();
    }

    private static UpdateException cancelled() {
        return new UpdateException(ErrorKind.CANCELLED, "The update request was cancelled");
    }

    private static void post(Request request, Runnable callback) {
        MAIN.post(() -> {
            if (!request.isCancelled()) callback.run();
        });
    }

    private static void deliverError(Request request, Listener listener, UpdateException error) {
        if (error.kind == ErrorKind.CANCELLED || request.isCancelled()) return;
        post(request, () -> listener.onError(error));
    }

    private static void disconnect(Request request, HttpURLConnection connection) {
        if (connection == null) return;
        request.detach(connection);
        connection.disconnect();
    }

    private static final class InstalledVersion {
        final String versionName;
        final long versionCode;
        final List<String> signingDigests;

        InstalledVersion(String versionName, long versionCode, List<String> signingDigests) {
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.signingDigests = signingDigests;
        }
    }

    private static final class Asset {
        final String name;
        final String label;
        final String downloadUrl;
        final long size;
        final String sha256;
        final int score;

        Asset(String name, String label, String downloadUrl, long size, String sha256, int score) {
            this.name = name;
            this.label = label;
            this.downloadUrl = downloadUrl;
            this.size = size;
            this.sha256 = sha256;
            this.score = score;
        }
    }
}
