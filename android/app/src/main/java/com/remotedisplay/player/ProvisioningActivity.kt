package com.remotedisplay.player

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.service.WebSocketService
import com.remotedisplay.player.telemetry.DeviceInfo
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ProvisioningActivity : AppCompatActivity() {

    companion object {
        // Tied to WebSocketService's Engine.IO connect timeout (20s) — fires a bit before it
        // so the UI never waits longer than the socket layer itself would.
        private const val CONNECT_TIMEOUT_MS = 15000L
    }

    private lateinit var config: ServerConfig
    private var wsService: WebSocketService? = null
    private var bound = false
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var connectTimeoutRunnable: Runnable? = null

    private lateinit var serverUrlInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var pairingCodeText: TextView
    private lateinit var statusText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var pairingSection: View
    private lateinit var serverSection: View
    // Ref 30 Stage 2: activation-code entry, alongside the auto-generate flow.
    private lateinit var modeGroup: RadioGroup
    private lateinit var activationSection: View
    private lateinit var activationCodeInput: EditText
    private lateinit var activateBtn: Button
    // Set true once an activation-code claim succeeds so onRegistered() waits for
    // device:paired instead of flashing the auto-generate pairing-code screen.
    private var activating = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as WebSocketService.LocalBinder
            wsService = binder.getService()
            bound = true
            setupServiceCallbacks()
            // Ref 35 Stage B: only after the service is actually bound - same ordering
            // guarantee the manual activation flow already relies on (a user can't tap
            // Activate before this point either).
            maybeAutoClaimFromDeviceOwnerProvisioning()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            wsService = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_provisioning)

        // Fullscreen immersive
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

        config = ServerConfig(this)

        serverUrlInput = findViewById(R.id.serverUrlInput)
        connectBtn = findViewById(R.id.connectBtn)
        pairingCodeText = findViewById(R.id.pairingCodeText)
        statusText = findViewById(R.id.statusText)
        progressBar = findViewById(R.id.progressBar)
        pairingSection = findViewById(R.id.pairingSection)
        serverSection = findViewById(R.id.serverSection)
        modeGroup = findViewById(R.id.modeGroup)
        activationSection = findViewById(R.id.activationSection)
        activationCodeInput = findViewById(R.id.activationCodeInput)
        activateBtn = findViewById(R.id.activateBtn)

        // Pre-fill if previously entered
        if (config.serverUrl.isNotEmpty()) {
            serverUrlInput.setText(config.serverUrl)
        }

        connectBtn.setOnClickListener {
            val url = normalizedServerUrl() ?: return@setOnClickListener
            config.serverUrl = url
            connectToServer(url)
        }

        // Ref 30 Stage 2: toggle between the auto-generate flow (connectBtn) and
        // the activation-code flow (activationSection). Both are ADDITIVE — the
        // auto-generate path is unchanged.
        modeGroup.setOnCheckedChangeListener { _, checkedId ->
            val activation = checkedId == R.id.modeActivationRadio
            activationSection.visibility = if (activation) View.VISIBLE else View.GONE
            connectBtn.visibility = if (activation) View.GONE else View.VISIBLE
            statusText.text = ""
        }

        activateBtn.setOnClickListener { submitActivationCode() }

        // Request notification permission on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            } else {
                startWebSocketService()
            }
        } else {
            startWebSocketService()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Start service regardless of permission result - it just won't show notification on 13+
        startWebSocketService()
    }

    private fun startWebSocketService() {
        try {
            val serviceIntent = Intent(this, WebSocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            bindService(serviceIntent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            Log.e("ProvisioningActivity", "Failed to start service: ${e.message}")
            statusText.text = "Service error: ${e.message}"
        }
    }

    private fun connectToServer(url: String) {
        connectBtn.isEnabled = false
        progressBar.visibility = View.VISIBLE
        statusText.text = "Connecting to server..."

        wsService?.connect(url)
        startConnectTimeout()
    }

    // Read + normalize the server URL field (adds http:// when no scheme). Returns
    // null and sets an error message when the field is empty.
    private fun normalizedServerUrl(): String? {
        var url = serverUrlInput.text.toString().trim().trimEnd('/')
        if (url.isEmpty()) {
            statusText.text = "Please enter the server URL"
            return null
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        return url
    }

    // Ref 30 Stage 2: claim this display with a code the installer pre-generated in
    // the dashboard. HTTP POST first (create + claim server-side), then bring up the
    // socket as an already-provisioned device — the server re-sends device:paired
    // via the normal reconnect path, so onPaired handles the hand-off to MainActivity.
    private fun submitActivationCode() {
        val url = normalizedServerUrl() ?: return
        val code = activationCodeInput.text.toString().trim()
        if (!Regex("^[0-9]{6}$").matches(code)) {
            statusText.text = "Enter the 6-digit activation code"
            return
        }
        config.serverUrl = url
        activateBtn.isEnabled = false
        connectBtn.isEnabled = false
        progressBar.visibility = View.VISIBLE
        statusText.text = "Activating this display..."
        Thread { claimActivationCode(url, code) }.start()
    }

    private fun claimActivationCode(url: String, code: String) {
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
        // Same identity payload the socket device:register sends (device_info +
        // fingerprint) so the server-side device row is populated identically.
        val payload = JSONObject().apply {
            put("code", code)
            try { put("device_info", DeviceInfo(this@ProvisioningActivity).getDeviceInfo()) } catch (_: Throwable) {}
            try { put("fingerprint", DeviceInfo(this@ProvisioningActivity).getFingerprint()) } catch (_: Throwable) {}
        }
        val request = Request.Builder()
            .url("$url/api/provisioning/registration-codes/claim")
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        try {
            client.newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val msg = try { JSONObject(text).optString("error", "") } catch (_: Throwable) { "" }
                    runOnUiThread {
                        activationError(msg.ifEmpty { "Activation failed (HTTP ${resp.code}). Check the code and try again." })
                    }
                    return
                }
                val json = JSONObject(text)
                val deviceId = json.optString("device_id", "")
                val token = json.optString("device_token", "")
                val name = json.optString("name", "Display")
                if (deviceId.isEmpty() || token.isEmpty()) {
                    runOnUiThread { activationError("The server response was incomplete. Please try again.") }
                    return
                }
                config.deviceId = deviceId
                config.deviceToken = token
                config.deviceName = name
                config.setPaired(true)
                activating = true
                runOnUiThread {
                    statusText.text = "Activated - connecting..."
                    // Authenticated register (device_id + token) -> server emits
                    // device:paired -> onPaired -> MainActivity.
                    wsService?.connect(url)
                    startConnectTimeout()
                }
            }
        } catch (e: Exception) {
            Log.w("ProvisioningActivity", "activation claim failed: ${e.message}")
            runOnUiThread { activationError("Could not reach the server. Check the URL and try again.") }
        }
    }

    // Ref 35 Stage B: DeviceAdminReceiver.onProfileProvisioningComplete() stashes a
    // registration code + server URL (from the Device Owner QR's admin extras bundle)
    // and launches this activity. If present, claim automatically instead of showing the
    // mode-selection UI - reuses claimActivationCode() unchanged, the exact same network
    // path and onRegistered/onPaired hand-off the manual activation-code flow already uses.
    // Cleared immediately (before the network call) so a later reconnect of the service
    // can't replay the same claim.
    private fun maybeAutoClaimFromDeviceOwnerProvisioning() {
        val code = config.pendingClaimCode
        val url = config.pendingClaimServerUrl
        if (code.isEmpty() || url.isEmpty()) return
        config.clearPendingClaim()
        config.serverUrl = url
        serverUrlInput.setText(url)
        activationCodeInput.setText(code)
        statusText.text = "Device Owner provisioning complete - activating automatically..."
        progressBar.visibility = View.VISIBLE
        connectBtn.isEnabled = false
        activateBtn.isEnabled = false
        Thread { claimActivationCode(url, code) }.start()
    }

    private fun activationError(message: String) {
        cancelConnectTimeout()
        activating = false
        progressBar.visibility = View.GONE
        statusText.text = message
        activateBtn.isEnabled = true
        connectBtn.isEnabled = true
    }

    private fun startConnectTimeout() {
        cancelConnectTimeout()
        val runnable = Runnable {
            connectTimeoutRunnable = null
            activating = false
            progressBar.visibility = View.GONE
            statusText.text = "Connection timed out - check the server URL and try again"
            connectBtn.isEnabled = true
            activateBtn.isEnabled = true
        }
        connectTimeoutRunnable = runnable
        timeoutHandler.postDelayed(runnable, CONNECT_TIMEOUT_MS)
    }

    private fun cancelConnectTimeout() {
        connectTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
        connectTimeoutRunnable = null
    }

    private fun setupServiceCallbacks() {
        wsService?.onRegistered = { deviceId ->
            runOnUiThread {
                cancelConnectTimeout()
                progressBar.visibility = View.GONE
                if (activating || config.isPaired) {
                    // Activation-code flow (or a reconnect of an already-claimed
                    // display): the server sends device:paired next. Don't flash the
                    // auto-generate pairing-code screen — just wait for onPaired.
                    statusText.text = "Connecting..."
                } else {
                    // Hide the server/connect controls so the pairing code has the
                    // whole screen and stays visible on short/landscape phones.
                    serverSection.visibility = View.GONE
                    modeGroup.visibility = View.GONE
                    connectBtn.visibility = View.GONE
                    activationSection.visibility = View.GONE
                    pairingSection.visibility = View.VISIBLE
                    pairingCodeText.text = wsService?.getPairingCode() ?: "------"
                    // The instruction is shown once, inside the pairing section; don't
                    // duplicate it in statusText.
                    statusText.text = ""
                    connectBtn.isEnabled = false
                }
            }
        }

        wsService?.onPaired = { deviceId, name ->
            runOnUiThread {
                statusText.text = "Paired as: $name"
                // Transition to main activity
                val intent = Intent(this, MainActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                finish()
            }
        }

        wsService?.onConnectionFailed = { message ->
            runOnUiThread {
                cancelConnectTimeout()
                activating = false
                progressBar.visibility = View.GONE
                statusText.text = "Could not connect - check the server URL and try again"
                connectBtn.isEnabled = true
                activateBtn.isEnabled = true
            }
        }
    }

    override fun onDestroy() {
        cancelConnectTimeout()
        if (bound) {
            unbindService(connection)
            bound = false
        }
        super.onDestroy()
    }
}
