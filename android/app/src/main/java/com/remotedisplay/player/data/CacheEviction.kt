package com.remotedisplay.player.data

/**
 * Ref 39: pure (no Android deps) LRU-eviction planner for [ContentCache].
 *
 * Kept separate from ContentCache so the threshold / ordering logic is unit-testable on
 * a plain JVM (ContentCache itself needs android.util.Log + a real filesystem).
 */
object CacheEviction {

    /** Default free-space floor before eviction kicks in. Overridable per [ContentCache] instance. */
    const val DEFAULT_MIN_FREE_BYTES = 500L * 1024 * 1024 // 500 MB

    /**
     * One cached content file. [lastUsedMs] is the file's lastModified timestamp, which
     * ContentCache bumps on every cache hit, so it tracks last USE, not just download time.
     */
    data class Entry(val contentId: String, val sizeBytes: Long, val lastUsedMs: Long)

    /**
     * Choose which cache entries to purge, least-recently-used first, until the projected
     * free space is back at/above [minFreeBytes].
     *
     * @return the content ids to delete, in eviction order. Empty when there's already
     *         enough headroom, or when nothing evictable is left.
     * @param keepIds entries that must never be chosen (e.g. the item currently downloading).
     */
    fun plan(
        entries: List<Entry>,
        currentFreeBytes: Long,
        minFreeBytes: Long = DEFAULT_MIN_FREE_BYTES,
        keepIds: Set<String> = emptySet(),
    ): List<String> {
        if (currentFreeBytes >= minFreeBytes) return emptyList()

        val victims = ArrayList<String>()
        var projectedFree = currentFreeBytes
        val candidates = entries
            .filter { it.contentId.isNotEmpty() && it.contentId !in keepIds }
            .sortedBy { it.lastUsedMs } // oldest-used first
        for (e in candidates) {
            if (projectedFree >= minFreeBytes) break
            victims.add(e.contentId)
            projectedFree += e.sizeBytes
        }
        return victims
    }
}
