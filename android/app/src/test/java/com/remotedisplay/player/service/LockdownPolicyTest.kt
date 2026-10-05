package com.remotedisplay.player.service

import android.os.UserManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ref 47: which user restrictions kiosk lockdown applies on each Android version, and
 * when setLockTaskFeatures() may be called. Pure JVM - no device or emulator needed.
 */
class LockdownPolicyTest {

    private val USB = LockdownPolicy.DISALLOW_USB_FILE_TRANSFER
    private val MEDIA = LockdownPolicy.DISALLOW_MOUNT_PHYSICAL_MEDIA
    private val RESET = LockdownPolicy.DISALLOW_FACTORY_RESET
    private val SAFE = LockdownPolicy.DISALLOW_SAFE_BOOT
    private val DEBUG = LockdownPolicy.DISALLOW_DEBUGGING_FEATURES

    private fun debug(sdk: Int) = LockdownPolicy.restrictions(sdk, isDebugBuild = true)
    private fun release(sdk: Int) = LockdownPolicy.restrictions(sdk, isDebugBuild = false)

    @Test fun literalsMatchTheUserManagerConstants() {
        // Kotlin inlines these Java compile-time constants from android.jar, so this runs on the JVM.
        assertEquals(UserManager.DISALLOW_USB_FILE_TRANSFER, USB)
        assertEquals(UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA, MEDIA)
        assertEquals(UserManager.DISALLOW_FACTORY_RESET, RESET)
        assertEquals(UserManager.DISALLOW_SAFE_BOOT, SAFE)
        assertEquals(UserManager.DISALLOW_DEBUGGING_FEATURES, DEBUG)
    }

    @Test fun sdk21() {
        assertEquals(listOf(USB, MEDIA, RESET), debug(21))
        assertEquals(listOf(USB, MEDIA, RESET, DEBUG), release(21))
    }

    @Test fun sdk22() {
        assertEquals(listOf(USB, MEDIA, RESET), debug(22))
        assertEquals(listOf(USB, MEDIA, RESET, DEBUG), release(22))
    }

    @Test fun sdk23() {
        assertEquals(listOf(USB, MEDIA, RESET, SAFE), debug(23))
        assertEquals(listOf(USB, MEDIA, RESET, SAFE, DEBUG), release(23))
    }

    @Test fun sdk26() {
        assertEquals(listOf(USB, MEDIA, RESET, SAFE), debug(26))
        assertEquals(listOf(USB, MEDIA, RESET, SAFE, DEBUG), release(26))
    }

    @Test fun sdk28() {
        assertEquals(listOf(USB, MEDIA, RESET, SAFE), debug(28))
        assertEquals(listOf(USB, MEDIA, RESET, SAFE, DEBUG), release(28))
    }

    @Test fun sdk34() {
        assertEquals(listOf(USB, MEDIA, RESET, SAFE), debug(34))
        assertEquals(listOf(USB, MEDIA, RESET, SAFE, DEBUG), release(34))
    }

    @Test fun debuggingFeaturesOnlyInRelease() {
        for (sdk in listOf(21, 22, 23, 26, 28, 34)) {
            assertFalse("debug build, sdk $sdk", DEBUG in debug(sdk))
            assertTrue("release build, sdk $sdk", DEBUG in release(sdk))
        }
    }

    @Test fun safeBootAbsentBelow23() {
        for (sdk in listOf(21, 22)) {
            assertFalse(SAFE in debug(sdk))
            assertFalse(SAFE in release(sdk))
        }
        assertTrue(SAFE in debug(23))
    }

    @Test fun disableClearsTheReleaseSetEvenFromADebugBuild() {
        for (sdk in listOf(21, 22, 23, 26, 28, 34)) {
            assertEquals(release(sdk), LockdownPolicy.restrictionsToClear(sdk))
            assertTrue(LockdownPolicy.restrictionsToClear(sdk).containsAll(debug(sdk)))
        }
    }

    @Test fun lockTaskFeaturesFromApi28() {
        assertFalse(LockdownPolicy.supportsLockTaskFeatures(21))
        assertFalse(LockdownPolicy.supportsLockTaskFeatures(27))
        assertTrue(LockdownPolicy.supportsLockTaskFeatures(28))
        assertTrue(LockdownPolicy.supportsLockTaskFeatures(34))
    }
}
