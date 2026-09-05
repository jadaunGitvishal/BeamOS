package com.remotedisplay.player
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.remotedisplay.player.service.DeviceAdminReceiver
import com.remotedisplay.player.util.DebugLog

class RemoteDisplayApp : Application() {

    companion object {
        const val CHANNEL_ID = "remote_display_service"
        const val CHANNEL_NAME = "BeamOS Service"
        // Separate HIGH-importance channel for the boot full-screen-intent launch.
        // A full-screen intent is only honored from a high-importance channel.
        const val BOOT_CHANNEL_ID = "remote_display_boot"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        // Ref 35 Stage A: read-only status check, not wired into any feature yet.
        DebugLog.i("DeviceAdmin", "isDeviceOwnerApp=${DeviceAdminReceiver.isDeviceOwner(this)}")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "BeamOS background service"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(BOOT_CHANNEL_ID, "BeamOS Startup", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Launches the display on boot"
                    setShowBadge(false)
                }
            )
        }
    }
}
