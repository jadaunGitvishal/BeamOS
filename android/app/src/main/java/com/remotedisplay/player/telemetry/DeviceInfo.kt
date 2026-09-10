package com.remotedisplay.player.telemetry

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.WindowManager
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.service.DeviceAdminReceiver
import com.remotedisplay.player.service.OtaThrottle
import java.security.MessageDigest
import org.json.JSONObject

class DeviceInfo(private val context: Context) {

    fun getTelemetry(): JSONObject {
        return JSONObject().apply {
            put("battery_level", getBatteryLevel())
            put("battery_charging", isBatteryCharging())
            put("storage_free_mb", getStorageFreeMB())
            put("storage_total_mb", getStorageTotalMB())
            put("ram_free_mb", getRamFreeMB())
            put("ram_total_mb", getRamTotalMB())
            put("cpu_usage", getCpuUsage())
            put("wifi_ssid", getWifiSSID())
            put("wifi_rssi", getWifiRSSI())
            put("uptime_seconds", getUptimeSeconds())
            // Ref 32: GPS lat/long, only when the runtime permission is granted AND a
            // fix is cached. Absent otherwise - never 0/null placeholders, never throws.
            LocationProvider.currentFix()?.let {
                put("latitude", it.latitude)
                put("longitude", it.longitude)
            }
            // #74/#75: OS timezone + UTC clock (effective-tz resolution + dashboard skew indicator)
            put("timezone", java.util.TimeZone.getDefault().id)
            put("device_utc", System.currentTimeMillis())
        }
    }

    fun getDeviceInfo(): JSONObject {
        // Report BOTH: screen_* = the HDMI/panel OUTPUT resolution (Display.Mode), render_* =
        // the UI render surface (getRealMetrics). On TV boxes that render at 720p and upscale
        // to a 1080p signal these differ — surfacing both explains the discrepancy (#134).
        val (outW, outH) = getOutputResolution()
        val (renW, renH) = renderSurfaceSize()
        return JSONObject().apply {
            put("android_version", Build.VERSION.RELEASE)
            put("app_version", getAppVersion())
            put("screen_width", outW)
            put("screen_height", outH)
            put("render_width", renW)
            put("render_height", renH)
            // #139 Phase 2: report OTA backoff state (alongside app_version) so the dashboard can
            // flag screens stuck in manual-update-required. Read from the persisted throttle state.
            val cfg = ServerConfig(context)
            val ota = OtaThrottle.State(cfg.otaTargetVersion, cfg.otaAttempts, cfg.otaLastAttemptAt, cfg.otaBackoffReported)
            put("ota_status", OtaThrottle.statusFor(ota, System.currentTimeMillis()))
            put("ota_target_version", cfg.otaTargetVersion)
            put("ota_attempts", cfg.otaAttempts)
            // Ref 31: one-time hardware identity, nested so an old server just ignores it
            // and so the server-side write is a single clearly-scoped block.
            try { put("hardware", getHardwareInfo()) } catch (_: Throwable) {}
        }
    }

    /**
     * Ref 31: device hardware identity, captured best-effort. The contract with the
     * dashboard is: NEVER a silently-blank field. Every entry is either a real value or
     * an explicit honest marker:
     *   - "unavailable (requires Device Owner)" — a privileged field (real MAC / serial /
     *     SIM ICCID) not readable because the app is not Device Owner (an operator can fix
     *     this by provisioning the app as Device Owner).
     *   - "unavailable" — the app IS Device Owner and tried the privileged path, but this
     *     hardware simply doesn't expose the value (e.g. emulators, no cellular baseband).
     *   - "no SIM hardware" / "NO_TELEPHONY" — this device has no cellular radio at all
     *     (the common case for a signage TV box), which is distinct from a restriction.
     *   - "no SIM" — telephony hardware present, but no SIM card inserted.
     * display_size_inches is JSON null when DisplayMetrics reports a physically
     * impossible value (very common on cheap TV boxes) rather than a bogus number.
     */
    fun getHardwareInfo(): JSONObject {
        val deviceOwner = try { DeviceAdminReceiver.isDeviceOwner(context) } catch (_: Throwable) { false }
        // Not Device Owner -> the field is behind a privilege this build doesn't hold, and
        // the operator CAN fix that (provision as Device Owner). Device Owner but the read
        // still came back empty -> we tried the privileged path and this hardware just
        // doesn't expose the value (common on emulators / SIM-less boxes) - a plain
        // "unavailable", no false promise that Device Owner would help.
        val privMarker = if (deviceOwner) "unavailable" else "unavailable (requires Device Owner)"

        return JSONObject().apply {
            // Always available — the AOSP Build fields.
            put("manufacturer", Build.MANUFACTURER?.trim().takeUnless { it.isNullOrEmpty() } ?: "unknown")
            put("model", Build.MODEL?.trim().takeUnless { it.isNullOrEmpty() } ?: "unknown")
            put("display_size_inches", computeDisplaySizeInches() ?: JSONObject.NULL)

            // SIM / telephony. getSimOperatorName() / getSimState() need no permission on
            // any API level; distinguish "no radio" from "no SIM" from "restricted".
            val hasTelephony = context.packageManager
                .hasSystemFeature(android.content.pm.PackageManager.FEATURE_TELEPHONY)
            if (!hasTelephony) {
                put("sim_network_status", "NO_TELEPHONY")
                put("sim_provider", "no SIM hardware")
                put("sim_iccid", "no SIM hardware")
            } else {
                val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager
                val state = try { tm?.simState } catch (_: Throwable) { null }
                    ?: android.telephony.TelephonyManager.SIM_STATE_UNKNOWN
                put("sim_network_status", simStateName(state))
                val operator = try { tm?.simOperatorName?.trim().orEmpty() } catch (_: Throwable) { "" }
                put("sim_provider", when {
                    state == android.telephony.TelephonyManager.SIM_STATE_ABSENT -> "no SIM"
                    operator.isNotEmpty() -> operator
                    else -> "unavailable"
                })
                put("sim_iccid", when {
                    state == android.telephony.TelephonyManager.SIM_STATE_ABSENT -> "no SIM"
                    deviceOwner -> readSimIccid(tm) ?: privMarker
                    else -> "unavailable (requires Device Owner)"
                })
            }

            // Real MAC + serial: Device-Owner-privileged on modern Android. Attempt the
            // privileged path only when we actually hold Device Owner; otherwise say so.
            put("mac_address", readMacAddress(deviceOwner) ?: privMarker)
            put("serial_number", readSerialNumber(deviceOwner) ?: privMarker)
        }
    }

