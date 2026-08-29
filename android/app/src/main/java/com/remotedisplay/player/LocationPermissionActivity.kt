package com.remotedisplay.player

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.telemetry.LocationProvider
import com.remotedisplay.player.telemetry.LocationTelemetry

/**
 * Ref 32: transparent activity that requests the runtime location permission.
 *
 * SetupActivity only runs during first-time setup, so an already-provisioned screen
 * has no way to grant location afterwards. This mirrors [ScreenCapturePermissionActivity]
 * (a transparent activity the service launches to obtain a permission on demand) - it's
 * triggered by the `request_location` device:command from the dashboard, exactly like
 * `enable_system_capture` triggers the screen-capture consent activity.
 *
 * Shows the system location dialog, then kicks [LocationProvider] so the next heartbeat
 * carries coordinates without waiting for an app restart. Finishes immediately either way.
 */
class LocationPermissionActivity : Activity() {

    companion object {
        private const val REQUEST_CODE = 1002
        private const val TAG = "LocationPermission"

        fun request(context: Context) {
            val intent = Intent(context, LocationPermissionActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (hasPermission()) {
            Log.i(TAG, "Location already granted - (re)starting provider")
            LocationProvider.start(applicationContext)
            finish()
            return
        }
        ActivityCompat.requestPermissions(
            this,
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ),
            REQUEST_CODE
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CODE) {
            if (hasPermission()) {
                Log.i(TAG, "Location permission granted - starting provider")
                LocationProvider.start(applicationContext)
            } else {
                Log.w(TAG, "Location permission denied - telemetry stays without lat/long")
            }
        }
        finish()
    }

    private fun hasPermission(): Boolean = LocationTelemetry.hasLocationPermission(
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED,
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    )
}
