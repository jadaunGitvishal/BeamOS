package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class ContentCache(private val context: Context) {

    private val cacheDir = File(context.filesDir, "content_cache").also { it.mkdirs() }
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .build()

    fun getCachedFile(contentId: String): File? {
        val files = cacheDir.listFiles { _, name -> name.startsWith(contentId) }
        return files?.firstOrNull()?.takeIf { it.exists() && it.length() > 0 }
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
}
