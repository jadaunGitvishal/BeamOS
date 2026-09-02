package com.remotedisplay.player.service

import android.content.pm.PackageInstaller

/**
 * Phase 2 Stage B — pure mapping from a PackageInstaller session status to a
 * device audit-trail event (device:report-event -> device_events). Extracted so
 * it can be unit-tested without an Android runtime, same split as OtaThrottle:
 * this is the decision, UpdateChecker's BroadcastReceiver is the shell.
 *
 * Returns:
 *   STATUS_SUCCESS              -> ("update_installed", <version>)
 *   any STATUS_FAILURE_*        -> ("update_failed", <reason>)
 *   STATUS_PENDING_USER_ACTION  -> null   (not a terminal outcome — a dialog is up)
 *   anything else / unknown     -> null   (don't invent an event we can't explain)
 */
object InstallEvent {

    fun forStatus(status: Int, statusMessage: String?, targetVersion: String): Pair<String, String>? = when (status) {
        PackageInstaller.STATUS_SUCCESS ->
            "update_installed" to targetVersion.ifBlank { "unknown version" }

        PackageInstaller.STATUS_FAILURE,
        PackageInstaller.STATUS_FAILURE_ABORTED,
        PackageInstaller.STATUS_FAILURE_BLOCKED,
        PackageInstaller.STATUS_FAILURE_CONFLICT,
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
        PackageInstaller.STATUS_FAILURE_INVALID,
        PackageInstaller.STATUS_FAILURE_STORAGE ->
            "update_failed" to (statusMessage?.takeIf { it.isNotBlank() } ?: "install failed (status $status)")

        else -> null
    }
}
