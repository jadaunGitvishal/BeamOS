package com.remotedisplay.player.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Ref 39: coverage for the LRU-eviction planner that ContentCache.enforceStorageLimit()
 * delegates to. Pure JVM - no Android, no filesystem.
 */
class CacheEvictionTest {

    private val MB = 1024L * 1024L
    private fun e(id: String, sizeMb: Long, lastUsedMs: Long) =
        CacheEviction.Entry(id, sizeMb * MB, lastUsedMs)

    @Test fun noEvictionWhenAboveThreshold() {
        val entries = listOf(e("a", 100, 1), e("b", 100, 2))
        val plan = CacheEviction.plan(entries, currentFreeBytes = 600 * MB, minFreeBytes = 500 * MB)
        assertEquals(emptyList<String>(), plan)
    }

    @Test fun evictsLeastRecentlyUsedFirstUntilAboveThreshold() {
        // free=300MB, need 500MB -> must reclaim >=200MB.
        val entries = listOf(
            e("newest", 150, 3000),
            e("oldest", 150, 1000),
            e("middle", 150, 2000),
        )
        val plan = CacheEviction.plan(entries, currentFreeBytes = 300 * MB, minFreeBytes = 500 * MB)
        // oldest (150) -> 450 still < 500; middle (150) -> 600 >= 500 -> stop. newest untouched.
        assertEquals(listOf("oldest", "middle"), plan)
    }

    @Test fun stopsAsSoonAsThresholdIsMet() {
        val entries = listOf(e("oldest", 400, 1000), e("newer", 400, 2000))
        val plan = CacheEviction.plan(entries, currentFreeBytes = 200 * MB, minFreeBytes = 500 * MB)
        // one 400MB entry: 200 + 400 = 600 >= 500 -> only one evicted
        assertEquals(listOf("oldest"), plan)
    }

    @Test fun keepIdsAreNeverEvicted() {
        val entries = listOf(e("playing", 150, 1), e("stale", 150, 2))
        val plan = CacheEviction.plan(
            entries, currentFreeBytes = 300 * MB, minFreeBytes = 500 * MB, keepIds = setOf("playing"),
        )
        assertEquals(listOf("stale"), plan)
    }

    @Test fun returnsAllEvictableWhenStillShort() {
        val entries = listOf(e("a", 50, 1), e("b", 50, 2))
        val plan = CacheEviction.plan(entries, currentFreeBytes = 100 * MB, minFreeBytes = 500 * MB)
        // 100 + 50 + 50 = 200 < 500, nothing left -> evict both, caller logs "still below"
        assertEquals(listOf("a", "b"), plan)
    }

    @Test fun emptyContentIdsAreIgnored() {
        val entries = listOf(e("", 500, 1), e("real", 500, 2))
        val plan = CacheEviction.plan(entries, currentFreeBytes = 100 * MB, minFreeBytes = 500 * MB)
        assertEquals(listOf("real"), plan)
    }

    @Test fun emptyCacheYieldsEmptyPlan() {
        val plan = CacheEviction.plan(emptyList(), currentFreeBytes = 0, minFreeBytes = 500 * MB)
        assertEquals(emptyList<String>(), plan)
    }
}
