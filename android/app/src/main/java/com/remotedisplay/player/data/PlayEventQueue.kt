package com.remotedisplay.player.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log

data class PlayEventRecord(
    val sessionId: String,
    val eventType: String, // "play_start" | "play_end"
    val contentId: String?,
    val contentName: String,
    val durationSec: Int?,   // play_start only
    val completed: Boolean?, // play_end only
    val startedAtMs: Long,
    val endedAtMs: Long?     // play_end only
)

/**
 * Durable local queue for proof-of-play events (play_start/play_end). An event is written here
 * BEFORE any network attempt, and only removed once the server acks that it saved it to MySQL
 * (the `device:play-event` ack in server/ws/deviceSocket.js) - never just on send, so a lost
 * ack or a dead socket can't silently drop an event. Own SQLite file, separate from any other
 * app storage. MainActivity writes here directly (so this works even before WebSocketService is
 * bound); WebSocketService reads/deletes from the same file to flush on reconnect / periodically.
 */
class PlayEventQueue(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "play_events.db"
        private const val DB_VERSION = 1
        private const val TABLE = "play_events"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE (
                _id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                content_id TEXT,
                content_name TEXT NOT NULL,
                duration_sec INTEGER,
                completed INTEGER,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER,
                created_at_ms INTEGER NOT NULL,
                UNIQUE(session_id, event_type)
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE")
        onCreate(db)
    }

    fun enqueuePlayStart(sessionId: String, contentId: String?, contentName: String, durationSec: Int, startedAtMs: Long) {
        insert(sessionId, "play_start", contentId, contentName, durationSec.takeIf { it > 0 }, null, startedAtMs, null)
    }

    fun enqueuePlayEnd(sessionId: String, contentId: String?, contentName: String, startedAtMs: Long, endedAtMs: Long) {
        insert(sessionId, "play_end", contentId, contentName, null, true, startedAtMs, endedAtMs)
    }

    private fun insert(
        sessionId: String,
        eventType: String,
        contentId: String?,
        contentName: String,
        durationSec: Int?,
        completed: Boolean?,
        startedAtMs: Long,
        endedAtMs: Long?
    ) {
        try {
            val values = ContentValues().apply {
                put("session_id", sessionId)
                put("event_type", eventType)
                put("content_id", contentId)
                put("content_name", contentName)
                if (durationSec != null) put("duration_sec", durationSec) else putNull("duration_sec")
                if (completed != null) put("completed", if (completed) 1 else 0) else putNull("completed")
                put("started_at_ms", startedAtMs)
                if (endedAtMs != null) put("ended_at_ms", endedAtMs) else putNull("ended_at_ms")
                put("created_at_ms", System.currentTimeMillis())
            }
            // CONFLICT_REPLACE on (session_id, event_type): re-enqueueing the exact same event
            // (shouldn't normally happen) just overwrites in place rather than erroring.
            writableDatabase.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
        } catch (e: Throwable) {
            Log.e("PlayEventQueue", "enqueue failed: ${e.message}", e)
        }
    }

    /** Oldest-first, so a resend batch reports events in the order they actually happened. */
    fun getPending(limit: Int = 200): List<PlayEventRecord> {
        val out = mutableListOf<PlayEventRecord>()
        try {
            readableDatabase.rawQuery(
                "SELECT session_id, event_type, content_id, content_name, duration_sec, completed, started_at_ms, ended_at_ms " +
                    "FROM $TABLE ORDER BY created_at_ms ASC LIMIT ?",
                arrayOf(limit.toString())
            ).use { c ->
                while (c.moveToNext()) {
                    out.add(
                        PlayEventRecord(
                            sessionId = c.getString(0),
                            eventType = c.getString(1),
                            contentId = if (c.isNull(2)) null else c.getString(2),
                            contentName = c.getString(3),
                            durationSec = if (c.isNull(4)) null else c.getInt(4),
                            completed = if (c.isNull(5)) null else c.getInt(5) != 0,
                            startedAtMs = c.getLong(6),
                            endedAtMs = if (c.isNull(7)) null else c.getLong(7)
                        )
                    )
                }
            }
        } catch (e: Throwable) {
            Log.e("PlayEventQueue", "getPending failed: ${e.message}", e)
        }
        return out
    }

    fun markAcked(sessionId: String, eventType: String) {
        try {
            writableDatabase.delete(TABLE, "session_id = ? AND event_type = ?", arrayOf(sessionId, eventType))
        } catch (e: Throwable) {
            Log.e("PlayEventQueue", "markAcked failed: ${e.message}", e)
        }
    }
}
