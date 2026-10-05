// Ref 50: the device:command types a dashboard user may send to a device. Shared by
// the group route (routes/device-groups.js POST /:id/command) and the single-device
// route (routes/devices.js POST /:id/command) so the two can't drift. Every type here
// has a real handler in the Android WebSocketService.
// Ref 47: kiosk lockdown (Android KioskLockdown: USB / storage / factory-reset / safe-boot /
// debugging restrictions + lock task). Handled in MainActivity's onCommand. Stricter gate
// than the rest: workspace admin or above (canAdminWorkspace) on the target's workspace.
const LOCKDOWN_COMMANDS = ['enable_kiosk_lockdown', 'disable_kiosk_lockdown'];
const ALLOWED_COMMANDS = ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown', ...LOCKDOWN_COMMANDS];

module.exports = { ALLOWED_COMMANDS, LOCKDOWN_COMMANDS };
