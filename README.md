# BeamOS

BeamOS is self-hosted digital signage software. Manage screens across multiple locations from one dashboard — built for retail, offices, lobbies, and any environment where you need centralized control over what's displayed on remote screens.

## Features

- **Playlists** — first-class playlist objects: create, reorder, set per-item duration, share one playlist across multiple displays; draft/publish workflow with revert-to-published
- **Device groups** — organize displays into groups, assign a playlist to an entire group, send bulk commands (reboot, screen on/off, launch, update, shutdown), schedule content group-wide
- **Multi-zone layouts** — split screens into zones with drag-and-drop editor; 7 built-in templates (fullscreen, split, L-bar, PiP, grid)
- **Video walls** — combine multiple displays into one screen with bezel compensation, device rotation, and leader-based sync
- **Remote control** — live view, touch injection, key input, power on/off
- **Scheduling** — visual weekly calendar with recurrence rules, priority-based conflict resolution, device- and group-level schedules, timezone support
- **Widgets** — clocks, weather, RSS tickers, text/HTML, webpages, social feeds, and Directory Board
- **Kiosk mode** — interactive touchscreen interfaces
- **Proof-of-play** — per-content and per-device analytics, hourly/daily breakdowns, CSV export
- **Device telemetry** — battery, storage, RAM, CPU, WiFi signal strength, and uptime
- **Offline resilience** — web and Android players keep displaying cached content during outages
- **Mobile-responsive** — full dashboard works on phones and tablets
- **Workspaces** — multi-tenant data model: organizations contain workspaces, workspaces contain devices/content/playlists/schedules
- **Member roles** — six-level hierarchy (platform_admin / org_owner / org_admin / workspace_admin / workspace_editor / workspace_viewer)
- **Alerts** — email notifications via Microsoft Graph when devices go offline
- **White-label** — custom branding, colors, logo, favicon, CSS, and domain
- **Content management** — folder organization, remote URL content, YouTube embeds, automatic thumbnail generation
- **Export/Import** — v2 format with playlists, device groups, schedules, and optional media bundling
- **Device authentication** — per-device tokens for secure WebSocket connections
- **Security** — JWT auth, bcrypt hashing, parameterized SQL, rate-limited endpoints, ongoing auth/IDOR/XSS audits
- **Auto-update** — OTA updates pushed to devices automatically
- **Activity log** — full audit trail of user and system actions

## Architecture

### Multi-tenancy model

Three nested primitives:

```
organizations (billing + branding container)
   workspaces  (resource scope: devices, content, playlists, schedules, walls, layouts, widgets, groups)
      members (users with a role on that workspace)
```

Every resource carries a `workspace_id`. Every API route filters by it. Cross-workspace access requires switching workspaces via the sidebar dropdown.

### Role hierarchy

| Role               | Scope                         | Cap                                                |
| ------------------ | ----------------------------- | -------------------------------------------------- |
| `platform_admin`   | every workspace in the system | full read/write                                    |
| `org_owner`        | one organization              | billing + delete + admin within all workspaces     |
| `org_admin`        | one organization              | admin within all workspaces (no billing)           |
| `workspace_admin`  | one workspace                 | manage members, rename, full read/write            |
| `workspace_editor` | one workspace                 | create/edit content, devices, playlists, schedules |
| `workspace_viewer` | one workspace                 | read-only                                          |

### Database

BeamOS runs on **MySQL 8.0+**. Schema is applied automatically on server boot from `server/db/schema.sql` — no manual migration commands needed on first install.

### Data flow

- Android / web players → device-namespace WebSocket → server, authenticated per-device with a long-lived device token
- Admin dashboard → dashboard-namespace WebSocket → server, authenticated with the user's JWT
- Admin REST → `/api/*` HTTPS → Express → MySQL, scoped by `workspace_id` from the JWT
- Email → Microsoft Graph `sendMail` via client-credentials OAuth flow

## Supported Platforms

Android TV, Fire TV, Raspberry Pi, Windows, ChromeOS, LG webOS, Samsung Tizen, and any device with a web browser.

## Self-Hosting

### Requirements

- Node.js 20.6+
- Linux, macOS, or Windows
- **MySQL 8.0+**, running and reachable — installed separately (not bundled)

