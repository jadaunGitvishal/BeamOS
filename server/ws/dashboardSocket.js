const heartbeat = require('../services/heartbeat');
const { verifyToken } = require('../middleware/auth');
const { db } = require('../db/database');
const { accessContext, accessibleWorkspaceIds } = require('../lib/tenancy');
const { workspaceRoom } = require('../lib/socket-rooms');
const { protectSocket } = require('../lib/safe-socket');

// Phase 2.3: workspace-scoped socket rooms + per-command permission gates.
// Replaces the previous flat dashboardNs.emit broadcast (which leaked every
// device's status/screenshot/playback events to every connected dashboard)
// and the legacy admin/superadmin role bypass (dead code post-Phase-1
// rename - admin -> user, superadmin -> platform_admin).
//
// On connect: enumerate the user's accessible workspace_ids and socket.join
// a room per workspace. Outbound broadcasts route via dashboardNs.to(room).
// Inbound commands check permission against the target device's workspace.

// Permission gate for inbound socket commands. Read tier = workspace_viewer+;
// write tier = workspace_editor+. Platform_admin and org_owner/admin always
// pass via actingAs.
async function canActOnDevice(socket, deviceId, tier /* 'read' | 'write' */) {
  const device = await db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.workspace_id) return false;
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  if (!ws) return false;
  const ctx = await accessContext(socket.userId, socket.userRole, ws);
  if (!ctx) return false;
  if (ctx.actingAs) return true; // platform_admin or org admin
  if (tier === 'read') return !!ctx.workspaceRole; // viewer/editor/admin all OK
  // write tier: workspace_editor or workspace_admin
  return ctx.workspaceRole === 'workspace_editor' || ctx.workspaceRole === 'workspace_admin';
}

module.exports = function setupDashboardSocket(io) {
  const dashboardNs = io.of('/dashboard');
  const deviceNs = io.of('/device');

  dashboardNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  dashboardNs.on('connection', async (socket) => {
    // #146: same per-connection fail-fast as the device namespace — a throwing
    // dashboard handler disconnects only that client, never crashes the server.
    // Must run before ANY socket.on() below — it wraps socket.on itself, so a
    // listener registered before this call would bypass the protection entirely.
    protectSocket(socket, () => socket.userId);

    // Ref 35 Stage C follow-up: these listeners used to be registered AFTER the
    // `await accessibleWorkspaceIds(...)` below. That await is a real DB query, and a
    // client's 'connect' event fires as soon as the transport handshake completes —
    // independent of how long this async handler body takes to run. A client that
    // emits a dashboard:* event immediately on 'connect' could beat the server to
    // registering these listeners: socket.io has no handler to invoke yet, so the
    // event (and any ack) is silently dropped with no error, just a timed-out ack.
    // Reproduced live: with the DB query artificially slowed (simulating a cold
    // connection-pool member after inactivity, which is what made this bite in real
    // testing), an immediate-on-connect emit reliably timed out against the old
    // ordering and reliably succeeds against this one.
    //
    // None of these handlers need `wsIds` — they resolve their own permissions via
    // canActOnDevice() per call — so registration has no real dependency on the
    // workspace lookup below. Only the room-join genuinely needs it, so that (and
    // only that) stays after the await. Registration and readiness are different
    // concerns; conflating them was the bug.
    socket.on('dashboard:request-screenshot', async (data) => {
      const { device_id } = data;
      if (!await canActOnDevice(socket, device_id, 'read')) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) deviceNs.to(device_id).emit('device:screenshot-request', {});
    });

    socket.on('dashboard:remote-touch', async (data) => {
      const { device_id, x, y, action } = data;
      if (!await canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, action });
    });

    socket.on('dashboard:remote-key', async (data) => {
      const { device_id, keycode } = data;
      if (!await canActOnDevice(socket, device_id, 'write')) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
    });

    socket.on('dashboard:remote-start', async (data) => {
      const { device_id } = data;
      if (!await canActOnDevice(socket, device_id, 'write')) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
    });

    socket.on('dashboard:remote-stop', async (data) => {
      const { device_id } = data;
      if (!await canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
    });

    socket.on('dashboard:device-command', async (data, ack) => {
      const { device_id, type, payload } = data;
      if (!await canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }
      const room = deviceNs.adapter.rooms.get(device_id);
      if (room && room.size > 0) {
        deviceNs.to(device_id).emit('device:command', { type, payload });
        console.log(`Command delivered to device ${device_id}: ${type}`);
        if (typeof ack === 'function') ack({ delivered: true });
        return;
      }
      // Device offline at emit time. Try to queue (lazy require so reverting
      // the queue commit doesn't break this commit - MODULE_NOT_FOUND on the
      // first try gets cached by Node's module loader, giving consistent
      // queued=false behavior on every subsequent call).
      let queued = false;
      try {
        const queue = require('../lib/command-queue');
        queued = queue.queueCommand(device_id, type, payload);
      } catch (e) { /* command-queue module absent; fall through to lost */ }
      console.log(`Command for offline device ${device_id}: ${type} (queued=${queued})`);
      if (typeof ack === 'function') ack({ delivered: false, queued, reason: 'offline' });
    });

    socket.on('disconnect', () => {
      console.log(`Dashboard client disconnected: ${socket.id}`);
    });

    // Note on workspace-switch lifecycle: the switcher (Phase 3 MVP) calls
    // window.location.reload() after switching, which forces a new socket
    // connection with fresh JWT claims. So workspace memberships are
    // re-evaluated at connect time and we don't need to re-evaluate per-emit.
    //
    // This is the only part of connection setup that genuinely needs
    // accessibleWorkspaceIds()'s result, so it's the only part still gated on the
    // await - the listener registrations above no longer wait on it.
    const wsIds = await accessibleWorkspaceIds(socket.userId, socket.userRole);
    for (const wsId of wsIds) socket.join(workspaceRoom(wsId));
    console.log(`Dashboard client connected: ${socket.id} (user: ${socket.userId}, rooms: ${wsIds.length})`);
  });

  return dashboardNs;
};

