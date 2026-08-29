package com.remotedisplay.player.telemetry

/**
 * Ref 32: pure (no Android deps) permission + coordinate logic for GPS telemetry.
 *
 * Kept separate from [LocationProvider] (which needs Play Services + a real
 * FusedLocationProviderClient) so the "should we even try" and "is this fix usable"
 * decisions are unit-testable on a plain JVM. The server mirrors [sanitize] in
 * server/lib/geo.js so both ends agree on what counts as a valid fix.
 */
object LocationTelemetry {

    /**
     * True when the app holds at least one location grant. Either FINE or COARSE is
     * enough for FusedLocationProvider to return a fix - COARSE just yields a
     * lower-accuracy one, which is fine for "where is this screen" telemetry.
     */
    fun hasLocationPermission(fineGranted: Boolean, coarseGranted: Boolean): Boolean =
        fineGranted || coarseGranted

    /** A sanitized, telemetry-ready coordinate pair. */
    data class Fix(val latitude: Double, val longitude: Double)

    /**
     * Turn a raw lat/long (typically straight off android.location.Location) into a
     * [Fix], or null when it is unusable and telemetry should just omit the fields:
     *   - either value missing / NaN / infinite
     *   - latitude outside [-90, 90] or longitude outside [-180, 180]
     *   - exactly (0, 0) - "Null Island", overwhelmingly a default/failed fix, never
     *     a real screen location
     *
     * A kept fix is rounded to 6 decimal places (~11 cm), which is far finer than any
     * consumer-GPS fix and keeps the stored value tidy.
     */
    fun sanitize(latitude: Double?, longitude: Double?): Fix? {
        if (latitude == null || longitude == null) return null
        if (!latitude.isFinite() || !longitude.isFinite()) return null
        if (latitude < -90.0 || latitude > 90.0) return null
        if (longitude < -180.0 || longitude > 180.0) return null
        if (latitude == 0.0 && longitude == 0.0) return null
        return Fix(round6(latitude), round6(longitude))
    }

    private fun round6(v: Double): Double = Math.round(v * 1_000_000.0) / 1_000_000.0
}
