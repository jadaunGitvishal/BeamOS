#!/usr/bin/env node
/**
 * One-time production bootstrap for the single platform_admin account.
 *
 * This NEVER touches the public /api/auth/register endpoint - it writes
 * directly to the database from the server itself. This is the correct,
 * secure way to create the very first admin account in production: no
 * public-facing form is ever involved, so there's no window where anyone
 * else could register before you do.
 *
 * Usage (run on the server, e.g. via Render Shell or locally against a
 * local copy of the DB before first deploy):
 *
 *   node scripts/create-platform-admin.js <email> <name> <password>
 *
 * Example:
 *   node scripts/create-platform-admin.js jadaunVishal@gmail.com vishal MyS3curePass!
 *
 * Safe to run only once per email - it refuses to overwrite an existing
 * account. To replace an existing admin, delete their row from the
 * Platform Admin > All Users page first, then re-run this script.
 */

const path = require("path");
const crypto = require("crypto");
console.log("[debug] script started, args:", process.argv.slice(2));

const bcrypt = require(
  path.join(__dirname, "..", "server", "node_modules", "bcryptjs"),
);
console.log("[debug] bcrypt loaded");

const { db } = require(path.join(__dirname, "..", "server", "db", "database"));
console.log("[debug] database module loaded");

const [, , emailArg, nameArg, passwordArg] = process.argv;

async function main() {
  if (!emailArg || !nameArg || !passwordArg) {
    console.error(`
Usage: node scripts/create-platform-admin.js <email> <name> <password>

Example:
  node scripts/create-platform-admin.js jadaunVishal@gmail.com vishal MyS3curePass!
`);
    return 1;
  }

  const email = emailArg.trim().toLowerCase();
  const name = nameArg.trim();
  const password = passwordArg;

  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    return 1;
  }

  const existing = await db
    .prepare("SELECT id, role FROM users WHERE email = ?")
    .get(email);
  if (existing) {
    console.error(
      `A user with email "${email}" already exists (role: ${existing.role}). Refusing to overwrite.`,
    );
    console.error(
      "If you want to replace them, delete that account from Admin > All Users first, then re-run this script.",
    );
    return 1;
  }

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  console.log("[debug] about to insert user:", email);

  await db.prepare(
    `
  INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, trial_started, trial_plan)
  VALUES (?, ?, ?, ?, 'local', 'platform_admin', 'enterprise', NULL, NULL)
`,
  ).run(id, email, name, passwordHash);

  console.log("[debug] insert complete");

  console.log(`
Platform admin created successfully.

  Email: ${email}
  Name:  ${name}
  Role:  platform_admin

You can now log in at your BeamOS URL with this email and password.

IMPORTANT: make sure DISABLE_REGISTRATION=true is set as an environment
variable on your server, so no one else can ever self-register.
`);
  return 0;
}

main()
  .then((code) => db.close().finally(() => process.exit(code)))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
