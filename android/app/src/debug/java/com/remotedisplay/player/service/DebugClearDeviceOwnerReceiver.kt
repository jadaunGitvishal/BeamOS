package com.remotedisplay.player.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.remotedisplay.player.util.DebugLog

/**
 * Ref 35 Stage C: DEBUG-BUILD-ONLY. Lives under src/debug/ - the Android Gradle Plugin
 * compiles this source set, and merges src/debug/AndroidManifest.xml's receiver
 * declaration, into debug builds only. A release build contains neither this class nor
 * its manifest entry (verified via `aapt dump xmltree` against the release APK).
 *
 * Exists purely so the real, permanent [DeviceAdminReceiver.clearDeviceOwner] production
 * function can be exercised on a disposable test device without any UI:
 *   adb shell am broadcast -a com.remotedisplay.player.DEBUG_CLEAR_DEVICE_OWNER
 */
class DebugClearDeviceOwnerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        DebugLog.i("DebugClearDeviceOwner", "Triggered - calling the real clearDeviceOwner()")
        val cleared = DeviceAdminReceiver.clearDeviceOwner(context)
        DebugLog.i("DebugClearDeviceOwner", "Result: cleared=$cleared")
    }
}
