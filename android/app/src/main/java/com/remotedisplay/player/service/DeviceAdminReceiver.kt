package com.remotedisplay.player.service

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import com.remotedisplay.player.util.DebugLog

/**
 * Ref 35 Stage A: foundation only. Registering this receiver makes the app eligible to be
 * granted device admin / device owner status - it does NOT request or hold that status yet,
 * and enforces no policy. USB restriction and lock task (kiosk) mode are later stages.
 */
class DeviceAdminReceiver : android.app.admin.DeviceAdminReceiver() {

    companion object {
        private const val TAG = "DeviceAdminReceiver"

        /** Read-only status check - does not request or change admin state. */
        fun isDeviceOwner(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return dpm.isDeviceOwnerApp(context.packageName)
        }
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        DebugLog.i(TAG, "Device admin enabled")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        DebugLog.i(TAG, "Device admin disabled")
    }
}