    private fun simStateName(state: Int): String = when (state) {
        android.telephony.TelephonyManager.SIM_STATE_ABSENT -> "ABSENT"
        android.telephony.TelephonyManager.SIM_STATE_READY -> "READY"
        android.telephony.TelephonyManager.SIM_STATE_PIN_REQUIRED -> "PIN_REQUIRED"
        android.telephony.TelephonyManager.SIM_STATE_PUK_REQUIRED -> "PUK_REQUIRED"
        android.telephony.TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "NETWORK_LOCKED"
        android.telephony.TelephonyManager.SIM_STATE_NOT_READY -> "NOT_READY"          // API 26
        android.telephony.TelephonyManager.SIM_STATE_PERM_DISABLED -> "PERM_DISABLED"  // API 26
        android.telephony.TelephonyManager.SIM_STATE_CARD_IO_ERROR -> "CARD_IO_ERROR"  // API 26
        android.telephony.TelephonyManager.SIM_STATE_CARD_RESTRICTED -> "CARD_RESTRICTED" // API 28
        else -> "UNKNOWN"
    }

    /** Physical diagonal in inches from the real render metrics; null if not sane. */
    private fun computeDisplaySizeInches(): Double? {
        return try {
            val dm = DisplayMetrics()
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            val xdpi = dm.xdpi.toDouble()
            val ydpi = dm.ydpi.toDouble()
            if (xdpi <= 0.0 || ydpi <= 0.0) return null
            val wIn = dm.widthPixels / xdpi
            val hIn = dm.heightPixels / ydpi
            val diag = kotlin.math.sqrt(wIn * wIn + hIn * hIn)
            // Reject the common TV-box garbage (reports 0.x" or absurdly large).
            if (diag < 1.0 || diag > 200.0) null else kotlin.math.round(diag * 10.0) / 10.0
        } catch (_: Throwable) {
            null
        }
    }

