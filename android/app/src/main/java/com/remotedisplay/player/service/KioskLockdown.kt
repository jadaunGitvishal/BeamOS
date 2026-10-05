package com.remotedisplay.player.service

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import androidx.annotation.ChecksSdkIntAtLeast
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.util.DebugLog

/**
 * Ref 35 Stage C / Ref 47: the actual USB + kiosk (lock task) lockdown. Everything here is inert
 * until [enable] is explicitly called (a deliberate device:command, wired in MainActivity's
 * onCommand handler - never triggered just because the app happens to hold Device Owner).
 *
 * USB and lock-task are bundled as ONE "lockdown" concept with ONE enable/disable pair,
 * not four independent toggles - the practical unit an admin actually flips day-to-day is
 * "kiosk mode on" / "kiosk mode off", and item 3 of this stage asked for "the reverse of
 * both" as a single action, distinct from the emergency clearDeviceOwnerApp() debug path.
 *
 * All DevicePolicyManager calls here require the caller to currently BE the device owner -
 * they throw SecurityException otherwise. Every entry point checks
 * [DeviceAdminReceiver.isDeviceOwner] first and no-ops (logged) rather than crash a device
 * that was never made Device Owner.
 *
 * Ref 47: WHICH user restrictions are applied is decided by [LockdownPolicy] (pure,
 * unit-tested), per Android version - USB file transfer, physical media, factory reset
 * (API 21+), safe boot (API 23+) and, in release builds only, USB debugging. enable(),
 * disable() and the rollback all iterate that one list so they can never drift. The lock
 * task allowlist + startLockTask() apply on every version (API 21+); setLockTaskFeatures()
 * only exists from API 28, and ActivityManager.lockTaskModeState from API 23 (API 21-22 use
 * the older isInLockTaskMode) - both are version-guarded so lockdown works on Android 5-8.
 */
object KioskLockdown {
    private const val TAG = "KioskLockdown"

    private fun adminComponent(context: Context) = ComponentName(context, DeviceAdminReceiver::class.java)
    private fun dpm(context: Context) = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** Persisted flag - survives process death/reboot so MainActivity can re-enter lock
     *  task mode on every launch once an admin has turned kiosk mode on, without that
     *  re-entry itself counting as a fresh "automatic" activation. */
    fun isEnabled(context: Context): Boolean = ServerConfig(context).kioskLockdownEnabled

    /** Ref 47: debug vs release, for [LockdownPolicy.restrictions]. BuildConfig generation
     *  is off in this project (AGP 8 default), so read the manifest's debuggable flag,
     *  which AGP sets for the debug build type and not for release. */
    private fun isDebugBuild(context: Context) =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /** Ref 47: [LockdownPolicy.supportsLockTaskFeatures] for THIS device. The annotation
     *  tells lint this really is an SDK_INT >= 28 check, so the guarded
     *  setLockTaskFeatures() call isn't reported as NewApi. */
    @ChecksSdkIntAtLeast(api = Build.VERSION_CODES.P)
    private fun lockTaskFeaturesSupported(): Boolean =
        LockdownPolicy.supportsLockTaskFeatures(Build.VERSION.SDK_INT)

