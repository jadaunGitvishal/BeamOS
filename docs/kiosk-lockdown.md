# Kiosk lockdown (Android player)

Kiosk lockdown stops people at the screen from getting at the device. It blocks
USB file transfer, external storage, factory reset from Settings, safe mode and
USB debugging, and pins the screen to BeamOS (Android "lock task" mode).

It is **manual**. An admin turns it on per device (or per group) from the portal.
It is never turned on automatically during provisioning or when the app becomes
device owner.

Code: [`KioskLockdown.kt`](../android/app/src/main/java/com/remotedisplay/player/service/KioskLockdown.kt)
applies it. [`LockdownPolicy.kt`](../android/app/src/main/java/com/remotedisplay/player/service/LockdownPolicy.kt)
decides which restrictions apply on which Android version.

## Requirements

- **Device owner.** Every call needs the app to be the device owner (provisioned
  with the Device Owner QR or `dpm set-device-owner`). On a device that isn't, the
  command is ignored and logged (`KioskLockdown: enable: not device owner, refusing`).
  Nothing changes on the device.
- **Workspace admin.** Only a workspace admin, org owner/admin or platform admin
  can send the commands. Workspace editors, viewers and platform operators get `403`.

## Turning it on and off

- **Portal:** device page → *Enable kiosk lockdown* / *Disable kiosk lockdown*.
  The buttons only appear for users who can administer the device's workspace.
  Enabling asks for confirmation first.
- **API:** `POST /api/devices/<id>/command` or `POST /api/groups/<id>/command` with
  `{"type": "enable_kiosk_lockdown"}` or `{"type": "disable_kiosk_lockdown"}`.
  API tokens need the `full` scope.
- **Not over the dashboard socket.** The live dashboard socket
  (`dashboard:device-command`) refuses both lockdown commands with reason
  `use_rest`, so the admin-only REST routes are the only way to send them. The
  socket also refuses any command type outside the set the device page sends
  (reason `unsupported_command`), online or offline. Refused commands are logged
  and never queued.

The setting survives reboots. The app saves it and re-applies the policy and
re-enters lock task mode every time it starts.

## What's blocked on each Android version

| | Android 5.x (API 21–22) | Android 6–8 (API 23–27) | Android 9+ (API 28+) |
|---|---|---|---|
| USB file transfer (`DISALLOW_USB_FILE_TRANSFER`) | Blocked | Blocked | Blocked |
| External storage: SD card / USB drive (`DISALLOW_MOUNT_PHYSICAL_MEDIA`) | Blocked | Blocked | Blocked |
| Factory reset from Settings (`DISALLOW_FACTORY_RESET`) | Blocked | Blocked | Blocked |
| USB debugging (`DISALLOW_DEBUGGING_FEATURES`) | Blocked (release builds) | Blocked (release builds) | Blocked (release builds) |
| Safe mode (`DISALLOW_SAFE_BOOT`) | **Not available** | Blocked | Blocked |
| Screen pinned to BeamOS (lock task) | Yes | Yes | Yes |
| Home and Recents | Hidden by lock task | Hidden by lock task | Hidden |
| Notification shade, status bar, power menu | Platform default for lock task (expected: power menu still available) | Platform default for lock task (expected: power menu still available) | Hidden (`LOCK_TASK_FEATURE_NONE`) |

Notes:

- **Android 9+ only:** `setLockTaskFeatures(LOCK_TASK_FEATURE_NONE)` is what hides
  the notification shade, status bar info and the long-press power menu. That call
  doesn't exist below Android 9. On older versions lock task mode uses the
  platform's fixed behaviour, which hides Home and Recents.
- **Fixed in Ref 47:** before this change, `setLockTaskFeatures` ran on every
  version. On Android 5–8 it threw, and the error handling rolled everything back,
  so **no lockdown applied on Android 5–8 at all**. Android 5.x also never entered
  lock task, because the lock-state check used an API 23 method. Both calls are now
  version-guarded. External storage was also blocked only on 9+; it now applies
  from Android 5.
- **USB debugging:** blocked only in **release** builds. A debug build keeps adb
  working so developers can still reach the device. Turning lockdown off always
  clears the debugging restriction, even from a debug build, in case a release
  build set it earlier.

## Physical buttons

Device-owner APIs can't disable hardware keys:

- **Power key:** a short press still turns the screen off and on. On Android 9+ the
  long-press power menu is hidden by lock task. Below 9 it is expected to still
  appear.
- **Volume keys:** still work. Android has a separate `DISALLOW_ADJUST_VOLUME`
  restriction, but kiosk lockdown doesn't apply it.

If these matter, the enclosure has to cover the buttons.

## Recovery

- **Turning it off remotely needs the device online.** *Disable kiosk lockdown* is
  delivered over the device's live connection. For an offline device the server
  holds the command for only about 30 seconds, then drops it, and the portal
  says so. Plan on reaching the device while it's online.
- **Recovery-menu factory reset:** `DISALLOW_FACTORY_RESET` blocks the Settings
  reset. It is not expected to block a wipe from the bootloader recovery menu
  (hardware key combination). **To be confirmed on PMI hardware.** That wipe is
  the last-resort recovery, and it also removes device owner.
- **Debug builds** keep adb, so a developer can still get in that way.
- Removing device owner also makes Android drop the restrictions and the lock
  task allowlist.

## Checking a device (adb, debug build or before lockdown)

```bash
# Restrictions currently set for user 0
adb shell dumpsys user | grep -A20 "Restrictions"
# Lock task state (LOCKED = pinned)
adb shell dumpsys activity activities | grep mLockTaskModeState
# App log lines
adb logcat -s KioskLockdown
```

## Known gaps

- Not yet verified on PMI hardware: the per-version table above, the power menu
  and notification shade below Android 9, and the recovery-menu wipe.
