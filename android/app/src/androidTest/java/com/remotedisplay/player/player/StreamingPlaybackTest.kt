package com.remotedisplay.player.player

import android.content.Context
import android.graphics.SurfaceTexture
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.view.Surface
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Ref 42: proves that adding media3-exoplayer-hls + media3-exoplayer-rtsp to the
 * classpath makes MediaItem.fromUri() + setMediaItem() auto-route to the right
 * MediaSource with NO code change in MediaPlayerManager, and that real HLS playback
 * and existing progressive/local-file playback both work.
 */
@RunWith(AndroidJUnit4::class)
@UnstableApi
class StreamingPlaybackTest {

    private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    // ---- 1. MediaSource routing (the exact mechanism playVideoFromUrl relies on) ----

    @Test
    fun hlsUrl_routesToHlsMediaSource() {
        val src = DefaultMediaSourceFactory(ctx).createMediaSource(
            MediaItem.fromUri(Uri.parse("https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8"))
        )
        assertEquals(HlsMediaSource::class.java, src.javaClass)
    }

    @Test
    fun rtspUrl_routesToRtspMediaSource() {
        val src = DefaultMediaSourceFactory(ctx).createMediaSource(
            MediaItem.fromUri(Uri.parse("rtsp://example.com/stream"))
        )
        assertEquals(RtspMediaSource::class.java, src.javaClass)
    }

    @Test
    fun mp4Url_routesToProgressive() {
        val src = DefaultMediaSourceFactory(ctx).createMediaSource(
            MediaItem.fromUri(Uri.parse("https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4"))
        )
        assertEquals(ProgressiveMediaSource::class.java, src.javaClass)
    }

    @Test
    fun localFileUri_routesToProgressive_unchanged() {
        // playVideo(File) path: Uri.fromFile(...) with an .mp4 name must stay progressive.
        val src = DefaultMediaSourceFactory(ctx).createMediaSource(
            MediaItem.fromUri(Uri.fromFile(File(ctx.cacheDir, "sample.mp4")))
        )
        assertEquals(ProgressiveMediaSource::class.java, src.javaClass)
    }

    // ---- 2. Real HLS playback over the network ----

    @Test
    fun realHlsStream_rendersVideo() {
        assumeTrue("no internet on this device - real HLS playback needs network", hasInternet())
        val url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8"
        val result = playAndAwaitReady(Uri.parse(url), timeoutSec = 60)
        assertTrue("HLS stream never reached STATE_READY: ${result.error}", result.reachedReady)
        assertTrue("HLS video size unknown (no video track rendered)", result.videoSize.width > 0 && result.videoSize.height > 0)
        assertTrue("HLS playback position did not advance (pos=${result.advancedPositionMs}ms)", result.advancedPositionMs > 0)
    }

    /**
     * Real RTSP playback. Public RTSP test streams are scarce and flaky; if the stream
     * can't be reached the test is SKIPPED (assumeTrue), not failed - genuine RTSP
     * verification needs a real camera/encoder. When the stream IS reachable this
     * proves the rtsp:// -> RtspMediaSource -> real decode path end to end.
     */
    @Test
    fun realRtspStream_playsIfReachable() {
        assumeTrue("no internet on this device", hasInternet())
        val url = "rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1"
        val result = playAndAwaitReady(Uri.parse(url), timeoutSec = 45)
        assumeTrue(
            "RTSP test stream unreachable (${result.error}) - needs real hardware to verify",
            result.reachedReady
        )
        assertTrue("RTSP position did not advance", result.advancedPositionMs > 0)
    }

    // ---- 3. Existing progressive / local-file playback still works ----

    @Test
    fun localFilePlayback_stillWorks() {
        // Download a well-known ExoPlayer test mp4 to the app cache, then play it exactly
        // like MediaPlayerManager.playVideo(File) does (Uri.fromFile + setMediaItem).
        val file = File(ctx.cacheDir, "beamos_ref42_local.mp4")
        if (!file.exists() || file.length() == 0L) {
            assumeTrue("no internet to fetch the test mp4", hasInternet())
            URL("https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4")
                .openStream().use { input -> file.outputStream().use { input.copyTo(it) } }
        }
        assertTrue("test mp4 did not download", file.length() > 0)

        val result = playAndAwaitReady(Uri.fromFile(file), timeoutSec = 40)
        assertTrue("local mp4 never reached STATE_READY: ${result.error}", result.reachedReady)
        assertTrue("local mp4 video size unknown", result.videoSize.width > 0 && result.videoSize.height > 0)
        assertTrue("local mp4 position did not advance", result.advancedPositionMs > 0)
    }

    // ---- helpers ----

    private fun hasInternet(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private data class PlayResult(
        val reachedReady: Boolean,
        val videoSize: VideoSize,
        val advancedPositionMs: Long,
        val error: String?
    )

    private fun playAndAwaitReady(uri: Uri, timeoutSec: Long): PlayResult {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ready = CountDownLatch(1)
        val err = AtomicReference<String?>(null)
        val playerRef = AtomicReference<ExoPlayer?>(null)
        val sizeFromCallback = AtomicReference(VideoSize.UNKNOWN)
        // Off-screen surface so the video decoder actually renders frames under the
        // emulator's software (swiftshader) GL - without a surface videoSize stays UNKNOWN.
        val surfaceTexture = SurfaceTexture(0)
        val surface = Surface(surfaceTexture)

        instr.runOnMainSync {
            val player = ExoPlayer.Builder(ctx).build()
            playerRef.set(player)
            player.setVideoSurface(surface)
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY) ready.countDown()
                }
                override fun onVideoSizeChanged(videoSize: VideoSize) {
                    if (videoSize.width > 0 && videoSize.height > 0) sizeFromCallback.set(videoSize)
                }
                override fun onPlayerError(error: PlaybackException) {
                    err.set("${error.errorCodeName}: ${error.message}")
                    ready.countDown()
                }
            })
            player.setMediaItem(MediaItem.fromUri(uri))
            player.prepare()
            player.playWhenReady = true
        }

        val gotReady = ready.await(timeoutSec, TimeUnit.SECONDS)
        if (!gotReady || err.get() != null) {
            instr.runOnMainSync { playerRef.get()?.release() }
            surface.release(); surfaceTexture.release()
            return PlayResult(false, VideoSize.UNKNOWN, 0, err.get() ?: "timeout after ${timeoutSec}s")
        }

        // Let it actually decode/render for ~3s, then sample position + video size.
        Thread.sleep(3000)
        val size = AtomicReference(VideoSize.UNKNOWN)
        val pos = AtomicReference(0L)
        instr.runOnMainSync {
            val p = playerRef.get()!!
            val live = p.videoSize
            size.set(if (live.width > 0) live else sizeFromCallback.get())
            pos.set(p.currentPosition)
            p.release()
        }
        surface.release(); surfaceTexture.release()
        return PlayResult(true, size.get(), pos.get(), null)
    }
}
