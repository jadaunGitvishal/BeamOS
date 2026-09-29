'use strict';

// Ref 8: SCIM 2.0 inbound provisioning (RFC 7643 core schema, RFC 7644 protocol),
// shaped for Microsoft Entra ID's provisioning service. Mounted at /scim/v2 by
// server.js behind middleware/scimAuth.js (NOT via config/api-surface.js - see the
// comment at the mount point in server.js for why).
//
// Scope: /Users only. Groups are optional per Microsoft ("Groups are optional, but
// only supported if the SCIM implementation supports PATCH") and BeamOS has no
// Entra-group -> role mapping to feed them into (docs/rbac.md known gap), so
// /Groups is deliberately absent - Entra's admin should provision users only.
//
// Sources cited below:
//   [RFC7643] https://www.rfc-editor.org/rfc/rfc7643   (schemas / resource shapes)
//   [RFC7644] https://www.rfc-editor.org/rfc/rfc7644   (protocol / errors / PATCH)
//   [MS-SCIM] https://learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups
//   [MS-KNOWN] https://learn.microsoft.com/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility
//
// Resource mapping (one BeamOS user <-> one SCIM User):
//   id          users.id (server-assigned UUID)
//   userName    users.email (lowercased, the login key) + users.scim_user_name
//               (verbatim, returned as-is: [MS-SCIM] "Values sent should be
//               stored in the same format they were sent")
//   externalId  users.scim_external_id (verbatim)
//   displayName users.name
//   active      users.deactivated_at IS NULL  (false -> deactivate, Stage 2's
//               instant per-request revocation; true -> reactivate)
//   emails      derived, read-only: [{ value: users.email, type: 'work', primary: true }]
// Attributes BeamOS has no column for (name.givenName, title, phoneNumbers, the
// enterprise extension, ...) are ACCEPTED AND IGNORED on POST/PUT/PATCH rather than
// rejected: Entra's default mapping sends several of them, and a 400 on each would
// fail every user's provisioning until an admin trims the mapping. /Schemas
// advertises only what's actually stored, so the gap is discoverable.
//
// Tenancy: a SCIM token is bound to ONE organization (scim_tokens.organization_id).
// It sees and modifies ONLY users who are members of that organization - its
// "directory" - and every lookup below is joined through organization_members.

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');
const { isPlatformRole } = require('../middleware/auth');
const { scimAuth, scimError } = require('../middleware/scimAuth');
const { setUserDeactivated } = require('../lib/user-deactivation');
const { logActivity, getClientIp } = require('../services/activity');
const { isDuplicateKeyError } = require('../lib/outage-format');

const router = express.Router();

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RT_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

const MAX_RESULTS = 100; // advertised as filter.maxResults in ServiceProviderConfig

