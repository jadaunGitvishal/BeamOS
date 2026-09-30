# Encryption of Data at Rest and in Transit (Ref 2)

This document is BeamOS's evidence for Ref 2. It covers:

- what data BeamOS stores;
- what the **application** encrypts at rest, and how;
- what TLS guarantees in transit;
- how encryption keys are managed.

It follows the style of [docs/entra-auth.md](entra-auth.md) and
[docs/bi-integration.md](bi-integration.md). Every claim cites real code and
real tests, and the gaps are stated plainly.

**Scope.** This document covers the **application layer**: what BeamOS's own
code does. Encrypting the whole database, the disks, backups and the network
underneath is an **infrastructure** decision for each deployment. That
includes MySQL/InnoDB encryption, managed-database encryption, volume
encryption and private networking. Those controls belong with the RFP's
hosting ("Server (Azure)") items. This document says where it depends on
them, but does not try to answer them.

**Summary**

| Requirement | State |
|---|---|
| AES-256 at rest | ✅ **For secrets the app must read back** (TOTP seeds, customer AI keys): AES-256-GCM. ✅ **Verify-only secrets** are one-way hashed instead: passwords (bcrypt); API, SCIM and device tokens and recovery codes (SHA-256). ⚠️ **All other data** (content, telemetry, tickets, proof-of-play, user profiles) is **not** encrypted by the application. It relies on database/disk encryption, which is an infrastructure control. |
| TLS 1.2+ in transit | ✅ **Whenever BeamOS terminates TLS itself**, TLS 1.0/1.1 are refused and HSTS is sent. ⚠️ **Plain HTTP remains possible by design** for self-hosted LANs. ❌ **The app-to-MySQL connection has no TLS option today.** |
| Keys in a certified KMS/HSM | ⚠️ **BeamOS has no built-in KMS/HSM integration.** It accepts an **externally supplied** key (`DATA_ENCRYPTION_KEY`), which a deployment can load from Key Vault, Secrets Manager or similar at start-up. The key is then held in process memory. That is not HSM-resident or envelope encryption. |

---

## 1. What data BeamOS stores

Everything below is stored either in the MySQL database or under the data
directory (`DATA_DIR`, [`server/config.js`](../server/config.js)). **BeamOS
never handles card data.** Payments go through Stripe-hosted Checkout and the
billing portal ([`server/routes/stripe.js`](../server/routes/stripe.js)).
BeamOS stores only Stripe's customer and subscription IDs.