### Quick Start

**Step 1 — Create the database and user in MySQL:**

```sql
CREATE DATABASE beamos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'beamos_user'@'localhost' IDENTIFIED BY 'ChooseAStrongPassword';
GRANT ALL PRIVILEGES ON beamos.* TO 'beamos_user'@'localhost';
FLUSH PRIVILEGES;
```

**Step 2 — Clone and install:**

git clone https://github.com/jadaunGitvishal/BeamOS.git
cd BeamOS/server
npm install

````

**Step 3 — Start the server:**
MYSQL_PASSWORD=ChooseAStrongPassword SELF_HOSTED=true npm start



The server starts on port 5001 (HTTP). If SSL certificates are present in `server/certs/`, it starts on port 3443 (HTTPS) with automatic redirect. The first registered user gets full access with all features unlocked.

Schema is applied automatically on first boot — no manual migration commands.

The server starts on port 5001 (HTTP). If SSL certificates are present in `server/certs/`, it starts on port 3443 (HTTPS) with automatic redirect. The first registered user gets full access with all features unlocked.

Schema is applied automatically on first boot — no manual migration commands.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | 5001 |
| `HTTPS_PORT` | HTTPS port (used when SSL certs are present) | 3443 |
| `NODE_ENV` | Runtime env | (none) |
| `SELF_HOSTED` | First user gets all features unlocked | false |
| `HIDE_BILLING` | Hide the Subscription nav item + billing view | false |
| `DISABLE_REGISTRATION` | Block new account creation | false |
| `DISABLE_HOMEPAGE` | Redirect `/` straight to the app | false |
| `APP_URL` | Your public URL | (none) |
| `JWT_SECRET` | JWT signing key | (auto-generated) |
| `MYSQL_HOST` | MySQL server host | localhost |
| `MYSQL_PORT` | MySQL server port | 3306 |
| `MYSQL_USER` | MySQL username | beamos_user |
| `MYSQL_PASSWORD` | MySQL password | (none — must be set) |
| `MYSQL_DATABASE` | MySQL database name | beamos |
| `MYSQL_SOCKET_PATH` | Unix socket path (alternative to host/port) | (none) |
| `MYSQL_POOL_SIZE` | Connection pool size | 10 |
| `SSL_CERT` | Path to SSL certificate | server/certs/cert.pem |
| `SSL_KEY` | Path to SSL private key | server/certs/key.pem |

## Optional Integrations

All integrations are optional. The app works fully without any of them.

### Stripe (Billing)

| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
| `APP_URL` | Your public URL |

Default plans (Free, Starter, Pro, Enterprise) can be edited directly in the `plans` table.

### Google OAuth

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Your Google OAuth client ID |

### Microsoft OAuth

| Variable | Description |
|---|---|
| `MICROSOFT_CLIENT_ID` | Your Azure AD application client ID |
| `MICROSOFT_TENANT_ID` | Tenant ID |

### Email Alerts (Microsoft Graph)

| Variable | Description |
|---|---|
| `GRAPH_TENANT_ID` | Microsoft Azure AD tenant ID |
| `GRAPH_CLIENT_ID` | Azure AD app registration client ID |
| `GRAPH_CLIENT_SECRET` | Azure AD app registration client secret |
| `GRAPH_SENDER_EMAIL` | Mailbox to send from |
| `GRAPH_SENDER_NAME` | Display name shown in the email From field (defaults to BeamOS) |

If any Graph variable is unset, `sendEmail()` logs `[EMAIL] not configured` to stdout instead of sending. The app runs normally either way.

## Production Deployment

```bash
# Create a dedicated user
sudo useradd -r -s /bin/false beamos

# Copy the app
sudo cp -r . /opt/beamos
sudo chown -R beamos:beamos /opt/beamos

# Install dependencies
cd /opt/beamos/server && npm install --production

# Create a systemd service
sudo cat > /etc/systemd/system/beamos.service << 'EOF'
[Unit]
Description=BeamOS
After=network.target mysql.service

[Service]
Type=simple
User=beamos
WorkingDirectory=/opt/beamos/server
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=5001
Environment=NODE_ENV=production
Environment=SELF_HOSTED=true
Environment=MYSQL_HOST=localhost
Environment=MYSQL_USER=beamos_user
Environment=MYSQL_PASSWORD=ChangeThisPassword
Environment=MYSQL_DATABASE=beamos
# Environment=DISABLE_REGISTRATION=true
# Environment=APP_URL=https://signage.yourcompany.com

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now beamos
```

