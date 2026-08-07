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
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.service.WebSocketService

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

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as WebSocketService.LocalBinder
            wsService = binder.getService()
            bound = true
            setupServiceCallbacks()
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

        // Pre-fill if previously entered
        if (config.serverUrl.isNotEmpty()) {
            serverUrlInput.setText(config.serverUrl)
        }

        connectBtn.setOnClickListener {
            var url = serverUrlInput.text.toString().trim().trimEnd('/')
            if (url.isEmpty()) {
                statusText.text = "Please enter the server URL"
                return@setOnClickListener
            }
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://$url"
            }
            config.serverUrl = url
            connectToServer(url)
        }

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

    private fun startConnectTimeout() {
        cancelConnectTimeout()
        val runnable = Runnable {
            connectTimeoutRunnable = null
            progressBar.visibility = View.GONE
            statusText.text = "Connection timed out - check the server URL and try again"
            connectBtn.isEnabled = true
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
                // Hide the server/connect controls so the pairing code has the
                // whole screen and stays visible on short/landscape phones.
                serverSection.visibility = View.GONE
                connectBtn.visibility = View.GONE
                pairingSection.visibility = View.VISIBLE
                pairingCodeText.text = wsService?.getPairingCode() ?: "------"
                // The instruction is shown once, inside the pairing section; don't
                // duplicate it in statusText.
                statusText.text = ""
                connectBtn.isEnabled = false
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
                progressBar.visibility = View.GONE
                statusText.text = "Could not connect - check the server URL and try again"
                connectBtn.isEnabled = true
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
