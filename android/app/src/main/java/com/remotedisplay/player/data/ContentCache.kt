package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class ContentCache(
    private val context: Context,
    // Ref 39: free-space floor. When usableSpace drops below this, LRU cache entries are
    // evicted until back above it. Defaults to 500 MB; MainActivity can override it from
    // the "content_cache_min_free_mb" pref for field tuning.
    private val minFreeBytes: Long = CacheEviction.DEFAULT_MIN_FREE_BYTES,
) {

    private val cacheDir = File(context.filesDir, "content_cache").also { it.mkdirs() }
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
        val ext = filename.substringAfterLast('.', "mp4")
        val file = File(cacheDir, "${contentId}.${ext}")
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
            // without it, a truncated large file still has length() > 0 and would be
            // treated as a permanently valid cache entry by getCachedFile().
            val expectedLength = response.body?.contentLength()?.takeIf { it >= 0 }

            response.body?.byteStream()?.use { input ->
                FileOutputStream(file).use { output ->
                    input.copyTo(output)
                }
            }

            if (expectedLength != null && file.length() != expectedLength) {
                Log.e("ContentCache", "Download incomplete for $filename: got ${file.length()} of $expectedLength bytes")
                file.delete()
                return null
            }

            Log.i("ContentCache", "Downloaded: $filename -> ${file.absolutePath}")
            // Ref 39: the cache just grew - reclaim space if we've dropped below the floor.
            // keepId protects the file we just fetched from being the one evicted.
            enforceStorageLimit(keepId = contentId)
            return file
        } catch (e: Exception) {
            Log.e("ContentCache", "Download error: ${e.message}")
            file.delete()
            return null
        }
    }

    fun deleteContent(contentId: String) {
        cacheDir.listFiles { _, name -> name.startsWith(contentId) }?.forEach { it.delete() }
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
     * @param keepId a content id that must not be evicted (the item currently downloading).
     * @return number of cache entries purged.
     */
    @Synchronized
    fun enforceStorageLimit(keepId: String? = null): Int {
        val free = freeBytes()
        if (free >= minFreeBytes) return 0

        val files = cacheDir.listFiles()?.filter { it.isFile } ?: return 0
        val entries = files.map {
            CacheEviction.Entry(it.nameWithoutExtension, it.length(), it.lastModified())
        }
        val victims = CacheEviction.plan(
            entries,
            currentFreeBytes = free,
            minFreeBytes = minFreeBytes,
            keepIds = keepId?.let { setOf(it) } ?: emptySet(),
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
