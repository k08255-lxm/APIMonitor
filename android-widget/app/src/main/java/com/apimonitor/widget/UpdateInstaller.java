package com.apimonitor.widget;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.util.Locale;

/** Opens Android's per-app install permission screen and the system package installer. */
public final class UpdateInstaller {
    public static final String FILE_PROVIDER_AUTHORITY_SUFFIX = ".apk-files";

    private static final String PREFS = "update_installer";
    private static final String PENDING_APK = "pending_apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private UpdateInstaller() {
    }

    public enum InstallResult {
        NO_PENDING_INSTALL,
        PERMISSION_REQUIRED,
        INSTALLER_OPENED
    }

    public static final class InstallException extends Exception {
        private static final long serialVersionUID = 1L;

        public InstallException(String message) {
            super(message);
        }

        public InstallException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /**
     * Starts the safe install flow for an APK downloaded by {@link UpdateClient}.
     *
     * <p>If Android has not granted this app permission to request package installs, this
     * method opens the system's "Install unknown apps" page and returns
     * {@link InstallResult#PERMISSION_REQUIRED}. After the user returns, the activity can call
     * {@link #resumePendingInstall(Activity)}. The final install always remains in Android's
     * package installer and requires explicit system confirmation.</p>
     */
    public static InstallResult requestInstall(Activity activity, File apk) throws InstallException {
        requireActivity(activity);
        File validated = validateDownloadedApk(activity, apk);
        if (!canRequestPackageInstalls(activity)) {
            savePending(activity, validated);
            openInstallPermissionSettings(activity);
            return InstallResult.PERMISSION_REQUIRED;
        }
        return openSystemInstaller(activity, validated);
    }

    /**
     * Resumes a pending install after returning from Android's unknown-source permission page.
     * This method does not reopen the settings page when permission is still denied.
     */
    public static InstallResult resumePendingInstall(Activity activity) throws InstallException {
        requireActivity(activity);
        String path = preferences(activity).getString(PENDING_APK, "");
        if (path == null || path.isEmpty()) return InstallResult.NO_PENDING_INSTALL;
        File apk;
        try {
            apk = validateDownloadedApk(activity, new File(path));
        } catch (InstallException error) {
            clearPendingInstall(activity);
            throw error;
        }
        if (!canRequestPackageInstalls(activity)) return InstallResult.PERMISSION_REQUIRED;
        return openSystemInstaller(activity, apk);
    }

    public static boolean hasPendingInstall(Context context) {
        String path = preferences(context).getString(PENDING_APK, "");
        return path != null && !path.isEmpty();
    }

    public static boolean canRequestPackageInstalls(Context context) {
        try {
            return context.getPackageManager().canRequestPackageInstalls();
        } catch (SecurityException ignored) {
            return false;
        }
    }

    /** Opens Android's app-specific unknown-source permission page. */
    public static void openInstallPermissionSettings(Activity activity) throws InstallException {
        requireActivity(activity);
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName())
        );
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException error) {
            throw new InstallException("Android does not expose the unknown-source settings page", error);
        } catch (SecurityException error) {
            throw new InstallException(
                    "REQUEST_INSTALL_PACKAGES must be declared before requesting install permission",
                    error
            );
        }
    }

    public static void clearPendingInstall(Context context) {
        preferences(context).edit().remove(PENDING_APK).apply();
    }

    private static InstallResult openSystemInstaller(Activity activity, File apk) throws InstallException {
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + FILE_PROVIDER_AUTHORITY_SUFFIX,
                    apk
            );
        } catch (IllegalArgumentException error) {
            throw new InstallException(
                    "FileProvider is not configured for the app external Download directory",
                    error
            );
        }

        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("APIMonitor update", uri));
        try {
            activity.startActivity(intent);
            clearPendingInstall(activity);
            return InstallResult.INSTALLER_OPENED;
        } catch (ActivityNotFoundException error) {
            throw new InstallException("No Android package installer is available", error);
        } catch (SecurityException error) {
            throw new InstallException("Android refused the package installer request", error);
        }
    }

    private static File validateDownloadedApk(Context context, File apk) throws InstallException {
        if (apk == null || !apk.isFile() || apk.length() <= 0L) {
            throw new InstallException("The downloaded APK is missing or empty");
        }
        if (!apk.getName().toLowerCase(Locale.ROOT).endsWith(".apk")) {
            throw new InstallException("The downloaded update is not an APK file");
        }
        File downloadDirectory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloadDirectory == null) {
            throw new InstallException("The app external Download directory is unavailable");
        }
        try {
            String root = downloadDirectory.getCanonicalPath();
            String candidate = apk.getCanonicalPath();
            if (!candidate.startsWith(root + File.separator)) {
                throw new InstallException("The APK is outside the app external Download directory");
            }
            return new File(candidate);
        } catch (IOException error) {
            throw new InstallException("The downloaded APK path is invalid", error);
        }
    }

    private static void savePending(Context context, File apk) {
        preferences(context).edit().putString(PENDING_APK, apk.getAbsolutePath()).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void requireActivity(Activity activity) throws InstallException {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            throw new InstallException("A live activity is required to open Android's installer");
        }
    }
}