    /** Real hardware MAC. Only the Device Owner path is trustworthy on API 24+. */
    private fun readMacAddress(deviceOwner: Boolean): String? {
        if (deviceOwner && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE)
                    as android.app.admin.DevicePolicyManager
                val admin = android.content.ComponentName(context, DeviceAdminReceiver::class.java)
                val mac = dpm.getWifiMacAddress(admin)?.trim()
                if (!mac.isNullOrEmpty() && !mac.equals("02:00:00:00:00:00", ignoreCase = true)) return mac
            } catch (_: Throwable) { /* fall through */ }
        }
        // Pre-M devices expose the real MAC without privilege; M+ non-owner only gets the
        // 02:00:00:00:00:00 sentinel, which we treat as "not available", not a real value.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            try {
                @Suppress("DEPRECATION")
                val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION", "HardwareIds")
                val mac = wm.connectionInfo?.macAddress?.trim()
                if (!mac.isNullOrEmpty() && !mac.equals("02:00:00:00:00:00", ignoreCase = true)) return mac
            } catch (_: Throwable) { /* fall through */ }
        }
        return null
    }

    /** Real device serial. Free pre-O; Device-Owner (or privileged) only on O+. */
    @Suppress("HardwareIds")
    private fun readSerialNumber(deviceOwner: Boolean): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            val s = Build.SERIAL?.trim()
            return if (!s.isNullOrEmpty() && !s.equals(Build.UNKNOWN, ignoreCase = true)) s else null
        }
        if (!deviceOwner) return null
        return try {
            val s = Build.getSerial()?.trim()
            if (!s.isNullOrEmpty() && !s.equals(Build.UNKNOWN, ignoreCase = true)) s else null
        } catch (_: Throwable) {
            null
        }
    }

    /** SIM ICCID. Device-Owner / privileged / carrier only on API 29+. */
    @Suppress("HardwareIds")
    private fun readSimIccid(tm: android.telephony.TelephonyManager?): String? {
        return try {
            val iccid = tm?.simSerialNumber?.trim()
            if (!iccid.isNullOrEmpty()) iccid else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun getBatteryLevel(): Int {
        // Use broadcast intent method - more reliable on Android TV / Rockchip devices
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (intent != null) {
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level >= 0 && scale > 0) return (level * 100 / scale)
        }
        // Fallback to BatteryManager API
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    private fun isBatteryCharging(): Boolean {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun getStorageFreeMB(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.availableBytes / (1024 * 1024)
    }

    private fun getStorageTotalMB(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.totalBytes / (1024 * 1024)
    }

    private fun getRamFreeMB(): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.availMem / (1024 * 1024)
    }

    private fun getRamTotalMB(): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.totalMem / (1024 * 1024)
    }

    private fun getCpuUsage(): Double {
        // Simple estimation - in production you'd read /proc/stat
        return try {
            val runtime = Runtime.getRuntime()
            val usedMem = runtime.totalMemory() - runtime.freeMemory()
            val maxMem = runtime.maxMemory()
            (usedMem.toDouble() / maxMem.toDouble()) * 100.0
        } catch (e: Exception) {
            0.0
        }
    }

    @Suppress("DEPRECATION")
    private fun getWifiSSID(): String {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val info = wm.connectionInfo
            info.ssid?.replace("\"", "") ?: "Unknown"
        } catch (e: Exception) {
            "Unknown"
        }
    }

    @Suppress("DEPRECATION")
    private fun getWifiRSSI(): Int {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wm.connectionInfo.rssi
        } catch (e: Exception) {
            0
        }
    }

    private fun getUptimeSeconds(): Long {
        return SystemClock.elapsedRealtime() / 1000
    }

    /**
     * The display's actual OUTPUT resolution — the HDMI / panel signal — taken from the
     * active [android.view.Display.Mode]. This is deliberately NOT getRealMetrics(): many
     * Android TV boxes/sticks (and TV-OS builds like YaOS) render the UI into a lower
     * surface — commonly 1280x720 — and let the hardware scaler upscale it to a 1920x1080
     * (or 4K) HDMI signal. getRealMetrics() reports that 720p RENDER SURFACE, so a panel
     * receiving a real 1080p signal was being reported as 720p. Display.Mode.physicalWidth/
     * Height reports the true output mode (orientation-independent — the panel doesn't rotate
     * when we software-rotate the stage). Falls back to the render surface if no mode is
     * available. (#134 follow-up: "device reports 720p while the monitor shows a 1080 signal".)
     */
    private fun getOutputResolution(): Pair<Int, Int> {
        // Display.getMode() / Display.Mode.physicalWidth are API 23. On 21-22 there is
        // no separate "output mode" concept exposed, so fall straight through to the
        // render-surface size. (The catch(Throwable) below is still the backstop.)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return renderSurfaceSize()
        return try {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            @Suppress("DEPRECATION")
            val mode = wm.defaultDisplay?.mode
            val pw = mode?.physicalWidth ?: 0
            val ph = mode?.physicalHeight ?: 0
            if (pw > 0 && ph > 0) pw to ph else renderSurfaceSize()
        } catch (e: Throwable) {
            renderSurfaceSize()
        }
    }

    /** Fallback: the UI render-surface size (getRealMetrics). May be < the output mode. */
    private fun renderSurfaceSize(): Pair<Int, Int> {
        val dm = DisplayMetrics()
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(dm)
        return dm.widthPixels to dm.heightPixels
    }

    private fun getAppVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    @Suppress("DEPRECATION", "HardwareIds")
    fun getFingerprint(): String {
        // Create a hardware fingerprint that survives app reinstalls
        val parts = listOf(
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "",
            Build.BOARD,
            Build.BRAND,
            Build.DEVICE,
            Build.HARDWARE,
            Build.MANUFACTURER,
            Build.MODEL,
            Build.PRODUCT,
            try { Build.SERIAL } catch (e: Exception) { "unknown" },
            Build.DISPLAY,
        )
        val raw = parts.joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
