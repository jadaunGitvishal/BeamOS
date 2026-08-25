package com.remotedisplay.player.player

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageView

/**
 * Org-branded intro screen shown for [DURATION_MS] before every video plays, including
 * every loop/replay - callers just wrap their "start the video" call in [show]. The
 * bitmap ("Welcome to {organizationName}") is generated on-device from organizations.name
 * (no server-rendered image / extra download involved) and cached until the name or the
 * view's size changes, so repeated loops don't redraw it.
 */
class IntroScreen(private val introImageView: ImageView) {
    companion object {
        const val DURATION_MS = 4_000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var hideRunnable: Runnable? = null
    private var cachedBitmap: Bitmap? = null
    private var cachedForName: String? = null
    private var cachedForSize: Pair<Int, Int>? = null

    /** Set from the device's playlist-update payload (organization_name). */
    var organizationName: String? = null
        set(value) {
            val normalized = value?.trim()?.ifEmpty { null }
            if (field == normalized) return
            field = normalized
            cachedBitmap = null
        }

    /** Shows the intro for [DURATION_MS], then invokes [onDone] (which should start the video). */
    fun show(onDone: () -> Unit) {
        val name = organizationName
        if (name == null) {
            // TEMP DEBUG (bug: 2-item fullscreen playlist stuck on item 1): confirms
            // whether show() is skipping straight to onDone (no delay at all) for this
            // device/item, vs. taking the 4s-delayed branch below. Remove once root
            // caused is confirmed.
            com.remotedisplay.player.util.DebugLog.i("IntroScreen", "TEMP_DEBUG show(): no organizationName, calling onDone() immediately (no intro delay)")
            onDone()
            return
        }

        val w = introImageView.width.takeIf { it > 0 } ?: introImageView.resources.displayMetrics.widthPixels
        val h = introImageView.height.takeIf { it > 0 } ?: introImageView.resources.displayMetrics.heightPixels

        introImageView.setImageBitmap(getOrBuildBitmap(name, w, h))
        introImageView.visibility = View.VISIBLE

        hideRunnable?.let { handler.removeCallbacks(it) }
        // TEMP DEBUG: see note above.
        com.remotedisplay.player.util.DebugLog.i("IntroScreen", "TEMP_DEBUG show(): displaying intro for ${DURATION_MS}ms, onDone() deferred until it elapses")
        val runnable = Runnable {
            introImageView.visibility = View.GONE
            com.remotedisplay.player.util.DebugLog.i("IntroScreen", "TEMP_DEBUG show(): ${DURATION_MS}ms elapsed, invoking onDone() now")
            onDone()
        }
        hideRunnable = runnable
        handler.postDelayed(runnable, DURATION_MS)
    }

    /** Cancels a pending intro (e.g. playback was stopped/replaced while it was showing). */
    fun cancel() {
        // TEMP DEBUG: if this fires while a runnable is still pending, the intro was
        // interrupted before onDone() ever ran for that item - the video never started.
        if (hideRunnable != null) com.remotedisplay.player.util.DebugLog.i("IntroScreen", "TEMP_DEBUG cancel(): cancelling a PENDING intro - onDone() will NOT be called for it")
        hideRunnable?.let { handler.removeCallbacks(it) }
        hideRunnable = null
        introImageView.visibility = View.GONE
    }

    private fun getOrBuildBitmap(name: String, w: Int, h: Int): Bitmap {
        val size = w to h
        cachedBitmap?.let { if (cachedForName == name && cachedForSize == size) return it }
        return buildBitmap(name, w, h).also {
            cachedBitmap = it
            cachedForName = name
            cachedForSize = size
        }
    }

    private fun buildBitmap(name: String, w: Int, h: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(w.coerceAtLeast(1), h.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.parseColor("#0B1220"))

        val text = "Welcome to $name"
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#3B82F6")
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
            textSize = (minOf(w, h) * 0.09f).coerceIn(36f, 140f)
        }
        val maxWidth = w * 0.9f
        while (paint.measureText(text) > maxWidth && paint.textSize > 20f) {
            paint.textSize -= 2f
        }
        val fm = paint.fontMetrics
        val textY = h / 2f - (fm.ascent + fm.descent) / 2f
        canvas.drawText(text, w / 2f, textY, paint)
        return bitmap
    }
}