// organization_members.role vocabulary (routes/organizations.js ORG_ROLES).
const ORG_ROLES = ['org_owner', 'org_admin', 'field_technician'];
const DEFAULT_ORG_ROLE = 'field_technician';
const SCIM_ORG_ROLE = ORG_ROLES.includes(config.scimDefaultOrgRole) ? config.scimDefaultOrgRole : DEFAULT_ORG_ROLE;
if (SCIM_ORG_ROLE !== config.scimDefaultOrgRole) {
  console.warn(`[scim] SCIM_DEFAULT_ORG_ROLE="${config.scimDefaultOrgRole}" is not one of ${ORG_ROLES.join('/')}; using "${DEFAULT_ORG_ROLE}"`);
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

// [MS-SCIM]: "The header for all the responses should be of content-Type:
// application/scim+json". JSON.stringify(undefined-valued keys) drops them, which
// also satisfies "If a value isn't present, don't send null values".
function send(res, status, body) {
  return res.status(status).type('application/scim+json').send(JSON.stringify(body));
}

// Router-level body parser: Entra sends Content-Type: application/scim+json
// ([MS-SCIM] request examples), which express.json()'s default type filter ignores.
// This router is mounted BEFORE server.js's global express.json() so it owns
// parsing for both types and malformed JSON gets a SCIM-shaped 400 (error handler
// at the bottom) instead of the app's generic error page.
router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
// Every endpoint - including the three discovery ones - requires the bearer token.
// Entra sends it on every call, Test Connection included, and not advertising the
// user schema/feature set to anonymous callers costs nothing.
router.use(scimAuth);

function baseUrl(req) {
  const origin = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${origin}${req.baseUrl}`;
}

const iso = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString() : undefined);

class ScimError extends Error {
  constructor(status, detail, scimType) { super(detail); this.status = status; this.scimType = scimType; }
}
const bad = (detail, scimType = 'invalidValue') => new ScimError(400, detail, scimType);

// RFC 7643 §4.1 User representation + §3.1 common attributes (id, externalId, meta).
function toScimUser(row, base) {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    externalId: row.scim_external_id || undefined,
    userName: row.scim_user_name || row.email,
    displayName: row.name || undefined,
    active: !row.deactivated_at,
    emails: [{ value: row.email, type: 'work', primary: true }],
    meta: {
      resourceType: 'User',
      created: iso(row.created_at),
      lastModified: iso(row.updated_at),
      location: `${base}/Users/${row.id}`,
    },
  };
}

const USER_COLS = 'u.id, u.email, u.name, u.role, u.created_at, u.updated_at, u.deactivated_at, u.scim_external_id, u.scim_user_name';

// A user is visible to this token only via membership in the token's organization.
async function findMember(orgId, userId) {
  return db.prepare(
    `SELECT ${USER_COLS} FROM users u
     JOIN organization_members om ON om.user_id = u.id AND om.organization_id = ?
     WHERE u.id = ?`,
  ).get(orgId, userId);
}

// Lockout guard: SCIM may deactivate ANYONE in its org, platform admins included
// (an offboarded admin must lose access too - that's the point of Ref 8), EXCEPT the
// last remaining active platform admin, which would leave the deployment with no one
// able to administer it (or to fix a misconfigured provisioning job). Same spirit as
// routes/auth.js's "Cannot demote yourself" guard.
async function assertNotLastPlatformAdmin(user) {
  if (!isPlatformRole(user.role) || user.deactivated_at) return;
  const others = await db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role IN ('platform_admin','superadmin') AND deactivated_at IS NULL AND id <> ?",
  ).get(user.id);
  if (Number(others.n) === 0) {
    throw new ScimError(403, 'Refusing to deactivate the last active platform admin of this BeamOS deployment. Promote another platform admin first.');
  }
}

// ---------------------------------------------------------------------------
// attribute parsing (shared by POST / PUT / PATCH)
// ---------------------------------------------------------------------------

// [MS-KNOWN]: WITHOUT the aadOptscim062020 flag (the current default), Entra sends
// {"op":"Replace","path":"active","value":"False"} - a STRING - and only sends a
// JSON boolean with the flag. Both documented shapes are accepted; anything else is
// a 400 rather than a guess.
function parseActive(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw bad('"active" must be a boolean');
}

function parseUserName(v) {
  if (typeof v !== 'string' || !v.trim()) throw bad('"userName" is required', 'invalidValue');
  const s = v.trim();
  // BeamOS accounts are keyed by email (users.email UNIQUE NOT NULL; every login
  // path looks the account up by it), so userName must be email-shaped - Entra's
  // default mapping (userPrincipalName -> userName) always is.
  if (!s.includes('@') || s.length > 255) {
    throw bad('"userName" must be an email address (BeamOS accounts are keyed by email); map userPrincipalName or mail to userName');
  }
  return s;
}

function parseOptString(v, attr) {
  if (v === null) return null;
  if (typeof v !== 'string') throw bad(`"${attr}" must be a string`);
  return v.length > 255 ? v.slice(0, 255) : v;
}

// RFC 7643 §4.1.1: displayName; fall back to name.formatted / given+family.
function deriveDisplayName(body) {
  if (typeof body.displayName === 'string' && body.displayName.trim()) return body.displayName.trim().slice(0, 255);
  const n = body.name && typeof body.name === 'object' ? body.name : null;
  if (n) {
    if (typeof n.formatted === 'string' && n.formatted.trim()) return n.formatted.trim().slice(0, 255);
    const joined = [n.givenName, n.familyName].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    if (joined) return joined.slice(0, 255);
  }
  return undefined;
}

// Full-resource body (POST / PUT).
function readUserBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be a SCIM User resource', 'invalidSyntax');
  return {
    userName: parseUserName(body.userName),
    externalId: body.externalId === undefined ? undefined : parseOptString(body.externalId, 'externalId'),
    displayName: deriveDisplayName(body),
    active: body.active === undefined ? undefined : parseActive(body.active),
  };
}

// Attribute path -> canonical lowercase key. Attribute names are case-insensitive
// (RFC 7643 §2.1), and a path may carry the core schema URN prefix (RFC 7644 §3.10).
function normPath(path) {
  let p = String(path).trim();
  if (p.toLowerCase().startsWith(USER_SCHEMA.toLowerCase() + ':')) p = p.slice(USER_SCHEMA.length + 1);
  return p.toLowerCase();
}

// Apply ONE PATCH target (path + value) to the pending change set.
function applyPatchAttr(changes, path, value, op) {
  switch (normPath(path)) {
    case 'active':
      if (op === 'remove') throw bad('"active" cannot be removed', 'mutability');
      changes.active = parseActive(value);
      return;
    case 'username':
      if (op === 'remove') throw bad('"userName" is required and cannot be removed', 'mutability');
      changes.userName = parseUserName(value);
      return;
    case 'displayname':
      changes.displayName = op === 'remove' ? '' : String(parseOptString(value, 'displayName') || '').trim();
      return;
    case 'externalid':
      changes.externalId = op === 'remove' ? null : parseOptString(value, 'externalId');
      return;
    default:
      // name.givenName, emails[type eq "work"].value, title, enterprise extension...:
      // no BeamOS column - accepted and ignored (see header).
  }
}

// RFC 7644 §3.5.2. Entra emits op as "Add"/"Replace"/"Remove" ([MS-SCIM]: "Don't
// require a case-sensitive match on ... op"), and with the aadOptscim062020 flag
// may send a path-less replace whose value is an object keyed by (possibly dotted)
// attribute paths ([MS-KNOWN] "Requests to replace multiple attributes").
function readPatchBody(body) {
  const ops = body && body.Operations;
  if (!Array.isArray(ops) || ops.length === 0) throw bad('PATCH body must carry a non-empty "Operations" array', 'invalidSyntax');
  const changes = {};
  for (const operation of ops) {
    const op = String((operation && operation.op) || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw bad(`Unsupported PATCH op "${operation && operation.op}"`, 'invalidSyntax');
    if (operation.path) {
      applyPatchAttr(changes, operation.path, operation.value, op);
    } else {
      if (op === 'remove') throw bad('"remove" requires a "path"', 'noTarget');
      const v = operation.value;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('A PATCH operation without "path" must carry an object "value"', 'invalidSyntax');
      for (const [k, val] of Object.entries(v)) applyPatchAttr(changes, k, val, op);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// filter (RFC 7644 §3.4.2.2) - the subset Entra actually uses
// ---------------------------------------------------------------------------
// [MS-SCIM]: "Microsoft Entra-only uses the following operators: eq, and", and
// users are "queried with their userName and externalId". Entra's own example also
// sends an UNQUOTED value (`filter=externalId eq jyoung`), so a bare token is
// accepted as a string. Anything else (or / not / co / sw / grouping) -> 400
// invalidFilter, never a silently-wrong result set.

function splitAnd(filter) {
  const parts = [];
  let buf = '', inQuote = false, depth = 0;
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i];
    if (c === '"' && filter[i - 1] !== '\\') inQuote = !inQuote;
    if (!inQuote) {
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (depth === 0) {
        const m = /^\s+and\s+/i.exec(filter.slice(i));
        if (m && /\s/.test(c)) { parts.push(buf); buf = ''; i += m[0].length - 1; continue; }
      }
    }
    buf += c;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseFilterValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { throw bad(`Malformed filter value ${v}`, 'invalidFilter'); }
  }
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^\S+$/.test(v)) return v; // bare token (Entra's externalId example)
  throw bad(`Malformed filter value ${v}`, 'invalidFilter');
}

// Returns { where: [sql], params: [] } to AND onto the org-scoped user query.
function compileFilter(filter) {
  const where = [], params = [];
  for (const clause of splitAnd(filter)) {
    const m = /^([A-Za-z][\w.:-]*(?:\[[^\]]*\])?(?:\.[A-Za-z]\w*)?)\s+(\w+)\s+(.+)$/.exec(clause);
    if (!m) throw bad(`Unsupported filter "${clause}"`, 'invalidFilter');
    if (m[2].toLowerCase() !== 'eq') throw bad(`Unsupported filter operator "${m[2]}" (only "eq" and "and" are supported)`, 'invalidFilter');
    const attr = normPath(m[1]).replace(/\s+/g, '');
    const value = parseFilterValue(m[3]);
    if (['username', 'emails', 'emails.value', 'emails[typeeq"work"].value'].includes(attr)) {
      // userName is caseExact:false (RFC 7643 §4.1.1) and stored lowercased.
      if (typeof value !== 'string') throw bad('userName filter value must be a string', 'invalidFilter');
      where.push('u.email = ?'); params.push(value.trim().toLowerCase());
    } else if (attr === 'externalid') {
      if (typeof value !== 'string') throw bad('externalId filter value must be a string', 'invalidFilter');
      where.push('u.scim_external_id = ?'); params.push(value);
    } else if (attr === 'id') {
      where.push('u.id = ?'); params.push(String(value));
    } else if (attr === 'displayname') {
      where.push('u.name = ?'); params.push(String(value));
    } else if (attr === 'active') {
      where.push(parseActive(value) ? 'u.deactivated_at IS NULL' : 'u.deactivated_at IS NOT NULL');
    } else {
      throw bad(`Filtering on "${m[1]}" is not supported (supported: userName, externalId, id, displayName, active, emails)`, 'invalidFilter');
    }
  }
  return { where, params };
}

// ---------------------------------------------------------------------------
// discovery: ServiceProviderConfig / ResourceTypes / Schemas
// ---------------------------------------------------------------------------

// RFC 7643 §5. Every capability is declared honestly: PATCH yes (it's the path
// Entra deactivates through), filter yes (eq/and subset, maxResults = page cap),
// everything else no. bulk/changePassword/sort/etag each carry the REQUIRED
// "supported" boolean (RFC 7643 §5 marks them all REQUIRED).
router.get('/ServiceProviderConfig', (req, res) => {
  const base = baseUrl(req);
  send(res, 200, {
    schemas: [SPC_SCHEMA],
    documentationUri: 'https://www.rfc-editor.org/rfc/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication using a static bearer token issued by the BeamOS platform admin (POST /api/admin/scim-tokens)',
      specUri: 'https://www.rfc-editor.org/info/rfc6750',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  });
});

// RFC 7643 §6.
function userResourceType(base) {
  return {
    schemas: [RT_SCHEMA],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'BeamOS user account',
    schema: USER_SCHEMA,
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
  };
}

// RFC 7643 §7 / §8.7.1. Only attributes BeamOS actually stores (see header).
function userSchema(base) {
  const attr = (name, type, extra = {}) => ({
    name, type, multiValued: false, required: false, caseExact: false,
    mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
  });
  return {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: 'User',
    description: 'BeamOS user account',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server', description: 'Unique login identifier; must be an email address' }),
      attr('displayName', 'string', { description: 'Name shown in BeamOS' }),
      attr('active', 'boolean', { description: 'false deactivates the account and revokes all existing sessions on their next request' }),
      attr('emails', 'complex', {
        multiValued: true,
        mutability: 'readOnly',
        description: 'Derived from userName (BeamOS stores a single email)',
        subAttributes: [
          attr('value', 'string', { mutability: 'readOnly' }),
          attr('type', 'string', { mutability: 'readOnly', canonicalValues: ['work'] }),
          attr('primary', 'boolean', { mutability: 'readOnly' }),
        ],
      }),
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER_SCHEMA}` },
  };
}

