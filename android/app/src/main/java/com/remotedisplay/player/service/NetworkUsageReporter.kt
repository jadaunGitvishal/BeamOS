package com.remotedisplay.player.service

import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.remotedisplay.player.telemetry.DeviceInfo
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Ref 44: daily SIM/network data-consumption check, reusing the SAME
 * periodic-task mechanism UpdateChecker already established in this app
 * (Handler(Looper.getMainLooper()) + a self-rescheduling postDelayed Runnable)
 * rather than introducing WorkManager/JobScheduler/AlarmManager.
 *
 * Confirmed against real AOSP source before writing this (see the Ref 44
 * research write-up): there is NO API for a Device Owner app to silently
 * grant itself PACKAGE_USAGE_STATS - DevicePolicyManager.setPermissionGrantState()
 * explicitly gates on isRuntimePermission(), and PACKAGE_USAGE_STATS's real
 * protectionLevel (signature|privileged|development|appop|retailDemo) can
 * never satisfy that check. Calling it would be dead code.
 *
 * What actually works: NetworkStatsManager's own class docs state Device
 * Owner apps are exempted from needing PACKAGE_USAGE_STATS granted at all,
 * for every query method EXCEPT querySummaryForDevice(). So: Device Owner ->
 * call querySummary() directly, no grant step, no PACKAGE_USAGE_STATS dance.
 * Not Device Owner -> genuinely nothing to report (not a defensive choice -
 * querySummary() falls back to only the calling app's own negligible UID,
 * useless for whole-device monitoring, and there is no other path). That
 * honest "not Device Owner" state is reported separately, via
 * DeviceInfo.getHardwareInfo()'s is_device_owner field (same channel as the
 * rest of Ref 31's honest markers) - this class stays silent on a non-Device-
 * Owner build rather than writing a placeholder/zero row.
 */
class NetworkUsageReporter(private val context: Context) {

    private val TAG = "NetworkUsageReporter"
    private val handler = Handler(Looper.getMainLooper())
    private val deviceInfo = DeviceInfo(context)
    private var checkTimer: Runnable? = null

    // Once a day.
    private val CHECK_INTERVAL = 24 * 60 * 60 * 1000L

    // Reported JSON: { date, bytes_received, bytes_sent, sim_provider }. Null
    // (not invoked) when there is genuinely nothing to report this cycle -
    // see the class doc above for why that's the honest outcome, not a bug.
    var usageReporter: ((JSONObject) -> Unit)? = null

    fun startPeriodicCheck() {
        stopPeriodicCheck()
        checkTimer = object : Runnable {
            override fun run() {
                checkAndReport()
                handler.postDelayed(this, CHECK_INTERVAL)
            }
        }
        // First check after 5 minutes (let the app/socket connection settle first).
        handler.postDelayed(checkTimer!!, 5 * 60 * 1000L)
        Log.i(TAG, "Periodic network-usage check started (every ${CHECK_INTERVAL / 3_600_000L}h)")
    }

    fun stopPeriodicCheck() {
        checkTimer?.let { handler.removeCallbacks(it) }
        checkTimer = null
    }

    fun checkAndReport() {
        Thread {
            try {
                measure()?.let { usageReporter?.invoke(it) }
            } catch (e: Throwable) {
                Log.w(TAG, "Network-usage check failed: ${e.message}")
            }
        }.start()
    }

    /** Returns the report to send, or null when there is nothing to report this cycle. */
    private fun measure(): JSONObject? {
        val deviceOwner = try { DeviceAdminReceiver.isDeviceOwner(context) } catch (_: Throwable) { false }
        // Not Device Owner: the real ceiling, not a defensive choice (see class doc).
        // Nothing to send - the honest "why" lives in is_device_owner, reported
        // separately via the existing hardware-info channel.
        if (!deviceOwner) return null
        // NetworkStatsManager needs API 23+; this fleet's minSdk is 21.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null

        return try {
            val cal = Calendar.getInstance()
            cal.set(Calendar.HOUR_OF_DAY, 0)
            cal.set(Calendar.MINUTE, 0)
            cal.set(Calendar.SECOND, 0)
            cal.set(Calendar.MILLISECOND, 0)
            val startOfDay = cal.timeInMillis
            val now = System.currentTimeMillis()

            val nsm = context.getSystemService(Context.NETWORK_STATS_SERVICE) as NetworkStatsManager
            var rxBytes = 0L
            var txBytes = 0L
            val bucket = NetworkStats.Bucket()
            // TYPE_MOBILE (deprecated constant, but still the one NetworkStatsManager's
            // own API requires) + null subscriberId = usage across all mobile/SIM
            // networks (API 29+), with no READ_PHONE_STATE/IMSI read needed at all.
            @Suppress("DEPRECATION")
            val stats = nsm.querySummary(ConnectivityManager.TYPE_MOBILE, null, startOfDay, now)
            // NetworkStats implements AutoCloseable, not Closeable - Kotlin's `use {}`
            // is Closeable-only, so close explicitly in a finally instead.
            try {
                while (stats.hasNextBucket()) {
                    stats.getNextBucket(bucket)
                    rxBytes += bucket.rxBytes
                    txBytes += bucket.txBytes
                }
            } finally {
                stats.close()
            }

            val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
            JSONObject().apply {
                put("date", today)
                put("bytes_received", rxBytes)
                put("bytes_sent", txBytes)
                put("sim_provider", deviceInfo.getSimProviderName())
            }
        } catch (e: Throwable) {
            // Device Owner but the query itself failed (rare - e.g. no cellular radio
            // on some emulator images). Nothing genuine to report this cycle either.
            Log.w(TAG, "querySummary failed: ${e.message}")
            null
        }
    }
}