| Category | Where | What exactly | Sensitivity | Application-layer protection at rest |
|---|---|---|---|---|
| **User accounts** | `users`, `organization_members`, `workspace_members`, `*_invites` | Email, name, phone (Ref 43), avatar URL, role, plan, Stripe customer/subscription IDs, login provider, SCIM IDs, last login | Personal data | Password: **bcrypt**. TOTP seed: **AES-256-GCM**. Everything else is plaintext. |
| **Authentication secrets** | `users.password_hash`, `users.totp_secret_enc`, `totp_recovery_codes`, `api_tokens`, `scim_tokens`, `devices.device_token` | See §2 | Credentials | All hashed or encrypted (§2) |
| **Content** | `content`, `playlists*`, `layouts`, `layout_zones`, `widgets`, `kiosk_pages`, `schedules`, `campaigns`, `content_folders` + **files** in `uploads/content/` | Uploaded images and videos, their metadata, playlists, schedules, widget and kiosk definitions | Customer business data | Plaintext (DB and disk) |
| **Devices** | `devices`, `device_groups*`, `video_walls*`, `device_fingerprints` | Name, IP address, hardware identity (model, serial, MAC, SIM ICCID and provider), install and warranty dates, assignment | Asset data; the IP address is personal-adjacent | Plaintext, except `device_token`, which is SHA-256 hashed |
| **Device telemetry** | `device_telemetry`, `device_status_log`, `device_events`, `device_usage_daily`, `device_network_usage`, `event_loop_lag`, `player_debug_logs` | Battery, storage, RAM, CPU, Wi-Fi SSID and RSSI, uptime, **GPS lat/long** (Ref 32), status history, data usage | Operational; **location data** | Plaintext |
| **Screenshots** | `screenshots` + **files** in `uploads/screenshots/` | What a screen was displaying | Can show customer content | Plaintext |
| **Proof-of-play** | `play_logs` | Which content played where and when, for how long | Business/contract data | Plaintext |
| **Field visits** (Ref 43) | `field_visits`, `field_visit_photos` + **files** in `uploads/field-visit-photos/` | Technician, remarks, device metrics, **geotagged photos** (lat/long, accuracy, place name) | Personal data + **location** | Plaintext |
| **Tickets and SLA** | `tickets`, `ticket_escalations`, `outage_history`, `outage_escalations`, `warranty_alerts`, `alert_configs` | Titles, descriptions, status, outage timeline | Operational | Plaintext |
| **SIM inventory** (Ref 65) | `sim_inventory` | ICCID, serial, carrier, notes | Asset data | Plaintext |
| **Audit log** (Ref 17) | `activity_log`, `activity_log_chain` | Who did what, from which IP | Security record | Plaintext, **tamper-evident** SHA-256 hash chain (integrity, not confidentiality) |
| **Branding and AI settings** | `white_labels`, `ai_settings` | Brand name, colours, logo, custom CSS, domain; AI endpoint + **customer API keys** | API keys are credentials | API keys: **AES-256-GCM**; the rest is plaintext |
| **Organisation / tenancy** | `organizations`, `workspaces`, `regions`, `teams*`, `plans`, `app_settings` | Structure, plan, token-lifetime policy (Ref 34), a few operational settings | Low | Plaintext |
| **Database backups** | `server/db/backups/*.sql` (gitignored) | `mysqldump` snapshots taken before schema migrations and by the migration scripts | **Everything above**, including hashes and the encrypted fields | Plaintext SQL. Encrypted fields stay encrypted inside. Treat these files as a full copy of the database. |
| **Instance secrets on disk** | `<CERTS_DIR>/.jwt_secret` (only if `JWT_SECRET` is unset); the TLS key file (`SSL_KEY`) | The JWT signing secret, which also derives the fallback encryption key (§3), and the TLS private key | **Keys** | Filesystem permissions only |
| **On the screen itself** | Android app-private storage (`filesDir/content_cache`); players' local settings | Cached content files; the device's raw `device_token` | Customer content; device credential | App sandbox; encrypted only if the OS encrypts storage (Android 10+ file-based encryption is mandatory; older supported devices such as Android 5.1 may not encrypt at all) |

Data that leaves BeamOS:

- **Email** is sent through Microsoft Graph.
- The optional **data-platform export** (Ref 28) writes NDJSON to the
  customer's S3 bucket, covered by that bucket's own encryption
  ([docs/data-platform-integration.md](data-platform-integration.md)).
- **AI prompts** go to whichever provider the workspace configured.

---

## 2. What the application encrypts or hashes at rest

The complete audit, with every column checked and why each got its verdict, is
in [docs/encryption-coverage-audit.md](encryption-coverage-audit.md).

### 2a. Reversible encryption: `lib/secretbox.js`

This is used only where the server must read the plaintext back.

