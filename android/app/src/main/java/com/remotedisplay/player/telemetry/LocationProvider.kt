package com.remotedisplay.player.telemetry

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Ref 32: thin wrapper around FusedLocationProvider that keeps the most recent fix
 * cached so the (synchronous) telemetry builder in [DeviceInfo.getTelemetry] can read
 * it without blocking. All of the "is this a real fix" logic lives in the pure
 * [LocationTelemetry]; this object only deals with Play Services plumbing.
 *
 * Every entry point is defensive:
 *   - no location permission  -> [start] logs and returns, [currentFix] stays null
 *   - Play Services missing   -> [start] catches the throw, [currentFix] stays null
 *   - location services off   -> the callback simply never fires, [currentFix] stays null
 * In none of these cases does telemetry break; lat/long are just absent.
 */
object LocationProvider {

    private const val TAG = "LocationProvider"

    // Signage screens don't move, so a slow cadence is plenty and keeps power/GPS use
    // negligible. Fastest accepted update is 1/3 of that if the OS has one cheaply.
    private const val UPDATE_INTERVAL_MS = 15L * 60L * 1000L

    @Volatile private var lastLocation: Location? = null
    private var client: FusedLocationProviderClient? = null
    private var callback: LocationCallback? = null
    @Volatile private var started = false

    /**
     * Idempotent. Safe to call repeatedly (e.g. once per heartbeat) so that a
     * permission granted AFTER boot is picked up without an app restart.
     */
    // hasPermission() gates every path that reaches requestLocationUpdates / lastLocation;
    // lint can't see through the helper, hence the suppression.
    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(context: Context) {
        if (started) return
        val appCtx = context.applicationContext
        if (!hasPermission(appCtx)) {
            Log.i(TAG, "Location permission not granted - GPS telemetry disabled")
            return
        }
        try {
            val c = LocationServices.getFusedLocationProviderClient(appCtx)
            val request = LocationRequest.Builder(
                Priority.PRIORITY_BALANCED_POWER_ACCURACY, UPDATE_INTERVAL_MS
            ).setMinUpdateIntervalMillis(UPDATE_INTERVAL_MS / 3).build()
            val cb = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    result.lastLocation?.let { lastLocation = it }
                }
            }
            c.requestLocationUpdates(request, cb, Looper.getMainLooper())
            // Seed immediately from the OS's last known fix so the first heartbeat after
            // a grant doesn't have to wait a full interval for coordinates.
            try {
                c.lastLocation.addOnSuccessListener { loc ->
                    if (loc != null && lastLocation == null) lastLocation = loc
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "lastLocation denied: ${e.message}")
            }
            client = c
            callback = cb
            started = true
            Log.i(TAG, "FusedLocationProvider updates requested (every ${UPDATE_INTERVAL_MS / 60000}m)")
        } catch (e: Throwable) {
            // Most commonly: Play Services not installed on an AOSP box.
            Log.w(TAG, "Location start failed (Play Services missing?): ${e.message}")
        }
    }

    @Synchronized
    fun stop() {
        try { callback?.let { client?.removeLocationUpdates(it) } } catch (_: Throwable) {}
        client = null
        callback = null
        started = false
    }

    /** Telemetry-ready fix, or null when unavailable / denied / a bogus (0,0). */
    fun currentFix(): LocationTelemetry.Fix? {
        val loc = lastLocation ?: return null
        return LocationTelemetry.sanitize(loc.latitude, loc.longitude)
    }

    private fun hasPermission(ctx: Context): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            ctx, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            ctx, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return LocationTelemetry.hasLocationPermission(fine, coarse)
    }
}
