package com.remotedisplay.player

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.service.PowerAccessibilityService
import com.remotedisplay.player.telemetry.LocationTelemetry

class SetupActivity : AppCompatActivity() {

    private lateinit var accessibilityStatus: TextView
    private lateinit var installStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var enableAccessibilityBtn: Button
    private lateinit var enableInstallBtn: Button
    private lateinit var fullscreenStatus: TextView
    private lateinit var enableFullscreenBtn: Button
    private lateinit var batteryStatus: TextView
    private lateinit var enableBatteryBtn: Button
    private lateinit var overlayStatus: TextView
    private lateinit var enableOverlayBtn: Button
    private lateinit var locationStatus: TextView
    private lateinit var enableLocationBtn: Button
    private lateinit var continueBtn: Button

    @SuppressLint("BatteryLife")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Skip setup if already completed
        val prefs = getSharedPreferences("remote_display", MODE_PRIVATE)
        if (prefs.getBoolean("setup_complete", false)) {
            proceedToNext()
            return
        }

        setContentView(R.layout.activity_setup)

        // Battery-optimization exemption and the overlay permission are both API 23
        // concepts (no Doze, and SYSTEM_ALERT_WINDOW is auto-granted, before M). Their
        // Settings screens don't exist on 21-22, so hide those rows entirely there.
        val preM = Build.VERSION.SDK_INT < Build.VERSION_CODES.M

