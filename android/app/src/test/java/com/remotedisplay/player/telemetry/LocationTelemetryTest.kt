package com.remotedisplay.player.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Ref 32: coverage for the pure permission + coordinate logic that LocationProvider
 * and DeviceInfo delegate to. Pure JVM - no Android, no Play Services.
 */
class LocationTelemetryTest {

    // ---- hasLocationPermission ----

    @Test fun permissionGrantedWhenFineOnly() {
        assertEquals(true, LocationTelemetry.hasLocationPermission(fineGranted = true, coarseGranted = false))
    }

    @Test fun permissionGrantedWhenCoarseOnly() {
        assertEquals(true, LocationTelemetry.hasLocationPermission(fineGranted = false, coarseGranted = true))
    }

    @Test fun permissionGrantedWhenBoth() {
        assertEquals(true, LocationTelemetry.hasLocationPermission(fineGranted = true, coarseGranted = true))
    }

    @Test fun permissionDeniedWhenNeither() {
        assertEquals(false, LocationTelemetry.hasLocationPermission(fineGranted = false, coarseGranted = false))
    }

    // ---- sanitize: graceful null ----

    @Test fun nullLatitudeYieldsNull() {
        assertNull(LocationTelemetry.sanitize(null, 12.34))
    }

    @Test fun nullLongitudeYieldsNull() {
        assertNull(LocationTelemetry.sanitize(51.5, null))
    }

    @Test fun bothNullYieldsNull() {
        assertNull(LocationTelemetry.sanitize(null, null))
    }

    @Test fun nanYieldsNull() {
        assertNull(LocationTelemetry.sanitize(Double.NaN, 10.0))
        assertNull(LocationTelemetry.sanitize(10.0, Double.NaN))
    }

    @Test fun infiniteYieldsNull() {
        assertNull(LocationTelemetry.sanitize(Double.POSITIVE_INFINITY, 10.0))
        assertNull(LocationTelemetry.sanitize(10.0, Double.NEGATIVE_INFINITY))
    }

    // ---- sanitize: range ----

    @Test fun latitudeOutOfRangeYieldsNull() {
        assertNull(LocationTelemetry.sanitize(90.0001, 10.0))
        assertNull(LocationTelemetry.sanitize(-90.5, 10.0))
    }

    @Test fun longitudeOutOfRangeYieldsNull() {
        assertNull(LocationTelemetry.sanitize(10.0, 180.5))
        assertNull(LocationTelemetry.sanitize(10.0, -181.0))
    }

    @Test fun exactRangeBoundsAreAccepted() {
        assertEquals(LocationTelemetry.Fix(90.0, 180.0), LocationTelemetry.sanitize(90.0, 180.0))
        assertEquals(LocationTelemetry.Fix(-90.0, -180.0), LocationTelemetry.sanitize(-90.0, -180.0))
    }

    // ---- sanitize: Null Island ----

    @Test fun zeroZeroIsRejectedAsNullIsland() {
        assertNull(LocationTelemetry.sanitize(0.0, 0.0))
    }

    @Test fun zeroOnOneAxisOnlyIsFine() {
        assertEquals(LocationTelemetry.Fix(0.0, 12.5), LocationTelemetry.sanitize(0.0, 12.5))
        assertEquals(LocationTelemetry.Fix(45.0, 0.0), LocationTelemetry.sanitize(45.0, 0.0))
    }

    // ---- sanitize: happy path + rounding ----

    @Test fun validFixIsReturned() {
        assertEquals(
            LocationTelemetry.Fix(37.422408, -122.084068),
            LocationTelemetry.sanitize(37.422408, -122.084068)
        )
    }

    @Test fun coordsAreRoundedToSixDecimals() {
        val fix = LocationTelemetry.sanitize(37.4224082733, -122.0840684311)!!
        assertEquals(37.422408, fix.latitude, 1e-9)
        assertEquals(-122.084068, fix.longitude, 1e-9)
    }
}
