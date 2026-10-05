package com.remotedisplay.player.service

/**
 * Ref 47: the single source of truth for WHICH user restrictions kiosk lockdown applies
 * on a given Android version. Pure (no Android framework calls), so it is JVM-unit-tested
 * (LockdownPolicyTest) and [KioskLockdown]'s enable / disable / rollback can never drift.
 *
 * String literals rather than UserManager.* references so this stays framework-free; each
 * value is exactly the UserManager constant named beside it, at the API level it was added.
 */
object LockdownPolicy {
    const val DISALLOW_USB_FILE_TRANSFER = "no_usb_file_transfer"       // UserManager.DISALLOW_USB_FILE_TRANSFER, API 21
    const val DISALLOW_MOUNT_PHYSICAL_MEDIA = "no_physical_media"       // UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA, API 21
    const val DISALLOW_FACTORY_RESET = "no_factory_reset"               // UserManager.DISALLOW_FACTORY_RESET, API 21
    const val DISALLOW_SAFE_BOOT = "no_safe_boot"                       // UserManager.DISALLOW_SAFE_BOOT, API 23
    const val DISALLOW_DEBUGGING_FEATURES = "no_debugging_features"     // UserManager.DISALLOW_DEBUGGING_FEATURES, API 21

    private const val API_LOLLIPOP = 21
    private const val API_MARSHMALLOW = 23
    private const val API_PIE = 28

    /**
     * Restrictions [KioskLockdown.enable] applies, in order. USB debugging is only blocked
     * in a release build - a debug build must stay reachable over adb for development.
     */
    fun restrictions(sdkInt: Int, isDebugBuild: Boolean): List<String> {
        val list = mutableListOf<String>()
        if (sdkInt >= API_LOLLIPOP) {
            list += DISALLOW_USB_FILE_TRANSFER
            list += DISALLOW_MOUNT_PHYSICAL_MEDIA
            list += DISALLOW_FACTORY_RESET
        }
        if (sdkInt >= API_MARSHMALLOW) list += DISALLOW_SAFE_BOOT
        if (!isDebugBuild && sdkInt >= API_LOLLIPOP) list += DISALLOW_DEBUGGING_FEATURES
        return list
    }

    /**
     * Restrictions [KioskLockdown.disable] clears: the release-build set (the union of both
     * build types), so a debug build still clears DISALLOW_DEBUGGING_FEATURES left behind
     * by a release build that previously ran on the same device.
     */
    fun restrictionsToClear(sdkInt: Int): List<String> = restrictions(sdkInt, isDebugBuild = false)

    /** DevicePolicyManager.setLockTaskFeatures() exists from Android 9 (API 28). Below
     *  that, lock task mode itself still works; it just has no configurable feature set. */
    fun supportsLockTaskFeatures(sdkInt: Int): Boolean = sdkInt >= API_PIE
}
