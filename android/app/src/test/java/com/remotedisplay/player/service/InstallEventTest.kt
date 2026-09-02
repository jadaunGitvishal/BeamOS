package com.remotedisplay.player.service

import android.content.pm.PackageInstaller
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Phase 2 Stage B — coverage for InstallEvent.forStatus, the pure PackageInstaller
 * status -> audit-trail-event mapping used by UpdateChecker's install receiver.
 * (PackageInstaller.STATUS_* are compile-time int constants, inlined here.)
 */
class InstallEventTest {

    @Test fun success_reportsUpdateInstalledWithTheTargetVersion() {
        assertEquals(
            "update_installed" to "2.4.1",
            InstallEvent.forStatus(PackageInstaller.STATUS_SUCCESS, null, "2.4.1"),
        )
    }

    @Test fun success_withBlankVersion_fallsBackRatherThanEmpty() {
        assertEquals(
            "update_installed" to "unknown version",
            InstallEvent.forStatus(PackageInstaller.STATUS_SUCCESS, "ignored", "   "),
        )
    }

    @Test fun failure_reportsUpdateFailedWithTheStatusMessage() {
        assertEquals(
            "update_failed" to "Not enough space",
            InstallEvent.forStatus(PackageInstaller.STATUS_FAILURE_STORAGE, "Not enough space", "2.4.1"),
        )
    }

    @Test fun everyFailureVariantMapsToUpdateFailed() {
        val failures = intArrayOf(
            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_ABORTED,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_STORAGE,
        )
        for (s in failures) {
            assertEquals("update_failed", InstallEvent.forStatus(s, "boom", "2.4.1")?.first)
        }
    }

    @Test fun failure_withNoMessage_getsAReadableDefault() {
        val r = InstallEvent.forStatus(PackageInstaller.STATUS_FAILURE_ABORTED, null, "2.4.1")
        assertEquals("update_failed", r?.first)
        assertEquals("install failed (status ${PackageInstaller.STATUS_FAILURE_ABORTED})", r?.second)
    }

    @Test fun pendingUserAction_isNotAnEvent() {
        assertNull(InstallEvent.forStatus(PackageInstaller.STATUS_PENDING_USER_ACTION, null, "2.4.1"))
    }

    @Test fun unknownStatus_isNotAnEvent() {
        assertNull(InstallEvent.forStatus(-999, "weird", "2.4.1"))
    }
}