### Nginx Example

```nginx
server {
    listen 80;
    server_name signage.yourcompany.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name signage.yourcompany.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

## Backups

**Database:** BeamOS runs on MySQL. For a one-off snapshot:

The SQLite database is at `server/db/remote_display.db` and uploaded content is in
`server/uploads/`. For a one-off DB copy (safe while the server runs):

```bash
sqlite3 server/db/remote_display.db ".backup /path/to/backup.db"
```

**Recommended: nightly automated backups** via `scripts/backup.sh`. It takes an
atomic DB snapshot plus a hard-linked, point-in-time copy of your content (durable
images/videos; ephemeral per-device screenshots are excluded), with daily + monthly
retention and an error log. Add a cron entry:

```bash
# as root (or your service user) — adjust the path to your install
0 3 * * * /opt/screentinker/scripts/backup.sh
```

Override defaults with env vars if your layout differs:
`SCREENTINKER_DIR` (default `/opt/screentinker`), `BACKUP_DIR`, `DB`, `UPLOADS`,
`DAILY_KEEP` (7), `MONTHLY_KEEP` (12), `DB_KEEP_DAYS` (30). Backups land in
`$BACKUP_DIR` (`remote_display-<ts>.db`, `content-latest/`, `content-<ts>/`,
`content-monthly-<YYYYMM>/`) and each run appends to `$BACKUP_DIR/backup.log`.

### Admin Recovery

Locked out? Run this on the server to get a temporary admin token (1 hour):

```bash
node scripts/reset-admin.js
```

### Building the Android APK

The Android player app is in the `android/` directory. To build it:

```bash
cd android

# Set your keystore credentials (or generate a new keystore)
export KEYSTORE_PASSWORD=your_password
export KEY_ALIAS=your_alias
export KEY_PASSWORD=your_password

# Build the APK
./gradlew assembleDebug
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to `server/` as `ScreenTinker.apk` to serve it from `/download/apk`:

```bash
cp android/app/build/outputs/apk/debug/app-debug.apk ScreenTinker.apk
```