// [MS-SCIM] /Schemas: "Must return a list response." Applied to /ResourceTypes too
// (RFC 7644 §4 allows either; a ListResponse is what SCIM clients parse uniformly).
function listOf(resources) {
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
}

router.get('/ResourceTypes', (req, res) => send(res, 200, listOf([userResourceType(baseUrl(req))])));
router.get('/ResourceTypes/:id', (req, res) => {
  if (req.params.id !== 'User') return scimError(res, 404, `ResourceType "${req.params.id}" not found`);
  send(res, 200, userResourceType(baseUrl(req)));
});
router.get('/Schemas', (req, res) => send(res, 200, listOf([userSchema(baseUrl(req))])));
router.get('/Schemas/:id', (req, res) => {
  if (req.params.id !== USER_SCHEMA) return scimError(res, 404, `Schema "${req.params.id}" not found`);
  send(res, 200, userSchema(baseUrl(req)));
});

// ---------------------------------------------------------------------------
// /Users
// ---------------------------------------------------------------------------

// RFC 7644 §3.4.2 query + §3.4.2.4 pagination (1-based startIndex, count).
// [MS-SCIM] Test Connection: "queries the SCIM endpoint for a user that doesn't
// exist, using a random GUID ... The expected correct response is HTTP 200 OK with
// an empty SCIM ListResponse message" - which the zero-match path below produces.
router.get('/Users', asyncHandler(async (req, res) => {
  const orgId = req.scim.organizationId;
  let startIndex = parseInt(req.query.startIndex, 10);
  if (!Number.isFinite(startIndex) || startIndex < 1) startIndex = 1; // RFC 7644 §3.4.2.4: <1 is interpreted as 1
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count)) count = MAX_RESULTS;
  count = Math.min(Math.max(count, 0), MAX_RESULTS); // negative -> 0; capped at maxResults

  const { where, params } = req.query.filter ? compileFilter(String(req.query.filter)) : { where: [], params: [] };
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM users u JOIN organization_members om ON om.user_id = u.id AND om.organization_id = ? ${whereSql}`;
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n ${from}`).get(orgId, ...params)).n);
  const rows = count === 0 ? [] : await db.prepare(
    `SELECT ${USER_COLS} ${from} ORDER BY om.joined_at ASC, u.id ASC LIMIT ? OFFSET ?`,
  ).all(orgId, ...params, count, startIndex - 1);
  const base = baseUrl(req);
  send(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) => toScimUser(r, base)),
  });
}));