    /** Ref 47: lock task state on every supported version. lockTaskModeState is API 23+;
     *  API 21-22 only have the (later deprecated) boolean isInLockTaskMode. */
    @Suppress("DEPRECATION")
    private fun isInLockTask(am: ActivityManager): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
        } else {
            am.isInLockTaskMode
        }

    /**
     * Applies the DevicePolicyManager-level policy: the [LockdownPolicy] user restrictions +
     * the lock-task allowlist (and, on API 28+, its feature set). Does NOT itself call startLockTaskMode() - that is an Activity
     * method (see [enterLockTaskIfNeeded]), called separately once this returns true.
     */
    fun enable(context: Context): Boolean {
        if (!DeviceAdminReceiver.isDeviceOwner(context)) {
            DebugLog.w(TAG, "enable: not device owner, refusing")
            return false
        }
        val dpm = dpm(context)
        val admin = adminComponent(context)
        val restrictions = LockdownPolicy.restrictions(Build.VERSION.SDK_INT, isDebugBuild(context))
        return try {
            for (r in restrictions) dpm.addUserRestriction(admin, r)
            DebugLog.i(TAG, "User restrictions applied: $restrictions")

            dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
            // LOCK_TASK_FEATURE_NONE: real-hardware-verified default. We originally tried
            // adding NOTIFICATIONS back (to keep our own status/debug visibility reachable)
            // while leaving HOME/RECENTS suppressed, but Android rejects that combination
            // outright: setLockTaskFeatures() threw "Cannot use LOCK_TASK_FEATURE_NOTIFICATIONS
            // without LOCK_TASK_FEATURE_HOME" on a real device owner call - the two are
            // API-coupled, not independently selectable. Since disabling home/recents is the
            // safety-relevant half of this stage's spec, NONE (blocking everything, including
            // the system notification shade) is the correct default - "our own status
            // purposes" is already served by the app's own in-app status views
            // (ProvisioningActivity/MainActivity), which need no lock-task feature at all.
            // Ref 47: setLockTaskFeatures() is API 28+. Calling it unguarded threw
            // NoSuchMethodError on Android 5-8, which the catch below turned into a full
            // rollback - lockdown never applied at all there. Below 28 there is no feature
            // set to configure; plain lock task mode already hides home/recents.
            if (lockTaskFeaturesSupported()) {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
                DebugLog.i(TAG, "Lock task allowlist + features set")
            } else {
                DebugLog.i(TAG, "Lock task allowlist set (no feature set below API 28)")
            }

            ServerConfig(context).kioskLockdownEnabled = true
            true
        } catch (e: Throwable) {
            DebugLog.e(TAG, "enable failed: ${e.message}")
            // Roll back so a failed enable() never leaves USB restrictions applied with
            // nothing to show for it - found by real testing: the lock-task step used to
            // throw AFTER the USB restrictions had already been applied, leaving USB
            // locked down with kioskLockdownEnabled still false and no way back short of
            // manually re-deriving what had actually been applied.
            try {
                for (r in restrictions) dpm.clearUserRestriction(admin, r)
                dpm.setLockTaskPackages(admin, emptyArray())
            } catch (rollbackError: Throwable) {
                DebugLog.e(TAG, "enable: rollback after failure also failed: ${rollbackError.message}")
            }
            false
        }
    }

    /** Reverses [enable]'s DevicePolicyManager-level policy. Does NOT itself call
     *  stopLockTaskMode() - see [exitLockTaskIfActive]. This is the day-to-day "turn kiosk
     *  mode back off" path - distinct from, and much lighter than, clearDeviceOwnerApp(). */
    fun disable(context: Context): Boolean {
        if (!DeviceAdminReceiver.isDeviceOwner(context)) {
            DebugLog.w(TAG, "disable: not device owner, nothing to reverse via DPM")
            ServerConfig(context).kioskLockdownEnabled = false
            return false
        }
        return try {
            val dpm = dpm(context)
            val admin = adminComponent(context)

            // Ref 47: clear the release-build set even in a debug build, so a
            // DISALLOW_DEBUGGING_FEATURES left by an earlier release build is removed too.
            val restrictions = LockdownPolicy.restrictionsToClear(Build.VERSION.SDK_INT)
            for (r in restrictions) dpm.clearUserRestriction(admin, r)
            DebugLog.i(TAG, "User restrictions cleared: $restrictions")

            dpm.setLockTaskPackages(admin, emptyArray())
            DebugLog.i(TAG, "Lock task allowlist cleared")

            ServerConfig(context).kioskLockdownEnabled = false
            true
        } catch (e: Throwable) {
            DebugLog.e(TAG, "disable failed: ${e.message}")
            false
        }
    }

    /** Activity-side: enter lock task mode if the persisted flag says kiosk mode is on
     *  and we're not already locked. Safe to call on every onResume - a no-op when already
     *  locked or when the flag is off.
     *
     *  Found by real testing (not assumed): startLockTask() alone is NOT enough here. It
     *  only works when the calling package is currently in the DPM lock-task allowlist -
     *  but that allowlist (and the USB restrictions) are NOT durable app state; Android
     *  drops them itself whenever Device Owner is cleared (verified: after the emergency
     *  clearDeviceOwnerApp() debug path, a re-grant + relaunch left mLockTaskModeState=NONE
     *  and the USB restrictions gone, even though our own kioskLockdownEnabled flag was
     *  still persisted true from before). So this re-applies the DPM policy (enable() is
     *  idempotent) before every re-entry attempt, rather than assuming a prior enable()
     *  call's policy is still intact. */
    fun enterLockTaskIfNeeded(activity: Activity) {
        if (!isEnabled(activity)) return
        try {
            enable(activity)
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            if (!isInLockTask(am)) {
                activity.startLockTask()
                DebugLog.i(TAG, "Entered lock task mode")
            }
        } catch (e: Throwable) {
            DebugLog.e(TAG, "startLockTaskMode failed: ${e.message}")
        }
    }

    /** Activity-side: exit lock task mode if currently locked. Called as part of [disable]'s
     *  full reverse flow, from the same Activity that is currently pinned. */
    fun exitLockTaskIfActive(activity: Activity) {
        try {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            if (isInLockTask(am)) {
                activity.stopLockTask()
                DebugLog.i(TAG, "Exited lock task mode")
            }
        } catch (e: Throwable) {
            DebugLog.e(TAG, "stopLockTaskMode failed: ${e.message}")
        }
    }
}
