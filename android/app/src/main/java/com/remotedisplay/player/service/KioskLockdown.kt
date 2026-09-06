package com.remotedisplay.player.service

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.UserManager
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.util.DebugLog

/**
 * Ref 35 Stage C: the actual USB + kiosk (lock task) lockdown. Everything here is inert
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
 */
object KioskLockdown {
    private const val TAG = "KioskLockdown"

    private fun adminComponent(context: Context) = ComponentName(context, DeviceAdminReceiver::class.java)
    private fun dpm(context: Context) = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** Persisted flag - survives process death/reboot so MainActivity can re-enter lock
     *  task mode on every launch once an admin has turned kiosk mode on, without that
     *  re-entry itself counting as a fresh "automatic" activation. */
    fun isEnabled(context: Context): Boolean = ServerConfig(context).kioskLockdownEnabled

    /**
     * Applies the DevicePolicyManager-level policy: USB restrictions + the lock-task
     * allowlist/feature set. Does NOT itself call startLockTaskMode() - that is an Activity
     * method (see [enterLockTaskIfNeeded]), called separately once this returns true.
     */
    fun enable(context: Context): Boolean {
        if (!DeviceAdminReceiver.isDeviceOwner(context)) {
            DebugLog.w(TAG, "enable: not device owner, refusing")
            return false
        }
        val dpm = dpm(context)
        val admin = adminComponent(context)
        return try {
            dpm.addUserRestriction(admin, UserManager.DISALLOW_USB_FILE_TRANSFER)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm.addUserRestriction(admin, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA)
            }
            DebugLog.i(TAG, "USB restrictions applied")

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
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            DebugLog.i(TAG, "Lock task allowlist + features set")

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
                dpm.clearUserRestriction(admin, UserManager.DISALLOW_USB_FILE_TRANSFER)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    dpm.clearUserRestriction(admin, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA)
                }
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

            dpm.clearUserRestriction(admin, UserManager.DISALLOW_USB_FILE_TRANSFER)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm.clearUserRestriction(admin, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA)
            }
            DebugLog.i(TAG, "USB restrictions cleared")

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
            if (am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
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
            if (am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
                activity.stopLockTask()
                DebugLog.i(TAG, "Exited lock task mode")
            }
        } catch (e: Throwable) {
            DebugLog.e(TAG, "stopLockTaskMode failed: ${e.message}")
        }
    }
}