| Field | Why it must be reversible |
|---|---|
| `users.totp_secret_enc` | The server recomputes TOTP codes from the seed (#100) |
| `ai_settings.api_key_enc` | Sent to the customer's AI provider on each call (#41) |
| `ai_settings.image_api_key_enc` | Same, for the image provider |

How it works ([`server/lib/secretbox.js`](../server/lib/secretbox.js)):

- **Cipher:** AES-256-GCM, Node's built-in `crypto`, which is OpenSSL.
- **IV:** a fresh random 96-bit IV for every encryption.
- **Tag:** a 128-bit authentication tag.
- **Stored format:** `base64(iv ‖ tag ‖ ciphertext)`.
- **Tampering or wrong key:** GCM authentication fails and `decrypt()`
  returns `null`. It never yields garbage plaintext.
- **Key:** see §4.

### 2b. One-way hashing (verify-only secrets)

A secret the server only needs to **check** is never stored in a reversible
form. Leaking the database then yields nothing usable, and there is no key to
steal alongside it.

| Field | Hash |
|---|---|
| `users.password_hash` | bcrypt, cost 10 ([`routes/auth.js`](../server/routes/auth.js)): a slow, salted hash suited to low-entropy passwords |
| `totp_recovery_codes.code_hash` | SHA-256 ([`lib/totp.js`](../server/lib/totp.js)) |
| `api_tokens.token_hash` | SHA-256 ([`middleware/apiToken.js`](../server/middleware/apiToken.js)) |
| `scim_tokens.token_hash` | SHA-256 ([`middleware/scimAuth.js`](../server/middleware/scimAuth.js)) |
| `devices.device_token` | `sha256:` + SHA-256 ([`lib/device-token.js`](../server/lib/device-token.js)). **New in Ref 2 Stage 3.** It was plaintext before. See the migration step below. |

Plain SHA-256 is correct for the tokens because each one is at least 256
random bits, so guessing the preimage isn't feasible. Slow hashing is for
passwords.

**Operator action for existing screens.** Deploying Stage 3 hashes only
tokens issued *after* the deploy. Existing rows stay in plaintext until you
run the one-time backfill:

```bash
node server/scripts/hash-device-tokens.js --dry-run
node server/scripts/hash-device-tokens.js --yes
```

Read the script header first. Three things matter:

- The backfill is irreversible.
- Downgrading past Stage 3 afterwards locks those devices out.
- The pre-migration snapshot it takes contains the plaintext tokens. Delete
  it once the rollout is confirmed.

Screens need no update. They keep the token they already have.

### 2c. What the application does **not** encrypt

Everything else in the §1 table is stored in plaintext **as far as BeamOS's
code is concerned**. That includes:

- content files and metadata
- telemetry and GPS
- screenshots
- proof-of-play
- tickets
- field-visit photos and locations
- user names, emails and phones
- the audit log
- backups

Encrypting these at rest is the job of the layers underneath. Each deployment
has to enable them:

- **The database.** Use MySQL/InnoDB tablespace encryption with a keyring
  component, or a managed service's built-in encryption at rest (Azure
  Database for MySQL, Amazon RDS).
- **The disks.** Encrypt the volume holding `DATA_DIR` (uploads, the
  `certs/` folder, `db/backups/`): Azure Disk Encryption / SSE, EBS
  encryption, LUKS or BitLocker.
- **The backups.** Wherever `db/backups/*.sql` or other database backups
  are copied, use encrypted storage.

BeamOS neither enables nor checks any of these. It can't tell from inside the
process whether the disk is encrypted. That is why they appear in the
hosting/infrastructure evidence and not here.

---

## 3. Encryption in transit

### 3a. What BeamOS guarantees (Ref 2 Stage 1)

This applies when certificates exist at `SSL_CERT` / `SSL_KEY`. By default
those are `<DATA_DIR>/certs/cert.pem` and `key.pem`
([`server/config.js`](../server/config.js)). BeamOS then serves HTTPS and
secure WebSockets on `HTTPS_PORT` (default 3443). It also redirects
`http://…:PORT` to `https://` with a 301 ([`server/server.js`](../server/server.js)).

- **TLS 1.2 is the floor, pinned explicitly.** The HTTPS server's options come
  from [`lib/tls-policy.js`](../server/lib/tls-policy.js) `buildSslOptions()`,
  which sets `minVersion: 'TLSv1.2'`.
  - Node 20's default is already TLS 1.2. That default is process-wide,
    though, and can be lowered (`node --tls-min-v1.0`, `NODE_OPTIONS`), and
    it has changed between Node versions. The explicit setting can't be
    lowered that way.
  - TLS 1.3 is negotiated when the client supports it. Cipher suites are
    Node/OpenSSL's defaults.
- **HSTS** (`max-age=31536000; includeSubDomains`) is sent on every request
  that arrived over TLS (`req.secure`). That covers the HTTPS server itself,
  and a **trusted** TLS-terminating proxy that sends `X-Forwarded-Proto:
  https`: Cloudflare, or a LAN reverse proxy on the `trust proxy` list in
  [`config/cloudflareIps`](../server/config/cloudflareIps.js).
  - It is **not** sent over plain HTTP, where it can't be backed up and
    browsers ignore it anyway (RFC 6797 §8.1).
  - It is not sent when an **untrusted** client sets `X-Forwarded-Proto`.
