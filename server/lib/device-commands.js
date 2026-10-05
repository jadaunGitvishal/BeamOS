// Ref 50: the device:command types a dashboard user may send to a device. Shared by
// the group route (routes/device-groups.js POST /:id/command) and the single-device
// route (routes/devices.js POST /:id/command) so the two can't drift. Every type here
// has a real handler in the Android WebSocketService.
// Ref 47: kiosk lockdown (Android KioskLockdown: USB / storage / factory-reset / safe-boot /
// debugging restrictions + lock task). Handled in MainActivity's onCommand. Stricter gate
// than the rest: workspace admin or above (canAdminWorkspace) on the target's workspace.
const LOCKDOWN_COMMANDS = ['enable_kiosk_lockdown', 'disable_kiosk_lockdown'];
const ALLOWED_COMMANDS = ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown', ...LOCKDOWN_COMMANDS];

// Dashboard socket path (ws/dashboardSocket.js dashboard:device-command): exactly the set
// the main app's device page sends over the socket (frontend/js/views/device-detail.js via
// socket.js sendCommand) - nothing more. Kiosk lockdown is deliberately NOT here: it is
// REST-only (POST /:id/command), where the workspace-admin gate lives, so the socket can't
// bypass it. refresh / pip_debug / power_menu have device-side handlers but the dashboard
// never sends them, so they are excluded too.
const SOCKET_COMMANDS = [
  ...ALLOWED_COMMANDS.filter((t) => !LOCKDOWN_COMMANDS.includes(t)),
  'settings', 'enable_system_capture', 'set_debug', 'request_location',
];

module.exports = { ALLOWED_COMMANDS, LOCKDOWN_COMMANDS, SOCKET_COMMANDS };