        // App's UI is up — clear the boot "Starting display…" notification.
        // (getSystemService(Class) is API 23 — use the string-constant overload.)
        (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(999)

        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        accessibilityStatus = findViewById(R.id.accessibilityStatus)
        installStatus = findViewById(R.id.installStatus)
        notificationStatus = findViewById(R.id.notificationStatus)
        enableAccessibilityBtn = findViewById(R.id.enableAccessibilityBtn)
        enableInstallBtn = findViewById(R.id.enableInstallBtn)
        continueBtn = findViewById(R.id.continueBtn)

        // Show notification row on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            findViewById<View>(R.id.notificationRow).visibility = View.VISIBLE
            findViewById<Button>(R.id.enableNotificationBtn).setOnClickListener {
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100
                )
            }
        }

        enableAccessibilityBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        // Ref 32: runtime location permission for GPS telemetry. Optional — the player
        // omits lat/long from telemetry (never crashes / blocks) if this stays denied.
        locationStatus = findViewById(R.id.locationStatus)
        enableLocationBtn = findViewById(R.id.enableLocationBtn)
        enableLocationBtn.setOnClickListener {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ),
                101
            )
        }

        enableInstallBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:$packageName")
                })
            }
        }

        fullscreenStatus = findViewById(R.id.fullscreenStatus)
        enableFullscreenBtn = findViewById(R.id.enableFullscreenBtn)
        batteryStatus = findViewById(R.id.batteryStatus)
        enableBatteryBtn = findViewById(R.id.enableBatteryBtn)
        overlayStatus = findViewById(R.id.overlayStatus)
        enableOverlayBtn = findViewById(R.id.enableOverlayBtn)

        if (preM) {
            findViewById<View>(R.id.batteryRow).visibility = View.GONE
            findViewById<View>(R.id.overlayRow).visibility = View.GONE
        }

        // Display-over-other-apps: alternate boot-launch path. With this granted the
        // boot receiver can directly start the activity from the background, which
        // works where you can't set a launcher (e.g. Android TV).
        enableOverlayBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                data = Uri.parse("package:$packageName")
            })
        }

        // Launch-on-boot needs USE_FULL_SCREEN_INTENT, which Android 14+ auto-revokes
        // for non-calling apps — so the boot full-screen launcher silently fails until
        // the user grants it. Older versions auto-grant it, so only show the row where
        // it can actually be off.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // USE_FULL_SCREEN_INTENT is auto-granted before Android 14 — hide the row.
            findViewById<View>(R.id.fullscreenRow).visibility = View.GONE
        } else {
            enableFullscreenBtn.setOnClickListener {
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
                        data = Uri.parse("package:$packageName")
                    })
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    })
                }
            }
        }

        // Battery-optimization exemption keeps the boot receiver from being deferred
        // and the app from being killed in standby (esp. on OEM / TV boxes).
        enableBatteryBtn.setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                })
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }

        continueBtn.setOnClickListener {
            prefs.edit().putBoolean("setup_complete", true).apply()
            proceedToNext()
        }

        findViewById<TextView>(R.id.skipText).setOnClickListener {
            prefs.edit().putBoolean("setup_complete", true).apply()
            proceedToNext()
        }

        updateStatuses()
    }

    override fun onResume() {
        super.onResume()
        updateStatuses()
    }

    private fun updateStatuses() {
        // Accessibility
        val accessibilityEnabled = isAccessibilityEnabled()
        accessibilityStatus.text = if (accessibilityEnabled) "ON" else "OFF"
        accessibilityStatus.setTextColor(
            if (accessibilityEnabled) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        enableAccessibilityBtn.visibility = if (accessibilityEnabled) View.GONE else View.VISIBLE

        // Install unknown apps
        val canInstall = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            packageManager.canRequestPackageInstalls()
        } else true
        installStatus.text = if (canInstall) "ON" else "OFF"
        installStatus.setTextColor(
            if (canInstall) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        enableInstallBtn.visibility = if (canInstall) View.GONE else View.VISIBLE

        // Notifications (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val hasNotif = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            notificationStatus.text = if (hasNotif) "ON" else "OFF"
            notificationStatus.setTextColor(
                if (hasNotif) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
            )
            findViewById<Button>(R.id.enableNotificationBtn).visibility =
                if (hasNotif) View.GONE else View.VISIBLE
        }

        // Launch on boot (full-screen intent — only restrictable on Android 14+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val canFsi = getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
            fullscreenStatus.text = if (canFsi) "ON" else "OFF"
            fullscreenStatus.setTextColor(if (canFsi) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
            enableFullscreenBtn.visibility = if (canFsi) View.GONE else View.VISIBLE
        }

        // Battery optimization exemption (API 23+ — no Doze before M, so "exempt").
        val ignoringBattery = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            (getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
        batteryStatus.text = if (ignoringBattery) "ON" else "OFF"
        batteryStatus.setTextColor(if (ignoringBattery) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        enableBatteryBtn.visibility = if (ignoringBattery) View.GONE else View.VISIBLE

        // Display over other apps (Settings.canDrawOverlays is API 23 — auto-granted before M).
        val canOverlay = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
        overlayStatus.text = if (canOverlay) "ON" else "OFF"
        overlayStatus.setTextColor(if (canOverlay) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        enableOverlayBtn.visibility = if (canOverlay) View.GONE else View.VISIBLE

        // Ref 32: location permission (FINE or COARSE is enough for a telemetry fix)
        val hasLocation = LocationTelemetry.hasLocationPermission(
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED,
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        )
        locationStatus.text = if (hasLocation) "ON" else "OFF"
        locationStatus.setTextColor(if (hasLocation) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        enableLocationBtn.visibility = if (hasLocation) View.GONE else View.VISIBLE

        // Update continue button text
        val allGood = accessibilityEnabled && canInstall
        continueBtn.text = if (allGood) "Continue to Setup" else "Continue Anyway"
    }

    private fun isAccessibilityEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabledServices = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        val myComponent = ComponentName(this, PowerAccessibilityService::class.java)
        return enabledServices.any {
            it.resolveInfo.serviceInfo.let { si ->
                ComponentName(si.packageName, si.name) == myComponent
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        updateStatuses()
    }

    private fun proceedToNext() {
        startActivity(Intent(this, ProvisioningActivity::class.java))
        finish()
    }
}
