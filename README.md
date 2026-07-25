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

mysqldump --single-transaction -u beamos_user -p beamos > backup.sql

To restore:

mysql -u beamos_user -p beamos < backup.sql


**Uploaded content** lives in `server/uploads/` — back this up separately (e.g. `rsync` or a scheduled copy).

Recommend automating both via cron for nightly backups.

## Admin Recovery

Locked out? Run this on the server:

node scripts/reset-admin.js


To create the very first platform_admin account directly (bypassing the public registration form entirely — the recommended way to bootstrap a production instance):

node scripts/create-platform-admin.js <email> <name> <password>


### Building the Android APK

cd android
export KEYSTORE_PASSWORD=your_password
export KEY_ALIAS=your_alias
export KEY_PASSWORD=your_password
./gradlew assembleDebug

cp android/app/build/outputs/apk/debug/app-debug.apk BeamOS.apk

Requirements: Java 17+, Android SDK (API 34).

## Device Setup

1. Register at your BeamOS instance
2. Go to **Displays** and click **Add Display**
3. Install the BeamOS app on your device:
   - **Android TV / tablets:** Download the APK from your instance (`/download/apk`) or build it from source
   - **Raspberry Pi:** `curl -sSL https://your-instance/scripts/raspberry-pi-setup.sh | sudo bash`
   - **Windows:** Run `scripts/windows-setup.bat`
   - **Samsung Tizen TV:** point the TV's URL Launcher at `https://your-instance/player`
   - **Any browser:** open `https://your-instance/player` in fullscreen mode
4. Enter the pairing code shown on the device

## For Developers

git clone https://github.com/jadaunGitvishal/BeamOS.git
cd BeamOS/server
npm install
npm start

or:

npm run dev # auto-restart on changes


Create `server/.env` for local configuration:

SELF_HOSTED=true
MYSQL_HOST=localhost
MYSQL_USER=beamos_user
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=beamos
APP_URL=https://localhost:3443


## Project Structure

server/ Node.js/Express backend
config.js Configuration and environment variables
server.js Main entry point
db/ MySQL connection pool, schema, and migrations
routes/ API route handlers
middleware/ Auth (JWT + device tokens), rate limiting, file upload
services/ Background services (heartbeat, scheduler, alerts, activity logging)
ws/ WebSocket handlers (device namespace + dashboard namespace)
player/ Web-based display player
frontend/ Static SPA dashboard
js/views/ View components
js/utils.js Shared utilities
css/ Stylesheets
android/ Android TV/tablet player app (Kotlin, ExoPlayer)
scripts/ Device setup scripts + admin recovery

## Tech Stack

- **Backend:** Node.js 20.6+, Express, Socket.IO, MySQL (mysql2)
- **Frontend:** Vanilla JS SPA, ES modules, Service Worker for offline support
- **Android:** Kotlin, ExoPlayer, Socket.IO client
- **Auth:** JWT with bcrypt, Google/Microsoft OAuth (optional)
- **Email:** Microsoft Graph via `@azure/msal-node` (optional)
- **Payments:** Stripe (optional)
- **Data model:** multi-tenant — organizations contain workspaces contain resources

## License

MIT

Step 5 — Push it:

git add .
git commit -m "Rewrite README for BeamOS with accurate MySQL documentation"
git push



````