router.get('/Users/:id', asyncHandler(async (req, res) => {
  const row = await findMember(req.scim.organizationId, req.params.id);
  if (!row) return scimError(res, 404, `User ${req.params.id} not found`);
  send(res, 200, toScimUser(row, baseUrl(req)));
}));

const auditScim = (req, action, email) =>
  logActivity(null, action, `${email} (SCIM token "${req.scim.name}")`, null, getClientIp(req), null).catch(() => {});

// POST - RFC 7644 §3.3. Returns 201 + Location. 409 uniqueness if this org already
// has the userName ([MS-SCIM] validator: "Return HTTP 409 on second create request").
//
// ADOPTION: if an account with that email already exists but is NOT yet in this
// org (e.g. the person used "Sign in with Microsoft" before provisioning was turned
// on - the common case when enabling SCIM on a live deployment), it is linked into
// the org rather than rejected. Returning 409 there would make that user
// permanently unprovisionable: Entra's userName filter (org-scoped) can't see them,
// so it would retry the create forever.
router.post('/Users', asyncHandler(async (req, res) => {
  const orgId = req.scim.organizationId;
  const input = readUserBody(req.body);
  const email = input.userName.toLowerCase();
  const io = req.app.get('io');

  const existing = await db.prepare(
    `SELECT ${USER_COLS}, om.id AS membership_id FROM users u
     LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = ?
     WHERE u.email = ?`,
  ).get(orgId, email);

  let userId;
  if (existing && existing.membership_id) {
    return scimError(res, 409, `A user with userName "${input.userName}" already exists`, 'uniqueness');
  } else if (existing) {
    userId = existing.id;
    if (input.active === false) await assertNotLastPlatformAdmin(existing);
    await db.transaction(async (tx) => {
      await tx.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, SCIM_ORG_ROLE);
      await tx.prepare(
        `UPDATE users SET scim_user_name = ?, scim_external_id = ?, name = COALESCE(?, name), updated_at = UNIX_TIMESTAMP() WHERE id = ?`,
      ).run(input.userName, input.externalId ?? null, input.displayName ?? null, userId);
    })();
    if (input.active !== undefined) await setUserDeactivated(db, userId, !input.active, { io, via: 'scim', ip: getClientIp(req) });
    auditScim(req, 'scim:user_linked', email);
  } else {
    userId = crypto.randomUUID();
    const displayName = input.displayName || input.userName.split('@')[0];
    try {
      await db.transaction(async (tx) => {
        // auth_provider 'microsoft': a SCIM-provisioned account signs in via the
        // same Entra tenant's "Sign in with Microsoft" (routes/auth.js matches it by
        // email). No password - there is no local credential to leak.
        await tx.prepare(
          `INSERT INTO users (id, email, name, auth_provider, role, plan_id, scim_user_name, scim_external_id, deactivated_at)
           VALUES (?, ?, ?, 'microsoft', 'user', 'enterprise', ?, ?, ?)`,
        ).run(userId, email, displayName, input.userName, input.externalId ?? null,
          input.active === false ? Math.floor(Date.now() / 1000) : null);
        await tx.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, SCIM_ORG_ROLE);
      })();
    } catch (e) {
      // Two concurrent creates for the same userName: the loser hits users.email UNIQUE.
      if (isDuplicateKeyError(e)) return scimError(res, 409, `A user with userName "${input.userName}" already exists`, 'uniqueness');
      throw e;
    }
    auditScim(req, 'scim:user_created', email);
  }

  const row = await findMember(orgId, userId);
  const resource = toScimUser(row, baseUrl(req));
  res.set('Location', resource.meta.location);
  send(res, 201, resource);
}));

