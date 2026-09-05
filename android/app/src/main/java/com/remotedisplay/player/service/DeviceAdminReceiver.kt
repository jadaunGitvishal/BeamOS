package com.remotedisplay.player.service

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import com.remotedisplay.player.ProvisioningActivity
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.util.DebugLog

/**
 * Ref 35 Stage A: foundation only. Registering this receiver makes the app eligible to be
 * granted device admin / device owner status - it does NOT request or hold that status yet,
 * and enforces no policy. USB restriction and lock task (kiosk) mode are later stages.
 *
 * Ref 35 Stage B: [onProfileProvisioningComplete] handles the QR-triggered Device Owner
 * provisioning flow's hand-off - see its own doc comment for why this callback (not
 * RemoteDisplayApp/MainActivity startup) is where Android actually delivers this data.
 */
class DeviceAdminReceiver : android.app.admin.DeviceAdminReceiver() {

    companion object {
        private const val TAG = "DeviceAdminReceiver"

        // Must match the keys the server embeds in the Device Owner QR's
        // PROVISIONING_ADMIN_EXTRAS_BUNDLE (server/routes/registration-codes.js).
        private const val EXTRA_REGISTRATION_CODE = "com.remotedisplay.player.EXTRA_REGISTRATION_CODE"
        private const val EXTRA_SERVER_URL = "com.remotedisplay.player.EXTRA_SERVER_URL"

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

    // Ref 35 Stage B: fires once, after the system finishes making this app Device Owner
    // via QR/NFC provisioning - this is the ONLY place Android delivers
    // EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE (verified against Android's own documented
    // provisioning flow: the QR-embedded admin extras are read back here via
    // `intent.getParcelableExtra(EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)`, NOT from any
    // Activity's launch intent - so RemoteDisplayApp.onCreate()/MainActivity never see it).
    //
    // This callback runs on a BroadcastReceiver - it must return quickly and must not do
    // network I/O itself. So it only extracts our registration code + server URL and
    // persists them, then starts ProvisioningActivity (FLAG_ACTIVITY_NEW_TASK, since a
    // receiver has no task of its own), which does the actual claim POST by reusing its
    // existing claimActivationCode() path unchanged - see its onCreate().
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        DebugLog.i(TAG, "Device Owner provisioning complete")
        try {
            val extras: PersistableBundle? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, PersistableBundle::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
            }
            val code = extras?.getString(EXTRA_REGISTRATION_CODE)
            val serverUrl = extras?.getString(EXTRA_SERVER_URL)
            if (!code.isNullOrEmpty() && !serverUrl.isNullOrEmpty()) {
                DebugLog.i(TAG, "Registration code present in provisioning extras - handing off to ProvisioningActivity for auto-claim")
                val config = ServerConfig(context)
                config.pendingClaimCode = code
                config.pendingClaimServerUrl = serverUrl
                context.startActivity(Intent(context, ProvisioningActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } else {
                DebugLog.w(TAG, "Device Owner provisioning complete but no registration code in extras - manual pairing required")
            }
        } catch (e: Throwable) {
            DebugLog.e(TAG, "Failed to process provisioning admin extras: ${e.message}")
        }
    }
}