- The **same port and TLS settings** carry the dashboard, the REST API, the
  public API (`st_` tokens), SCIM, and the players' socket.io connections
  (`wss://`).

**Evidence.** [`server/test/tls-policy.test.js`](../server/test/tls-policy.test.js)
has 8 tests, using real TLS handshakes with the exact options production uses:

- TLS 1.0 and 1.1 are **refused** even with the process default lowered to
  TLSv1. A control server proves the test client really can negotiate 1.0 and
  1.1, so the refusal comes from the server's pin, not the client.
- TLS 1.2 and 1.3 are accepted.
- HSTS is present over HTTPS and behind a trusted proxy, and absent over
  plain HTTP and for an untrusted `X-Forwarded-Proto`.
- Removing the pin makes the refusal tests fail.

It was also checked against the real `server.js` started with a certificate.
`openssl s_client -tls1` and `-tls1_1` got a server alert 70
(`protocol_version`). `-tls1_2` and `-tls1_3` connected. The HSTS header and
the HTTP→HTTPS 301 were present. Started without certificates, the server
serves plain HTTP with no HSTS.

### 3b. Plain HTTP is still possible, on purpose

With no certificate files, BeamOS serves **plain HTTP** on `PORT`. This is
intended for self-hosted deployments on a closed LAN. It is not a production
configuration.

> **A production or internet-facing deployment MUST use TLS.** Over plain
> HTTP, credentials cross the network in cleartext, and so does everything
> else: passwords, session JWTs, `st_` and `scim_` tokens, screens'
> `device_token`s, and all content and telemetry.

There are two supported ways to use TLS:

1. **BeamOS terminates TLS.** Put a certificate and key at `SSL_CERT` /
   `SSL_KEY`, or in `<DATA_DIR>/certs/cert.pem` and `key.pem`. BeamOS then
   serves HTTPS on `HTTPS_PORT` with the guarantees in §3a, and redirects
   HTTP.
2. **A reverse proxy or CDN terminates TLS.** This is the pattern in
   [`docker-compose.example.yml`](../docker-compose.example.yml), and how
   public production runs behind Cloudflare. **BeamOS's TLS 1.2 floor does
   not apply to that hop. The proxy's TLS settings do.** Configure it for
   TLS 1.2 minimum: Cloudflare "Minimum TLS Version", nginx
   `ssl_protocols TLSv1.2 TLSv1.3;`, or Azure Application Gateway / Front
   Door TLS policy. Keep the proxy-to-BeamOS hop on a private network, or
   encrypt it too.

Screens must be pointed at an `https://` server URL for their traffic to be
encrypted. The player uses whatever URL it was provisioned with.

### 3c. Outbound connections

