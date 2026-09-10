package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class ContentCache(
    private val context: Context,
    // Ref 39: free-space floor. When usableSpace drops below this, LRU cache entries are
    // evicted until back above it. Defaults to 500 MB; MainActivity can override it from
    // the "content_cache_min_free_mb" pref for field tuning.
    private val minFreeBytes: Long = CacheEviction.DEFAULT_MIN_FREE_BYTES,
) {

    private val cacheDir = File(context.filesDir, "content_cache").also { it.mkdirs() }

    // One lock per content id, so the proactive prefetch loop and the reactive "play now"
    // path never run two downloads of the SAME content at once (they used to race on the
    // scratch file - each FileOutputStream truncates it - so under a slow link neither ever
    // finished). Interned for the life of the process; the set is bounded by distinct
    // content ever fetched on this device (tens-hundreds), so it is not worth evicting.
    private val downloadLocks = ConcurrentHashMap<String, Any>()
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .build()

    fun getCachedFile(contentId: String): File? {
        // An empty contentId would make startsWith("") match every file in the cache
        // dir, silently handing back an unrelated (but real) cached file instead of
        // failing the lookup - e.g. two different playlist items would appear to play
        // the same content. Refuse the lookup outright instead.
        if (contentId.isEmpty()) return null
        val files = cacheDir.listFiles { _, name -> name.startsWith(contentId) }
        return files?.firstOrNull()?.takeIf { it.exists() && it.length() > 0 }
            // Ref 39: bump lastModified on every hit so eviction ordering is genuinely
            // least-recently-USED, not just least-recently-downloaded. Best-effort -
            // if the FS refuses the touch, we simply fall back to download-time order.
            ?.also { it.setLastModified(System.currentTimeMillis()) }
    }

    fun isContentCached(contentId: String): Boolean {
        return getCachedFile(contentId) != null
    }

    fun downloadContent(serverUrl: String, contentId: String, filename: String): File? {
        // Serialize downloads of the same content (see downloadLocks). A caller that was
        // waiting behind another almost always finds the file already fetched.
        synchronized(downloadLocks.computeIfAbsent(contentId) { Any() }) {
            getCachedFile(contentId)?.let { return it }
            return downloadContentLocked(serverUrl, contentId, filename)
        }
    }

    private fun downloadContentLocked(serverUrl: String, contentId: String, filename: String): File? {
        val ext = filename.substringAfterLast('.', "mp4")
        val finalFile = File(cacheDir, "${contentId}.${ext}")
        // Download into a scratch file in the SAME directory, then publish it with a single
        // atomic rename(2) once the transfer is verified-complete. The scratch name is
        // deliberately dot-prefixed and does NOT start with contentId, so the
        // startsWith(contentId) lookups in getCachedFile()/isContentCached()/deleteContent()
        // never see a half-written file. Before this, downloads wrote straight to finalFile:
        // a reader that hit the item mid-download got a truncated file, ExoPlayer played into
        // it and threw FileDataSourceException past the downloaded bytes, and PlaylistController
        // fell into a "Playback error, retry" loop instead of showing the clean
        // "Downloading <file>..." status (which only fires when getCachedFile() returns null).
        val partFile = File(cacheDir, ".partial-$contentId")
        try {
            val url = "${serverUrl}/api/content/${contentId}/file"
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()

            if (!response.isSuccessful) {
                Log.e("ContentCache", "Download failed: ${response.code}")
                response.close()
                return null
            }

            // Content-Length lets us detect a connection that drops mid-transfer -
            // without it, a truncated scratch file could still be renamed into place.
            val expectedLength = response.body?.contentLength()?.takeIf { it >= 0 }

            response.body?.byteStream()?.use { input ->
                FileOutputStream(partFile).use { output ->
                    input.copyTo(output)
                }
            }

            // A null/empty body wrote nothing - treat as a failed fetch and leave any
            // existing cached copy of this content untouched.
            if (!partFile.exists()) {
                Log.e("ContentCache", "Download produced no data for $filename")
                return null
            }

            if (expectedLength != null && partFile.length() != expectedLength) {
                Log.e("ContentCache", "Download incomplete for $filename: got ${partFile.length()} of $expectedLength bytes")
                partFile.delete()
                return null
            }

            // Publish atomically. renameTo() within one directory is rename(2) - it either
            // fully replaces finalFile or does nothing, so getCachedFile() only ever sees a
            // whole, verified download. The delete+retry covers the (Linux: never) case of a
            // filesystem that refuses rename onto an existing target.
            if (!partFile.renameTo(finalFile)) {
                finalFile.delete()
                if (!partFile.renameTo(finalFile)) {
                    Log.e("ContentCache", "Failed to publish $filename (rename ${partFile.name})")
                    partFile.delete()
                    return null
                }
            }

            Log.i("ContentCache", "Downloaded: $filename -> ${finalFile.absolutePath}")
            // Ref 39: the cache just grew - reclaim space if we've dropped below the floor.
            // keepIds protects the file we just fetched from being the one evicted.
            enforceStorageLimit(keepIds = setOf(contentId))
            return finalFile
        } catch (e: Exception) {
            Log.e("ContentCache", "Download error: ${e.message}")
            // Interrupted / failed transfer: drop the scratch file so a retry starts clean
            // and the incomplete bytes don't sit against the Ref 39 free-space floor. There
            // is no resume logic that would reuse it.
            partFile.delete()
            return null
        }
    }

    fun deleteContent(contentId: String) {
        cacheDir.listFiles { _, name -> name.startsWith(contentId) || name == ".partial-$contentId" }
            ?.forEach { it.delete() }
        Log.i("ContentCache", "Deleted cached content: $contentId")
    }

    fun clearAll() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    fun getCacheSize(): Long {
        return cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
    }

    /** Bytes free on the filesystem that holds the cache dir. */
    fun freeBytes(): Long = cacheDir.usableSpace

    /**
     * Ref 39: storage/cache auto-clearing.
     *
     * If free storage has dropped below [minFreeBytes], delete cached content files in
     * least-recently-used order (via [deleteContent]) until free space is back above the
     * threshold, or nothing evictable is left. A no-op when there's headroom, so it's
     * cheap to call after every download and on every playlist sync.
     *
     * @param keepIds content ids that must not be evicted (the item currently downloading,
     *   plus every item the current playlist still needs).
     * @return number of cache entries purged.
     */
    @Synchronized
    fun enforceStorageLimit(keepIds: Set<String> = emptySet()): Int {
        val free = freeBytes()
        if (free >= minFreeBytes) return 0

        // Skip in-progress downloads (.partial-<id>): they're not a finished cache entry, and
        // evicting one would delete a file that's actively being written.
        val files = cacheDir.listFiles()?.filter { it.isFile && !it.name.startsWith(".partial-") } ?: return 0
        val entries = files.map {
            CacheEviction.Entry(it.nameWithoutExtension, it.length(), it.lastModified())
        }
        val victims = CacheEviction.plan(
            entries,
            currentFreeBytes = free,
            minFreeBytes = minFreeBytes,
            keepIds = keepIds,
        )
        if (victims.isEmpty()) {
            Log.w("ContentCache", "Low storage (${mb(free)}MB free < ${mb(minFreeBytes)}MB) but no evictable cache entries")
            return 0
        }

        Log.w(
            "ContentCache",
            "Low storage: ${mb(free)}MB free < ${mb(minFreeBytes)}MB threshold — purging ${victims.size} LRU cache entr${if (victims.size == 1) "y" else "ies"}",
        )
        val sizeById = entries.associateBy({ it.contentId }, { it.sizeBytes })
        for (id in victims) {
            val kb = (sizeById[id] ?: 0L) / 1024
            deleteContent(id) // existing method
            Log.i("ContentCache", "Purged LRU cache entry: $id (~${kb}KB reclaimed)")
        }

        val after = freeBytes()
        if (after < minFreeBytes) {
            Log.w("ContentCache", "Storage still below threshold after purging ${victims.size}: ${mb(after)}MB free")
        } else {
            Log.i("ContentCache", "Storage recovered: ${mb(after)}MB free after purging ${victims.size} cache entr${if (victims.size == 1) "y" else "ies"}")
        }
        return victims.size
    }

    private fun mb(bytes: Long): Long = bytes / (1024 * 1024)
}
