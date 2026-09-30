// Ref 50: the device:command types a dashboard user may send to a device. Shared by
// the group route (routes/device-groups.js POST /:id/command) and the single-device
// route (routes/devices.js POST /:id/command) so the two can't drift. Every type here
// has a real handler in the Android WebSocketService.
const ALLOWED_COMMANDS = ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown'];

module.exports = { ALLOWED_COMMANDS };