// Shared persistence for PUT / PATCH. `changes` keys: userName, displayName,
// externalId (null clears), active.
async function applyChanges(req, row, changes) {
  const sets = [], params = [];
  if (changes.userName !== undefined) {
    const email = changes.userName.toLowerCase();
    if (email !== row.email) {
      const clash = await db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, row.id);
      if (clash) throw new ScimError(409, `A user with userName "${changes.userName}" already exists`, 'uniqueness');
      sets.push('email = ?'); params.push(email);
    }
    sets.push('scim_user_name = ?'); params.push(changes.userName);
  }
  if (changes.displayName !== undefined) { sets.push('name = ?'); params.push(changes.displayName); }
  if (changes.externalId !== undefined) { sets.push('scim_external_id = ?'); params.push(changes.externalId); }
  if (changes.active === false) await assertNotLastPlatformAdmin(row);

  if (sets.length) {
    try {
      await db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = UNIX_TIMESTAMP() WHERE id = ?`).run(...params, row.id);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ScimError(409, `A user with userName "${changes.userName}" already exists`, 'uniqueness');
      throw e;
    }
  }
  // THE Ref 8 path: Entra's deprovisioning PATCH (active false) lands here and goes
  // through Stage 2's single write path - existing sessions, st_ tokens, Entra SP
  // registrations and open dashboard sockets all die on their next request.
  if (changes.active !== undefined) {
    await setUserDeactivated(db, row.id, !changes.active, { io: req.app.get('io'), via: 'scim', ip: getClientIp(req) });
  }
}

// PATCH - RFC 7644 §3.5.2. 200 with the updated resource ([MS-SCIM]: "It isn't
// necessary to include the entire resource in the PATCH response" - it's allowed).
router.patch('/Users/:id', asyncHandler(async (req, res) => {
  const orgId = req.scim.organizationId;
  const row = await findMember(orgId, req.params.id);
  if (!row) return scimError(res, 404, `User ${req.params.id} not found`);
  const changes = readPatchBody(req.body);
  await applyChanges(req, row, changes);
  auditScim(req, 'scim:user_updated', row.email);
  send(res, 200, toScimUser(await findMember(orgId, row.id), baseUrl(req)));
}));

// PUT - RFC 7644 §3.5.1 full replace of the attributes BeamOS stores: userName is
// required; externalId absent -> cleared (replace semantics). displayName and
// active absent -> left unchanged (a PUT without them can't mean "blank name" /
// "flip activation" - RFC 7644 §3.5.1 lets the provider keep or default them).
router.put('/Users/:id', asyncHandler(async (req, res) => {
  const orgId = req.scim.organizationId;
  const row = await findMember(orgId, req.params.id);
  if (!row) return scimError(res, 404, `User ${req.params.id} not found`);
  const input = readUserBody(req.body);
  await applyChanges(req, row, {
    userName: input.userName,
    externalId: input.externalId === undefined ? null : input.externalId,
    displayName: input.displayName,
    active: input.active,
  });
  auditScim(req, 'scim:user_replaced', row.email);
  send(res, 200, toScimUser(await findMember(orgId, row.id), baseUrl(req)));
}));

// DELETE - RFC 7644 §3.6: "Service providers MAY choose not to permanently delete
// the resource, but MUST return a 404 (Not Found) error code for all operations
// associated with the previously deleted resource."
//
// Decision: SOFT delete = deactivate + remove this org's membership. NOT a hard
// delete via lib/user-deletion.js deleteUserCascade, because that is destructive and
// irreversible in ways an IdP call shouldn't trigger: it hard-deletes any org the
// user solely owns (with every workspace, device, playlist and content item in it)
// and unlinks their authorship from shared resources and the audit trail. Entra
// normally deprovisions with PATCH active:false and only DELETEs on hard-delete /
// scoping changes ([MS-SCIM] user deprovisioning sequence), so the soft path
// satisfies the access requirement with no data loss; a platform admin can still
// hard-delete via DELETE /api/auth/users/:id. Removing the membership is what makes
// the user 404 to THIS token afterwards (every lookup is org-scoped), and a later
// POST for the same userName re-adopts them (see POST).
router.delete('/Users/:id', asyncHandler(async (req, res) => {
  const orgId = req.scim.organizationId;
  const row = await findMember(orgId, req.params.id);
  if (!row) return scimError(res, 404, `User ${req.params.id} not found`);
  await assertNotLastPlatformAdmin(row);
  await setUserDeactivated(db, row.id, true, { io: req.app.get('io'), via: 'scim', ip: getClientIp(req) });
  await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?').run(orgId, row.id);
  auditScim(req, 'scim:user_deleted', row.email);
  res.status(204).end();
}));

// Anything else under /scim/v2 (incl. /Groups, /Bulk, /Me): SCIM-shaped 404/501
// instead of the SPA fallback. RFC 7644 §3.14: unsupported endpoint -> 501.
router.all(['/Groups', '/Groups/*', '/Bulk', '/Me'], (req, res) => scimError(res, 501, `${req.path} is not supported by this service provider`));
router.use((req, res) => scimError(res, 404, `Unknown SCIM endpoint ${req.method} ${req.path}`));

// Error handler: every failure is RFC 7644 §3.12-shaped, never HTML / the app's
// generic JSON. Malformed JSON bodies (body-parser) -> 400 invalidSyntax.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  if (err instanceof ScimError) return scimError(res, err.status, err.message, err.scimType);
  if (err && err.type === 'entity.parse.failed') return scimError(res, 400, 'Request body is not valid JSON', 'invalidSyntax');
  if (err && err.type === 'entity.too.large') return scimError(res, 413, 'Request body too large');
  console.error(`[scim] ${req.method} ${req.originalUrl}:`, err);
  return scimError(res, 500, 'Internal server error');
});

module.exports = router;
module.exports._internal = { compileFilter, readPatchBody, parseActive, splitAnd, assertNotLastPlatformAdmin }; // unit tests