| Hop | Transport | Notes |
|---|---|---|
| BeamOS ↔ **MySQL** | ❌ **No TLS option** | [`db/database.js`](../server/db/database.js)'s pool config has no `ssl` setting, and there is no env var to turn it on. That is fine for a DB on the same host or a Unix socket (`MYSQL_SOCKET_PATH`). **It is a gap for a DB on another host**: the traffic is cleartext. A managed MySQL that requires secure transport, such as Azure Database for MySQL Flexible Server's default `require_secure_transport=ON`, would likely refuse the connection. Until that's added, use a private network or a local socket. |
| BeamOS → Microsoft Graph (email), Entra JWKS (SSO / Service Principal / SCIM login checks), Stripe | HTTPS | Fixed `https://` endpoints inside the SDKs (`@azure/msal-node`, `jose`'s remote JWKS, `stripe`) |
| BeamOS → S3 (data-platform export, Ref 28) | HTTPS by default | AWS SDK v3. A custom `DATA_PLATFORM_S3_ENDPOINT` (MinIO, R2) uses whatever scheme it's given. Give it `https://`. |
| BeamOS → customer's AI provider | ⚠️ HTTP or HTTPS | `endpointAllowed()` ([`routes/ai.js`](../server/routes/ai.js)) accepts both `http:` and `https:`, because self-hosted setups point at a local model server ([docs/local-ai-setup.md](local-ai-setup.md)). An `http://` endpoint sends the workspace's AI API key and prompts **in cleartext**. Use `https://` for anything off the host. |

---

## 4. Key management

### 4a. The honest state

- **BeamOS does not integrate with any KMS or HSM.** It does not call Azure
  Key Vault, AWS KMS, Google Cloud KMS or an HSM (PKCS#11) API, and has no
  envelope-encryption scheme.
- There is **one** data-encryption key, used by `lib/secretbox.js` for the
  three fields in §2a. It is resolved **once at start-up** and held in
  process memory.

It comes from one of two sources ([`lib/secretbox.js`](../server/lib/secretbox.js)).
The boot log says which one is active (the label only, never the key):
`Data encryption key source: …`.

| Source | When | Key |
|---|---|---|
| `DATA_ENCRYPTION_KEY` (Ref 2 Stage 2) | The env var is set | Used **directly** as the AES-256 key: 64 hex characters, or base64/base64url that decodes to exactly 32 bytes. A set but **invalid** value **stops the server from starting**, rather than quietly falling back. |
| Derived from `JWT_SECRET` (original behaviour) | The env var is unset or empty | `SHA-256(JWT_SECRET + ':secretbox-v1')`, unchanged. If `JWT_SECRET` is also unset, it is generated once and kept in `<CERTS_DIR>/.jwt_secret` on disk. That is the "key in a file on disk" case, and the weakest option. |

### 4b. Connecting a KMS, secret store or HSM

Because the key is **supplied from outside**, a deployment can keep it in a
managed vault and inject it at start-up. BeamOS never sees the vault. It only
sees the resulting environment variable. Examples:

- **Azure App Service or Functions:** set the app setting
  `DATA_ENCRYPTION_KEY=@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)`,
  with a managed identity that can read the secret.
- **Azure Container Apps:** a secret that references Key Vault, mapped to the
  `DATA_ENCRYPTION_KEY` env var.
- **Kubernetes:** the Secrets Store CSI driver (Azure Key Vault, AWS or GCP
  provider) syncing to a Secret that is exposed as the env var.
- **AWS ECS:** the task definition's `secrets` pulling from Secrets Manager or
  SSM Parameter Store.
- **Anything else:** an entrypoint that fetches the key and then runs `node
  server.js`. For example,
  `export DATA_ENCRYPTION_KEY="$(az keyvault secret show --vault-name … --name … --query value -o tsv)"`.

Generate the key once, inside the vault's tooling or with
`openssl rand -base64 32`.

**What this does and doesn't meet.** It meets "the key is created and stored
in a managed, access-controlled, audited key store, not in a file next to the
app". It does **not** meet "the key never leaves the HSM":

- The AES key is delivered to the BeamOS process and used there, in memory.
- Key Vault Premium or Managed HSM protect it while it's stored, not while
  BeamOS uses it.

If the RFP means HSM-resident keys or envelope encryption, where only a
wrapped data key leaves the HSM and each use goes through KMS, that is **not
built** and would be new work. It would mean adding key IDs to the ciphertext
format and a KMS client per cloud.

### 4c. Rotation

There is a single active key, and no key ID is stored in the ciphertext. So
**any key change makes previously encrypted values unreadable**:

- rotating `DATA_ENCRYPTION_KEY`
- rotating `JWT_SECRET` while `DATA_ENCRYPTION_KEY` is unset
- switching an existing deployment from the JWT-derived key to
  `DATA_ENCRYPTION_KEY`

This is the same caveat secretbox has always had for `JWT_SECRET`, carried
forward. Values fail cleanly (`null`), never as garbage:

- **AI keys:** a workspace admin re-enters them.
- **TOTP:** enrolled users sign in with a recovery code and re-enrol. Recovery
  codes are hashed, so they don't depend on the key. This is proven by
  [`test/totp-keyrotation.test.js`](../server/test/totp-keyrotation.test.js).

**There is no re-encryption tool or dual-key read yet.** Plan a key change as
a maintenance event, and tell TOTP users in advance. Setting
`DATA_ENCRYPTION_KEY` separately from `JWT_SECRET` has a practical benefit:
rotating `JWT_SECRET`, which signs out every session, **no longer** destroys
the stored secrets. That is proven by
[`test/secretbox.test.js`](../server/test/secretbox.test.js).

`JWT_SECRET` (session signing), the TLS private key, and the other
integration secrets in `config.js` are **separate** keys. They too come only
from the environment or files and are never stored in the database
([audit](encryption-coverage-audit.md#verdicts-configuration-secrets-not-in-the-database)).
The same vault-injection pattern applies to them.

**Evidence for Stage 2.** [`server/test/secretbox.test.js`](../server/test/secretbox.test.js)
has 9 tests, each run in a fresh process with its own environment:

- With the var **unset**, ciphertexts captured from the **unmodified**
  pre-Stage-2 code still decrypt exactly.
- With it **set**, values round-trip. The key is used directly: an
  independent AES-GCM decrypt with that exact key succeeds. Hex, base64 and
  base64url forms are interchangeable. Rotating `JWT_SECRET` has no effect.
- Any key change yields `null`.
- An invalid key refuses to load, and the error never echoes it.

Separately, all **77 real encrypted rows** in the dev database were
fingerprinted before and after the change (SHA-256 of each decrypted value,
so no plaintext was printed). The results were identical.

---

## 5. Known gaps

1. **No application-layer encryption of general data** (§2c). This depends on
   the deployment's database and disk encryption.
2. **No KMS/HSM API integration, and no envelope encryption.** The key is
   supplied from outside and held in memory (§4b).
3. **No key rotation tooling.** A key change needs a maintenance event
   (§4c).
4. **The app-to-MySQL connection has no TLS option.** Keep the DB local or on
   a private network (§3c). **Recommended next change:** a small
   `MYSQL_SSL` / CA option on the pool.
5. **Plain HTTP is allowed** for LAN self-hosting (§3b). Internet-facing
   deployments must enable TLS.
6. **The TLS floor on the proxy hop is the proxy's responsibility** when a
   proxy or CDN terminates TLS (§3b).
7. **AI endpoints accept `http://`** (§3c).
8. **Existing screens' tokens stay in plaintext until the backfill script is
   run** (§2b).
9. **Instance secrets on disk.** The `.jwt_secret` fallback and the TLS key
   file are protected only by filesystem permissions (§1).
10. **Screens' local storage** is encrypted only where the OS does it (§1).

---

## 6. RFP evidence map

| RFP evidence asked for | Where it is answered |
|---|---|
| **What data is stored** | [§1](#1-what-data-beamos-stores): inventory by category, location and sensitivity, plus what leaves BeamOS |
| **Encryption configuration** | [§2](#2-what-the-application-encrypts-or-hashes-at-rest): algorithms, fields and formats. [§3a](#3a-what-beamos-guarantees-ref-2-stage-1): TLS floor and HSTS. [§4a](#4a-the-honest-state): key sources. [Audit](encryption-coverage-audit.md): column-by-column verdicts |
| **Encryption policy** | [§2b](#2b-one-way-hashing-verify-only-secrets): hash what is verified, encrypt only what must be read back. [§3b](#3b-plain-http-is-still-possible-on-purpose): production MUST use TLS. [§4b](#4b-connecting-a-kms-secret-store-or-hsm)–[§4c](#4c-rotation): key custody and rotation |
| **Data flow** | [§3](#3-encryption-in-transit): every hop, including browser, API client, SCIM and screen ↔ BeamOS, BeamOS ↔ MySQL, Graph, Entra, Stripe, S3 and AI provider, each with its transport |
| **AES-256+ at rest** | [§2a](#2a-reversible-encryption-libsecretboxjs) (AES-256-GCM, for application secrets). Everything else relies on infrastructure ([§2c](#2c-what-the-application-does-not-encrypt)) |
| **TLS 1.2+ in transit** | [§3a](#3a-what-beamos-guarantees-ref-2-stage-1) (guaranteed when BeamOS terminates TLS), [§3b](#3b-plain-http-is-still-possible-on-purpose) (proxy hop), [§3c](#3c-outbound-connections) (MySQL gap) |
| **Keys in a certified KMS/HSM** | [§4b](#4b-connecting-a-kms-secret-store-or-hsm): supported by supplying the key from the vault. **Not** HSM-resident; see the limits stated there |
| **Server / hosting (Azure) controls** | Out of scope here. Database encryption, disk encryption, networking and backup storage belong to the hosting and infrastructure evidence |
