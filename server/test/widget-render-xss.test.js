'use strict';

// Verifies the public widget render endpoint sanitizes config that gets inlined
// into <style>/CSS (clock/weather/rss/social) and isolates the text widget's
// raw HTML in a sandboxed, null-origin iframe.
//
// The REAL widgets router, mounted as server.js mounts it (helpers/inprocess-app.js:
// the public GET /:id/render passes the auth front unauthenticated), against the REAL
// MySQL test DB (beamos_test via npm test). Fixtures are test-owned (wrx- prefix,
// generated ids); deleting the owner cascades the org, workspace and widgets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `wrx-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = { user: id('user'), org: id('org'), ws: id('ws') };

let app;
let base;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/widgets'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.user, `${P}@t.test`);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.org, `${P} Org`, ID.user);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.ws, ID.org, 'WS');
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(db, [ID.user]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const seed = (wid, type, config) => db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?,?,?,?,?,?)')
  .run(id(wid), ID.user, ID.ws, type, wid, JSON.stringify(config));
const render = async (wid) => (await fetch(`${base}/api/widgets/${id(wid)}/render`)).text();

const CSS_BREAKOUT = 'red}</style><script>document.title="pwned"</script><style>{';

test('clock widget: malicious background/color/font_size cannot break out of <style>', async () => {
  await seed('clock1', 'clock', { background: CSS_BREAKOUT, color: CSS_BREAKOUT, font_size: '64px}</style><script>x</script>' });
  const html = await render('clock1');
  assert.ok(!html.includes('</style><script>document.title'), 'CSS breakout payload must be rejected');
  assert.ok(html.includes('background:transparent'), 'invalid background falls back to default');
  assert.ok(/font-size:64px/.test(html), 'invalid font_size falls back to numeric default');
});

test('rss widget: scroll_speed/max_items coerced to numbers (no injection)', async () => {
  await seed('rss1', 'rss', { scroll_speed: '30s}</style><script>y</script>', max_items: '10);evil(' , background: CSS_BREAKOUT });
  const html = await render('rss1');
  assert.ok(!html.includes('</style><script>y'), 'scroll_speed cannot inject');
  assert.ok(!html.includes('evil('), 'max_items cannot inject into the script');
  assert.ok(html.includes('background:#000'), 'invalid background -> default');
});

test('text widget: raw HTML is isolated in a null-origin sandboxed iframe', async () => {
  await seed('text1', 'text', { html: '<script>parent.localStorage.token</script>', css: 'body{}' });
  const html = await render('text1');
  assert.ok(html.includes('<iframe sandbox="allow-scripts"'), 'user HTML wrapped in sandboxed iframe');
  assert.ok(!/<body[^>]*>\s*<script>parent\.localStorage/.test(html), 'raw script must not sit in the top-level (same-origin) document');
  assert.ok(html.includes('&lt;script&gt;parent.localStorage'), 'user script is escaped into srcdoc, runs only in the sandboxed frame');
});

test('valid color/gradient backgrounds are preserved', async () => {
  await seed('clock2', 'clock', { background: 'linear-gradient(45deg, #ff0000, #00ff00)', color: '#3B82F6' });
  const html = await render('clock2');
  assert.ok(html.includes('linear-gradient(45deg, #ff0000, #00ff00)'), 'legit gradient preserved');
  assert.ok(html.includes('color:#3B82F6'), 'legit hex color preserved');
});