> **Release builds & MDM signage (#81):** `./gradlew assembleRelease` is automatically
> re-signed to carry a **v1 (JAR) signature alongside v2/v3** (the `resignReleaseV1` task in
> `app/build.gradle.kts`). At `minSdk 26` the Gradle plugin omits v1, and some MDM-managed
> commercial displays (e.g. MAXHUB/Pivot) **strip a v2-only APK on reboot** — screens that
> power-cycle nightly then lose the app. v1+v2+v3 installs everywhere from API 19 to the
> latest Android. (`enableV1Signing = true` alone does not work at minSdk ≥ 24.)

To generate a new signing keystore:

```bash
keytool -genkey -v -keystore android/release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias your_alias
```

**Requirements:** Java 17+, Android SDK (API 34).

### Device Setup

1. Register at your ScreenTinker instance
2. Go to **Displays** and click **Add Display**
3. Install the ScreenTinker app on your device:
   - **Android TV / tablets**: Download the APK from your instance (`/download/apk`) or build it from source (see above)
   - **Raspberry Pi**: `curl -sSL https://your-instance/scripts/raspberry-pi-setup.sh | bash`
   - **Debian 13 (headless)**: `curl -sSL https://your-instance/scripts/debian-13-setup.sh | sudo bash`
   - **Windows**: Run the setup script from `scripts/windows-setup.bat`
   - **Samsung Tizen TV / signage**: point the TV's URL Launcher (or browser) at `https://your-instance/player` - no signing needed. For an installed native app, see [tizen/README.md](tizen/README.md)
   - **Any browser**: Open `https://your-instance/player` in kiosk/fullscreen mode
4. Enter the pairing code shown on the device

> **Troubleshooting a player** (stuck on "Connecting to server", re-pointing a
> device to a different server, or connecting adb over Wi-Fi): see
> [docs/android-troubleshooting.md](docs/android-troubleshooting.md).

### For Developers

Working on ScreenTinker itself:

```bash
git clone https://github.com/screentinker/screentinker.git
cd screentinker/server
npm install
npm start          # starts in dev with --env-file-if-exists=.env
# or:
npm run dev        # same as start, plus --watch for auto-restart
```

**`.env` file (gitignored):** create `server/.env` for local configuration. Anything documented in the env var tables above works. Common starting set:

```
SELF_HOSTED=true
APP_URL=https://localhost:3443
# Optional: Microsoft Graph email config for testing real delivery
# GRAPH_TENANT_ID=...
# GRAPH_CLIENT_ID=...
# GRAPH_CLIENT_SECRET=...
# GRAPH_SENDER_EMAIL=you@yourcompany.com
# Optional: dev safety - only let these recipient emails through to Graph
# GRAPH_DEV_RESTRICT_TO=you@yourcompany.com,colleague@yourcompany.com
```

**No M365 access?** That's fine. With `GRAPH_*` env vars unset, `sendEmail()` short-circuits and logs `[EMAIL] not configured - would send to ...` to stdout. Everything else runs normally; only outbound email is suppressed. Useful for backend work that touches the email path without setting up an Azure app.

**Running against a fresh prod DB clone?** Set `GRAPH_DEV_RESTRICT_TO=your-email@example.com` to keep accidental sends from reaching real users in the cloned database. Sends to anyone outside the list are logged but never posted to Graph.

**Reporting issues:** [GitHub Issues](https://github.com/screentinker/screentinker/issues) for bugs and feature requests, or drop into [Discord](https://discord.gg/utTdsrqq4Z) for quick questions and feedback.

**Contributions welcome.** Fork → branch → PR. There are no formal style guides yet beyond what you can pick up from reading the existing code. Tests aren't required but smoke-test against your local server before opening a PR.

## Project Structure

```
server/           Node.js/Express backend
  config.js       Configuration and environment variables
  server.js       Main entry point
  db/             SQLite database, schema, and migrations
  routes/         API route handlers (devices, playlists, groups, schedules, etc.)
  middleware/     Auth (JWT + device tokens), rate limiting, file upload, sanitization
  services/       Background services (heartbeat, scheduler, alerts, activity logging)
  ws/             WebSocket handlers (device namespace + dashboard namespace)
  player/         Web-based display player
frontend/         Static SPA dashboard
  js/views/       View components (dashboard, playlists, groups, schedules, etc.)
  js/utils.js     Shared utilities (HTML escaping)
  css/            Stylesheets
  legal/          Terms, privacy, licenses
android/          Android TV/tablet player app (Kotlin, ExoPlayer)
scripts/          Device setup scripts + admin recovery
```

## Tech Stack

- **Backend:** Node.js 20.6+, Express, Socket.IO, SQLite (better-sqlite3)
- **Frontend:** Vanilla JS SPA (no framework, no build step), ES modules, Service Worker for offline support
- **Android:** Kotlin, ExoPlayer, Socket.IO client
- **Auth:** JWT with bcrypt, Google/Microsoft OAuth (optional)
- **Email:** Microsoft Graph via `@azure/msal-node` client-credentials (optional)
- **Payments:** Stripe (optional)
- **Data model:** multi-tenant — organizations contain workspaces contain resources; six-level role hierarchy gated server-side at every API route

## Support

ScreenTinker is built and maintained by one developer. If the project is useful to you and you want to support continued development:

- **[Donate via Wise](https://wise.com/pay/business/bytetinkerllc?utm_source=quick_pay)** — directly help fund continued development (ByteTinker LLC)
- Star the repo on GitHub
- Open [issues](https://github.com/screentinker/screentinker/issues) with feedback or bug reports
- Drop into the [Discord](https://discord.gg/utTdsrqq4Z) and say hi
- Contribute back if you've extended something useful

GitHub Sponsors integration is also planned. Direct contact: [dan@bytetinker.net](mailto:dan@bytetinker.net) or via Discord.

## License

[MIT](LICENSE)
````
