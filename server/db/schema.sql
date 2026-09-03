-- BeamOS MySQL schema (converted from the historical SQLite schema.sql +
-- every incremental migration previously carried in server/db/database.js
-- and scripts/migrate-multitenancy.js). This file is the full target shape
-- for a FRESH install — there is no separate migrations array to replay on
-- top of it, because there is no pre-existing MySQL install to upgrade.
--
-- Type conventions used throughout:
--   - id / FK columns holding UUID-ish strings:  VARCHAR(64)
--   - short enum-like strings (role, status,...): VARCHAR(50)
--   - names/paths/urls/hashes:                    VARCHAR(255) or VARCHAR(500)
--   - unbounded text (config JSON, notes, css):    TEXT
--   - known-large blobs (thumbnails, published
--     playlist snapshots):                        MEDIUMTEXT
--   - unix-seconds timestamps:                     BIGINT (avoids the INT/2038
--     rollover the original strftime('%s','now') INTEGER columns were exposed to)
--   - boolean-style 0/1 flags:                     TINYINT(1)
--
-- IMPORTANT: unlike SQLite, MySQL/InnoDB silently DROPS inline column-level
-- `REFERENCES` (SQL-92 style) — it parses but never creates an actual constraint,
-- so every FK below uses an explicit table-level `FOREIGN KEY (...) REFERENCES ...`
-- clause instead (verified against a live MySQL 8.0 instance: the inline form
-- produced zero rows in information_schema.KEY_COLUMN_USAGE and no cascade on
-- delete; the explicit form does both correctly).
--
-- FOREIGN_KEY_CHECKS is disabled for the duration of this script because
-- several tables forward-reference tables defined later in the file (e.g.
-- devices.playlist_id -> playlists, which is defined after devices) — the
-- same reason a mysqldump full-schema file always brackets itself this way.
-- Verified: explicit FOREIGN KEY clauses tolerate forward references under
-- FOREIGN_KEY_CHECKS=0 and still enforce/cascade correctly once re-enabled.
--
-- db/database.js's initDb() re-runs this whole file on every boot (matching the
-- old SQLite behavior of re-executing schema.sql on every start). CREATE TABLE
-- IF NOT EXISTS and INSERT IGNORE are natively idempotent; the standalone
-- CREATE INDEX statements below are NOT (MySQL has no `CREATE INDEX IF NOT
-- EXISTS` - confirmed against a live 8.0.36 instance, it's a parse error) so
-- initDb() splits this file into individual statements and swallows
-- ER_DUP_KEYNAME ("Duplicate key name") on the second-and-later boot, the same
-- discipline the old inline migrations array used for SQLite's "duplicate
-- column name".
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS plans (
    id                VARCHAR(64) PRIMARY KEY,
    name              VARCHAR(50) NOT NULL,
    display_name      VARCHAR(255) NOT NULL,
    max_devices       INT NOT NULL DEFAULT 2,
    max_storage_mb    INT NOT NULL DEFAULT 500,
    remote_control    TINYINT(1) NOT NULL DEFAULT 0,
    remote_url        TINYINT(1) NOT NULL DEFAULT 0,
    priority_support  TINYINT(1) NOT NULL DEFAULT 0,
    price_monthly     DOUBLE NOT NULL DEFAULT 0,
    price_yearly      DOUBLE NOT NULL DEFAULT 0,
    stripe_monthly_id VARCHAR(255),
    stripe_yearly_id  VARCHAR(255),
    stripe_price_monthly TEXT,
    stripe_price_yearly  TEXT,
    sort_order        INT NOT NULL DEFAULT 0,
    active            TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url, priority_support, price_monthly, price_yearly, sort_order)
VALUES
  ('free',       'free',       'Free',       -1,   -1,    1, 1, 1, 0,     0,     0),
  ('starter',    'starter',    'Starter',    -1,   -1,    1, 1, 1, 9.99,  99,    1),
  ('pro',        'pro',        'Pro',        -1,   -1,    1, 1, 1, 24.99, 249,   2),
  ('enterprise', 'enterprise', 'Enterprise', -1,   -1,    1, 1, 1, 49.99, 499,   3);

CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR(64) PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL DEFAULT '',
    password_hash   TEXT,
    auth_provider   VARCHAR(50) NOT NULL DEFAULT 'local',
    provider_id     VARCHAR(255),
    avatar_url      VARCHAR(500),
    role            VARCHAR(50) NOT NULL DEFAULT 'user',
    plan_id         VARCHAR(64) DEFAULT 'free',
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    subscription_status VARCHAR(50) DEFAULT 'active',
    subscription_ends  BIGINT,
    -- #100: TOTP MFA (opt-in, local accounts only). totp_secret_enc is secretbox-
    -- encrypted (REVERSIBLE - the server recomputes codes). totp_last_step blocks
    -- intra-window replay (a code from an already-consumed 30s step is rejected).
    totp_secret_enc TEXT,
    totp_enabled    TINYINT(1) NOT NULL DEFAULT 0,
    totp_last_step  BIGINT NOT NULL DEFAULT 0,
    email_alerts    TINYINT(1) DEFAULT 1,
    trial_started   BIGINT,
    trial_plan      VARCHAR(50) DEFAULT 'pro',
    last_login      BIGINT,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    welcome_email_sent_at    BIGINT,
    activation_nudge_sent_at BIGINT,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- #100: single-use TOTP recovery codes. SHA-256 hashed (same discipline as
-- api_tokens.token_hash); plaintext shown once at enrollment. used_at NULL = available.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id          VARCHAR(64) PRIMARY KEY,
    user_id     VARCHAR(64) NOT NULL,
    code_hash   VARCHAR(255) NOT NULL,
    created_at  BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    used_at     BIGINT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id);

-- ===================== ORGANIZATIONS / WORKSPACES (multi-tenancy) =====================
-- Originally created by scripts/migrate-multitenancy.js's Phase 1 auto-migration
-- (server/db/database.js -> ensureMultitenancyMigration), not by this file. Folded in
-- directly here since a fresh MySQL install has no pre-tenancy data to backfill.

CREATE TABLE IF NOT EXISTS organizations (
    id                      VARCHAR(64) PRIMARY KEY,
    name                    VARCHAR(255) NOT NULL,
    slug                    VARCHAR(255) UNIQUE,
    owner_user_id           VARCHAR(64) NOT NULL,
    plan_id                 VARCHAR(64) DEFAULT 'free',
    stripe_customer_id      VARCHAR(255),
    stripe_subscription_id  VARCHAR(255),
    subscription_status     VARCHAR(50) DEFAULT 'active',
    subscription_ends       BIGINT,
    grace_period_ends       BIGINT,
    locked_at               BIGINT,
    default_brand_name      VARCHAR(255),
    default_logo_url        VARCHAR(500),
    default_primary_color   VARCHAR(20),
    created_at              BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at              BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (owner_user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS organization_members (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL,
    user_id         VARCHAR(64) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'org_admin',
    invited_by      VARCHAR(64),
    joined_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE(organization_id, user_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_organization_members_user ON organization_members(user_id);

-- ===================== REGIONS (Phase 3 Stage A) =====================
-- Per-organization regional structure. Each org manages its own independent set
-- of regions; a workspace optionally belongs to one (workspaces.region_id, below,
-- ON DELETE SET NULL — deleting a region unassigns its workspaces, never deletes
-- them). Admin-managed via /api/organizations/:id/regions (org_admin+).
CREATE TABLE IF NOT EXISTS regions (
    id              VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE (organization_id, name),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_regions_organization ON regions(organization_id);

CREATE TABLE IF NOT EXISTS workspaces (
    id                    VARCHAR(64) PRIMARY KEY,
    organization_id       VARCHAR(64) NOT NULL,
    name                  VARCHAR(255) NOT NULL,
    slug                  VARCHAR(255),
    created_by            VARCHAR(64),
    region_id             VARCHAR(64),
    billing_type          VARCHAR(50) DEFAULT 'client_billable',
    billing_notes         TEXT,
    billing_contact_email VARCHAR(255),
    billing_contract_ref  VARCHAR(255),
    created_at            BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at            BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE(organization_id, slug),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    -- Phase 3 Stage A: never force-delete a workspace because its region went away.
    -- (InnoDB auto-creates an index for this FK column — on both the fresh CREATE
    -- here and the ALTER ... ADD CONSTRAINT repair in lib/schema-check.js — so no
    -- standalone CREATE INDEX is needed, and a standalone one would in fact fail
    -- on an existing DB where region_id isn't added until the schema-check pass.)
    FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_workspaces_organization ON workspaces(organization_id);

CREATE TABLE IF NOT EXISTS workspace_members (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    VARCHAR(64) NOT NULL,
    user_id         VARCHAR(64) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'workspace_viewer',
    invited_by      VARCHAR(64),
    joined_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE(workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
    id              VARCHAR(64) PRIMARY KEY,
    workspace_id    VARCHAR(64) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'workspace_viewer',
    invited_by      VARCHAR(64) NOT NULL,
    expires_at      BIGINT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64),
    workspace_id    VARCHAR(64),
    name            VARCHAR(255) NOT NULL DEFAULT 'Unnamed Display',
    pairing_code    VARCHAR(50) UNIQUE,
    status          VARCHAR(50) NOT NULL DEFAULT 'offline',
    blocked         TINYINT(1) NOT NULL DEFAULT 0,
    last_heartbeat  BIGINT,
    ip_address      VARCHAR(45),
    android_version VARCHAR(50),
    app_version     VARCHAR(50),
    screen_width    INT,
    screen_height   INT,
    render_width    INT,
    render_height   INT,
    playlist_id     VARCHAR(64),
    layout_id       VARCHAR(64),
    timezone        VARCHAR(100) DEFAULT 'UTC',
    reported_timezone VARCHAR(100),
    reported_utc    BIGINT,
    reported_at     BIGINT,
    wall_id         VARCHAR(64),
    team_id         VARCHAR(64),
    notes           TEXT,
    orientation     VARCHAR(50) DEFAULT 'landscape',
    default_content_id VARCHAR(64),
    device_token    VARCHAR(255),
    sort_order      INT NOT NULL DEFAULT 0,
    ota_status      VARCHAR(50) DEFAULT 'none',
    ota_target_version VARCHAR(100),
    ota_attempts    INT DEFAULT 0,
    ota_updated_at  BIGINT,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_devices_workspace ON devices(workspace_id);
CREATE INDEX idx_devices_provisioning ON devices(status, created_at);

CREATE TABLE IF NOT EXISTS device_telemetry (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    battery_level   INT,
    battery_charging TINYINT(1) NOT NULL DEFAULT 0,
    storage_free_mb INT,
    storage_total_mb INT,
    ram_free_mb     INT,
    ram_total_mb    INT,
    cpu_usage       DOUBLE,
    wifi_ssid       VARCHAR(255),
    wifi_rssi       INT,
    uptime_seconds  BIGINT,
    -- Ref 32: GPS location captured alongside the rest of the heartbeat telemetry.
    -- Both nullable and frequently NULL: the player only fills them when the runtime
    -- location permission is granted AND a fix is available (Play Services present,
    -- location services on). Sanitized server-side (lib/geo.js) before insert.
    latitude        DOUBLE,
    longitude       DOUBLE,
    reported_at     BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_telemetry_device ON device_telemetry(device_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS content (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64),
    workspace_id    VARCHAR(64),
    team_id         VARCHAR(64),
    filename        VARCHAR(500) NOT NULL,
    filepath        VARCHAR(500) NOT NULL DEFAULT '',
    mime_type       VARCHAR(100) NOT NULL,
    file_size       BIGINT NOT NULL DEFAULT 0,
    duration_sec    DOUBLE,
    thumbnail_path  VARCHAR(500),
    width           INT,
    height          INT,
    remote_url      VARCHAR(1000),
    folder          VARCHAR(255),
    folder_id       VARCHAR(64),
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES content_folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_content_workspace ON content(workspace_id);
CREATE INDEX idx_content_folder ON content(folder_id);

CREATE TABLE IF NOT EXISTS assignments (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    content_id      VARCHAR(64),
    widget_id       VARCHAR(64),
    zone_id         VARCHAR(64),
    sort_order      INT NOT NULL DEFAULT 0,
    duration_sec    INT NOT NULL DEFAULT 10,
    schedule_start  VARCHAR(20),
    schedule_end    VARCHAR(20),
    schedule_days   VARCHAR(50),
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    muted           TINYINT(1) DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS screenshots (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    filepath        VARCHAR(500) NOT NULL,
    captured_at     BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_screenshots_device ON screenshots(device_id, captured_at DESC);

-- ===================== LAYOUTS & ZONES =====================

CREATE TABLE IF NOT EXISTS layouts (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64),
    workspace_id    VARCHAR(64),
    team_id         VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    width           INT NOT NULL DEFAULT 1920,
    height          INT NOT NULL DEFAULT 1080,
    is_template     TINYINT(1) NOT NULL DEFAULT 0,
    template_category VARCHAR(50),
    thumbnail_data  MEDIUMTEXT,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS layout_zones (
    id              VARCHAR(64) PRIMARY KEY,
    layout_id       VARCHAR(64) NOT NULL,
    name            VARCHAR(255) NOT NULL DEFAULT 'Zone',
    x_percent       DOUBLE NOT NULL DEFAULT 0,
    y_percent       DOUBLE NOT NULL DEFAULT 0,
    width_percent   DOUBLE NOT NULL DEFAULT 100,
    height_percent  DOUBLE NOT NULL DEFAULT 100,
    z_index         INT NOT NULL DEFAULT 0,
    zone_type       VARCHAR(50) NOT NULL DEFAULT 'content',
    fit_mode        VARCHAR(50) NOT NULL DEFAULT 'contain',
    background_color VARCHAR(20) DEFAULT '#000000',
    sort_order      INT NOT NULL DEFAULT 0,
    FOREIGN KEY (layout_id) REFERENCES layouts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_zones_layout ON layout_zones(layout_id);

-- Seed templates
INSERT IGNORE INTO layouts (id, user_id, name, is_template, template_category) VALUES
  ('tpl-fullscreen',  NULL, 'Fullscreen',           1, 'basic'),
  ('tpl-split-h',     NULL, 'Split Horizontal',     1, 'split'),
  ('tpl-split-v',     NULL, 'Split Vertical',       1, 'split'),
  ('tpl-l-bar',       NULL, 'L-Bar with Ticker',    1, 'news'),
  ('tpl-pip',         NULL, 'Picture in Picture',   1, 'overlay'),
  ('tpl-thirds',      NULL, 'Three Column',         1, 'grid'),
  ('tpl-quad',        NULL, 'Four Quadrants',       1, 'grid');

INSERT IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
  ('z-fs-1',    'tpl-fullscreen', 'Main',           0, 0, 100, 100, 0, 0),
  ('z-sh-1',    'tpl-split-h',   'Left',            0, 0, 50, 100, 0, 0),
  ('z-sh-2',    'tpl-split-h',   'Right',           50, 0, 50, 100, 0, 1),
  ('z-sv-1',    'tpl-split-v',   'Top',             0, 0, 100, 50, 0, 0),
  ('z-sv-2',    'tpl-split-v',   'Bottom',          0, 50, 100, 50, 0, 1),
  ('z-lb-1',    'tpl-l-bar',     'Main Content',    0, 0, 75, 85, 0, 0),
  ('z-lb-2',    'tpl-l-bar',     'Side Panel',      75, 0, 25, 100, 0, 1),
  ('z-lb-3',    'tpl-l-bar',     'Bottom Ticker',   0, 85, 75, 15, 1, 2),
  ('z-pip-1',   'tpl-pip',       'Background',      0, 0, 100, 100, 0, 0),
  ('z-pip-2',   'tpl-pip',       'PiP Window',      65, 5, 30, 30, 1, 1),
  ('z-th-1',    'tpl-thirds',    'Left',            0, 0, 33.33, 100, 0, 0),
  ('z-th-2',    'tpl-thirds',    'Center',          33.33, 0, 33.34, 100, 0, 1),
  ('z-th-3',    'tpl-thirds',    'Right',           66.67, 0, 33.33, 100, 0, 2),
  ('z-q-1',     'tpl-quad',      'Top Left',        0, 0, 50, 50, 0, 0),
  ('z-q-2',     'tpl-quad',      'Top Right',       50, 0, 50, 50, 0, 1),
  ('z-q-3',     'tpl-quad',      'Bottom Left',     0, 50, 50, 50, 0, 2),
  ('z-q-4',     'tpl-quad',      'Bottom Right',    50, 50, 50, 50, 0, 3);

-- ===================== WIDGETS =====================

CREATE TABLE IF NOT EXISTS widgets (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64),
    workspace_id    VARCHAR(64),
    team_id         VARCHAR(64),
    widget_type     VARCHAR(50) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    config          TEXT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== SCHEDULES =====================

CREATE TABLE IF NOT EXISTS schedules (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    device_id       VARCHAR(64),
    group_id        VARCHAR(64),
    zone_id         VARCHAR(64),
    content_id      VARCHAR(64),
    widget_id       VARCHAR(64),
    layout_id       VARCHAR(64),
    playlist_id     VARCHAR(64),
    title           VARCHAR(255) NOT NULL DEFAULT '',
    start_time      VARCHAR(20) NOT NULL,
    end_time        VARCHAR(20) NOT NULL,
    timezone        VARCHAR(100) NOT NULL DEFAULT 'UTC',
    recurrence      VARCHAR(255),
    recurrence_end  VARCHAR(20),
    priority        INT NOT NULL DEFAULT 0,
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    color           VARCHAR(20) DEFAULT '#3B82F6',
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL)),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    -- SET NULL is impossible here: MySQL forbids an ON DELETE SET NULL action on a
    -- column that's also part of a CHECK constraint (nulling group_id while device_id
    -- stays NULL would violate the CHECK below). The app already deletes a group's
    -- schedules before deleting the group itself (routes/device-groups.js), so this
    -- CASCADE never actually differs from that in practice - it just makes the
    -- invariant DB-enforced instead of relying on delete-ordering.
    FOREIGN KEY (group_id) REFERENCES device_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES layout_zones(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE,
    FOREIGN KEY (layout_id) REFERENCES layouts(id) ON DELETE SET NULL,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_schedules_device ON schedules(device_id, enabled);
CREATE INDEX idx_schedules_group ON schedules(group_id, enabled);
CREATE INDEX idx_schedules_workspace ON schedules(workspace_id);

-- ===================== VIDEO WALLS =====================

CREATE TABLE IF NOT EXISTS video_walls (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    team_id         VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    grid_cols       INT NOT NULL DEFAULT 2,
    grid_rows       INT NOT NULL DEFAULT 2,
    bezel_h_mm      DOUBLE NOT NULL DEFAULT 0,
    bezel_v_mm      DOUBLE NOT NULL DEFAULT 0,
    screen_w_mm     DOUBLE NOT NULL DEFAULT 400,
    screen_h_mm     DOUBLE NOT NULL DEFAULT 225,
    sync_mode       VARCHAR(50) NOT NULL DEFAULT 'leader',
    leader_device_id VARCHAR(64),
    content_id      VARCHAR(64),
    playlist_id     VARCHAR(64),
    -- Free-form player rect on the wall canvas (NULL = use bounding box of screens)
    player_x        DOUBLE,
    player_y        DOUBLE,
    player_width    DOUBLE,
    player_height   DOUBLE,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (leader_device_id) REFERENCES devices(id) ON DELETE SET NULL,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE SET NULL,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_video_walls_workspace ON video_walls(workspace_id);

CREATE TABLE IF NOT EXISTS video_wall_devices (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    wall_id         VARCHAR(64) NOT NULL,
    device_id       VARCHAR(64) NOT NULL,
    grid_col        INT NOT NULL,
    grid_row        INT NOT NULL,
    rotation        INT NOT NULL DEFAULT 0,
    -- Free-form canvas rect (NULL = derive from grid_col/row + bezel as a fallback)
    canvas_x        DOUBLE,
    canvas_y        DOUBLE,
    canvas_width    DOUBLE,
    canvas_height   DOUBLE,
    UNIQUE(wall_id, device_id),
    UNIQUE(wall_id, grid_col, grid_row),
    FOREIGN KEY (wall_id) REFERENCES video_walls(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== TEAMS (legacy, pre-multitenancy) =====================

CREATE TABLE IF NOT EXISTS teams (
    id              VARCHAR(64) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    owner_id        VARCHAR(64) NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS team_members (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    team_id         VARCHAR(64) NOT NULL,
    user_id         VARCHAR(64) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'viewer',
    invited_by      VARCHAR(64),
    joined_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE(team_id, user_id),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS team_invites (
    id              VARCHAR(64) PRIMARY KEY,
    team_id         VARCHAR(64) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'viewer',
    invited_by      VARCHAR(64) NOT NULL,
    expires_at      BIGINT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== PROOF-OF-PLAY =====================

CREATE TABLE IF NOT EXISTS play_logs (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    content_id      VARCHAR(64),
    widget_id       VARCHAR(64),
    zone_id         VARCHAR(64),
    content_name    VARCHAR(500) NOT NULL DEFAULT '',
    started_at      BIGINT NOT NULL,
    ended_at        BIGINT,
    duration_sec    INT,
    completed       TINYINT(1) NOT NULL DEFAULT 0,
    trigger_type    VARCHAR(50) DEFAULT 'playlist',
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Client-generated id shared by a play_start/play_end pair. Lets offline-queued
    -- events be retried/replayed in any order without double-inserting (see
    -- device:play-event in ws/deviceSocket.js). NULL for pre-offline-queue clients.
    session_id      VARCHAR(64) NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE SET NULL,
    FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE SET NULL,
    UNIQUE KEY uniq_play_logs_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_play_logs_device ON play_logs(device_id, started_at DESC);
CREATE INDEX idx_play_logs_content ON play_logs(content_id, started_at DESC);
CREATE INDEX idx_play_logs_time ON play_logs(started_at, ended_at);

-- ===================== DEVICE GROUPS =====================

CREATE TABLE IF NOT EXISTS device_groups (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    color           VARCHAR(20) DEFAULT '#3B82F6',
    playlist_id     VARCHAR(64),
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_device_groups_workspace ON device_groups(workspace_id);

CREATE TABLE IF NOT EXISTS device_group_members (
    device_id       VARCHAR(64) NOT NULL,
    group_id        VARCHAR(64) NOT NULL,
    PRIMARY KEY (device_id, group_id),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES device_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== PLAYLISTS =====================

CREATE TABLE IF NOT EXISTS playlists (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_auto_generated TINYINT(1) NOT NULL DEFAULT 0,
    status          VARCHAR(50) NOT NULL DEFAULT 'draft',
    published_snapshot MEDIUMTEXT,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_playlists_workspace ON playlists(workspace_id);

CREATE TABLE IF NOT EXISTS playlist_items (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    playlist_id     VARCHAR(64) NOT NULL,
    content_id      VARCHAR(64),
    widget_id       VARCHAR(64),
    zone_id         VARCHAR(64),
    sort_order      INT NOT NULL DEFAULT 0,
    duration_sec    INT NOT NULL DEFAULT 10,
    muted           TINYINT(1) NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES layout_zones(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-playlist-item schedule blocks (#74 dayparting + #75 expiry). 1-to-many:
-- an item with ZERO rows here is always on; otherwise it shows when device-local
-- "now" matches at least one block. Wall-clock rules (local HH:MM + local dates),
-- evaluated on the device via the shared evaluator (server/lib/schedule-eval.js).
-- Pure child of playlist_items: cascade-deleted, and tenant isolation flows
-- through the parent item/playlist, so no workspace_id is needed here.
CREATE TABLE IF NOT EXISTS playlist_item_schedules (
    id               VARCHAR(64) PRIMARY KEY,
    playlist_item_id INT NOT NULL,
    active_days      VARCHAR(20) NOT NULL DEFAULT '0,1,2,3,4,5,6',  -- comma-separated 0(Sun)-6(Sat)
    start_time       VARCHAR(10) NOT NULL DEFAULT '00:00',          -- local HH:MM
    end_time         VARCHAR(10) NOT NULL DEFAULT '24:00',          -- local HH:MM ("24:00" = end of day)
    start_date       VARCHAR(10),                                   -- local YYYY-MM-DD, nullable = no lower bound
    end_date         VARCHAR(10),                                   -- local YYYY-MM-DD, nullable = no upper bound
    sort_order       INT NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (playlist_item_id) REFERENCES playlist_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_playlist_item_schedules_item ON playlist_item_schedules(playlist_item_id);

-- ===================== CONTENT FOLDERS =====================
-- Hierarchical content folders (per-user). Originally added by an inline
-- migration in server/db/database.js, not by the base SQLite schema.sql.

CREATE TABLE IF NOT EXISTS content_folders (
    id          VARCHAR(64) PRIMARY KEY,
    user_id     VARCHAR(64) NOT NULL,
    workspace_id VARCHAR(64),
    parent_id   VARCHAR(64),
    name        VARCHAR(255) NOT NULL,
    created_at  BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES content_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_content_folders_user ON content_folders(user_id, parent_id);
CREATE INDEX idx_content_folders_workspace ON content_folders(workspace_id);

-- ===================== ACTIVITY LOG =====================

CREATE TABLE IF NOT EXISTS activity_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         VARCHAR(64),
    device_id       VARCHAR(64),
    workspace_id    VARCHAR(64),
    organization_id VARCHAR(64),
    acting_user_id  VARCHAR(64),
    was_acting_as   TINYINT(1) DEFAULT 0,
    action          VARCHAR(255) NOT NULL,
    details         TEXT,
    ip_address      VARCHAR(45),
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (acting_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_activity_log_time ON activity_log(created_at DESC);
CREATE INDEX idx_activity_log_user ON activity_log(user_id, created_at DESC);

-- ===================== WHITE LABEL =====================

CREATE TABLE IF NOT EXISTS white_labels (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    brand_name      VARCHAR(255) NOT NULL DEFAULT 'ScreenTinker',
    logo_url        VARCHAR(500),
    favicon_url     VARCHAR(500),
    primary_color   VARCHAR(20) DEFAULT '#3B82F6',
    secondary_color VARCHAR(20) DEFAULT '#1E293B',
    bg_color        VARCHAR(20) DEFAULT '#111827',
    custom_domain   VARCHAR(255),
    custom_css      TEXT,
    hide_branding   TINYINT(1) DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== AI (BYOK) SETTINGS =====================
-- #41: per-workspace AI design generation. Bring-your-own OpenAI-COMPATIBLE
-- endpoint (OpenAI cloud, or self-hosted: Ollama / LM Studio / llama.cpp, and
-- AUTOMATIC1111 etc. for images), so the operator bears no AI cost. api_key_enc
-- is AES-256-GCM encrypted (lib/secretbox.js); it is never returned to clients.
CREATE TABLE IF NOT EXISTS ai_settings (
    workspace_id    VARCHAR(64) PRIMARY KEY,
    base_url        VARCHAR(500),
    api_key_enc     TEXT,
    model           VARCHAR(255),
    image_base_url  VARCHAR(500),
    image_model     VARCHAR(255),
    image_provider  VARCHAR(50),
    image_api_key_enc TEXT,
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== KIOSK PAGES =====================

CREATE TABLE IF NOT EXISTS kiosk_pages (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    config          TEXT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== DEVICE STATUS LOG =====================

CREATE TABLE IF NOT EXISTS device_status_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    status          VARCHAR(50) NOT NULL,
    timestamp       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- #142: index the per-device + time-window access pattern. Both the dashboard
-- uptime query (WHERE device_id=? AND timestamp>?) and the retention prune
-- (WHERE device_id=? AND timestamp<?) were full table scans; at 1M+ rows that
-- was the dashboard-degradation cause in the outage report. No FK to devices
-- here (matches the original SQLite schema) - rows must survive device deletion
-- for audit purposes, and the retention sweep prunes it independently.
CREATE INDEX idx_device_status_log_device_ts ON device_status_log(device_id, timestamp);

-- ===================== DEVICE EVENTS (Phase 2 Stage A) =====================
-- Discrete device-side events the Android player reports over the socket
-- (device:report-event -> lib/device-audit.js recordDeviceEvent): playlist_resumed,
-- update_installed, update_failed, ... event_type is deliberately open-ended
-- (VARCHAR, no enum) so a new Android build can add a type without a schema change;
-- lib/device-audit.js phraseEvent() maps known types to a sentence and renders
-- unknown ones generically. workspace_id is snapshotted from the device at write
-- time (nullable: a not-yet-paired device has none). Feeds the plain-language
-- audit trail. Bounded per device insert-time (config.deviceEventsMaxPerDevice),
-- like device_telemetry — no separate sweep.
CREATE TABLE IF NOT EXISTS device_events (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    event_type      VARCHAR(64) NOT NULL,
    message         TEXT,
    occurred_at     BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_device_events_device_time ON device_events(device_id, occurred_at DESC);

-- ===================== EVENT LOOP LAG (#142) =====================
-- Event-loop delay telemetry from perf_hooks.monitorEventLoopDelay(). Bounded
-- from day one: indexed on sampled_at and pruned on a schedule (see
-- services/loop-lag.js, LAG_TELEMETRY_RETENTION_DAYS) so it can never become a
-- second unbounded-growth table.
CREATE TABLE IF NOT EXISTS event_loop_lag (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    sampled_at  BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    mean_ms     DOUBLE NOT NULL,
    p50_ms      DOUBLE NOT NULL,
    p99_ms      DOUBLE NOT NULL,
    max_ms      DOUBLE NOT NULL,
    band        VARCHAR(50) NOT NULL DEFAULT 'normal'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_event_loop_lag_sampled ON event_loop_lag(sampled_at);

-- ===================== DEVICE FINGERPRINTS =====================

CREATE TABLE IF NOT EXISTS device_fingerprints (
    fingerprint     VARCHAR(255) NOT NULL,
    device_id       VARCHAR(64),
    user_id         VARCHAR(64),
    first_seen      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    last_seen       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (fingerprint),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alert_configs (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64),
    alert_type      VARCHAR(50) NOT NULL,
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    config          TEXT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================== PLAYER DEBUG LOGS =====================
-- Smart TVs (Tizen, WebOS, Fire TV, etc.) have no accessible devtools. The
-- player captures errors into window.__debugLog client-side and POSTs them
-- to /api/player-debug. This table stores those reports. Submitter is
-- unauthenticated by design - the player may not have paired yet when an
-- error fires. device_id is nullable for unpaired players (and intentionally
-- has no FK here, matching the original SQLite schema, since reports must
-- survive a device being deleted/re-paired).
--
-- Capped at 10,000 rows with FIFO eviction on insert (route-side, no sweep).
-- error_fingerprint is a client-computed hash of (error message + first stack
-- frame) - indexed so a future "top N unique errors this week" query is fast
-- without a schema change.

CREATE TABLE IF NOT EXISTS player_debug_logs (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id         VARCHAR(64),
    ip                VARCHAR(45),
    user_agent        VARCHAR(500),
    url               VARCHAR(500),
    error_fingerprint VARCHAR(255),
    error_data        TEXT,
    context           TEXT,
    created_at        BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_player_debug_fingerprint ON player_debug_logs(error_fingerprint);
CREATE INDEX idx_player_debug_created_at ON player_debug_logs(created_at);

-- ===================== API TOKENS (public API, Phase 1) =====================
-- Scoped personal access tokens for the public API. The full token (st_...) is
-- shown to its owner exactly once at creation; only its SHA-256 hash is stored.
-- A token is bound to ONE workspace and a scope (read|write|full) and always acts
-- with the owner's workspace role - never platform/cross-org powers (apiTokenAuth
-- forces the effective platform role to 'user').
CREATE TABLE IF NOT EXISTS api_tokens (
    id              VARCHAR(64) PRIMARY KEY,
    token_hash      VARCHAR(64) NOT NULL UNIQUE,              -- SHA-256 hex of the full token
    prefix          VARCHAR(50) NOT NULL,                     -- e.g. 'st_a1b2c3d4' (display only)
    name            VARCHAR(255) NOT NULL,                    -- user-given label
    user_id         VARCHAR(64) NOT NULL,
    workspace_id    VARCHAR(64) NOT NULL,
    scope           VARCHAR(50) NOT NULL DEFAULT 'read',      -- 'read' | 'write' | 'full' | 'agency' | 'billing:read'
    auto_publish    TINYINT(1) NOT NULL DEFAULT 0,             -- #73: agency only. 0 = items land DRAFT (default, fail-safe); 1 = admin opted this agency out of approval
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    last_used_at    BIGINT,
    revoked_at      BIGINT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

-- #73: target allowlist for capability-restricted ('agency') tokens. An agency token
-- (scope='agency', OFF the read/write/full ladder so tokenScopeGate rejects it on every
-- other router) may act ONLY on the playlists listed here, enforced at the single
-- agencyGate seam. FK cascade both ways: revoke the token or delete the playlist and the
-- grant disappears.
CREATE TABLE IF NOT EXISTS api_token_targets (
    token_id    VARCHAR(64) NOT NULL,
    playlist_id VARCHAR(64) NOT NULL,
    created_at  BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (token_id, playlist_id),
    FOREIGN KEY (token_id) REFERENCES api_tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- #73: agency-upload notification queue. The agency endpoint enqueues one row per item added
-- (only when email is configured); a 15-min flush job groups per token+playlist+action and
-- sends one digest per group, stamping sent_at ONLY after a successful send (failed -> retry).
CREATE TABLE IF NOT EXISTS agency_notifications (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL,
    token_id     VARCHAR(64) NOT NULL,
    playlist_id  VARCHAR(64) NOT NULL,
    action       VARCHAR(50) NOT NULL,                        -- 'draft' | 'published'
    content_id   VARCHAR(64),
    created_at   BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    sent_at      BIGINT                                       -- NULL = unsent
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_agency_notifications_unsent ON agency_notifications(sent_at);

-- ===================== APP SETTINGS =====================
-- #146: minimal global key/value settings for admin-toggleable runtime flags (none
-- existed - ai_settings is per-workspace, white_labels is branding). Originally added
-- by an inline migration in server/db/database.js, not by the base SQLite schema.sql.
CREATE TABLE IF NOT EXISTS app_settings (
    `key`       VARCHAR(255) PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ref 51 (SLA Dashboard, Stage 1): PLATFORM-WIDE SLA targets. Deliberately in
-- app_settings, not a per-workspace table or a new singleton table: the target is
-- one number for the whole platform (not per-tenant), it's admin-toggleable at
-- runtime, and app_settings already gives us the in-memory cache + set() API +
-- an admin-route precedent (status_debug_enabled). A new table would need its own
-- single-row enforcement, cache and CRUD for no benefit. INSERT IGNORE seeds the
-- defaults so an admin sees a concrete current value; lib/app-settings.getNum()
-- still falls back to the config.js env default if the row is ever absent.
--   sla_uptime_target_pct          - uptime % at/above which a device is Compliant
--   sla_escalation_threshold_hours - hours a device may be continuously offline
--                                    before the ongoing outage is a live breach
INSERT IGNORE INTO app_settings (`key`, value) VALUES
    ('sla_uptime_target_pct', '99.0'),
    ('sla_escalation_threshold_hours', '4');

-- ===================== BILLING USAGE ROLLUP =====================
-- #146 BILLING: durable daily usage rollup (contractual system-of-record). One tiny row
-- per device per calendar day; accumulated incrementally off the heartbeat tick (NOT
-- reconstructed from status_log, which is 3-day retention). Retained ~400 days, pruned
-- chunked. day is UTC 'YYYY-MM-DD'; the index serves month-range queries. Originally
-- added by an inline migration in server/db/database.js, not by the base SQLite schema.sql.
CREATE TABLE IF NOT EXISTS device_usage_daily (
    device_id       VARCHAR(64) NOT NULL,
    day             VARCHAR(10) NOT NULL,
    online_seconds  INT NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_usage_daily_day ON device_usage_daily(day);

-- ===================== OUTAGE HISTORY (Ref 51, SLA Dashboard) =====================
-- Durable record of COMPLETED device outages (offline -> back online), one row per
-- outage. Exists for the SAME reason device_usage_daily does: device_status_log is
-- pruned to ~3 days (config.statusLogRetentionDays), so MTTR computed straight off
-- it can only ever look back 3 days. This is the long-term rollup that lifts that
-- limit - accrued by services/outage-history.js, which every ~30 min runs the shared
-- LAG/LEAD detector (lib/outage-detection.js, the SAME query GET /sla-overview uses
-- for its live view) over a window well inside the retention horizon and inserts any
-- completed outage not already here. NOT touched by the 3-day status-log prune;
-- retained ~400 days and pruned chunked by that same service.
--
-- UNIQUE (device_id, started_at) is the idempotency key: a re-run of the recorder
-- over an already-processed window is a safe no-op. Ongoing outages are NOT stored
-- here (no ended_at yet) - the endpoint reads those live from device_status_log.
CREATE TABLE IF NOT EXISTS outage_history (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id         VARCHAR(64) NOT NULL,
    workspace_id      VARCHAR(64) NOT NULL,
    started_at        BIGINT NOT NULL,
    ended_at          BIGINT NOT NULL,
    duration_seconds  BIGINT NOT NULL,
    recorded_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uq_outage_history_device_started (device_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Serves the per-workspace, per-period MTTR query in GET /sla-overview.
CREATE INDEX idx_outage_history_ws_started ON outage_history(workspace_id, started_at);
-- Serves the recorder's "already recorded?" prefilter and the retention prune.
CREATE INDEX idx_outage_history_started ON outage_history(started_at);

-- ===================== OUTAGE ESCALATIONS (Ref 51, SLA Dashboard) =====================
-- One row per ONGOING outage that has been escalated by email (services/
-- outage-escalation.js). This table IS the anti-spam mechanism, not a report:
-- the escalation sweep runs every ~15 min, and before emailing it checks for a
-- row matching (device_id, outage_start) — present means "already alerted for
-- THIS incident, do nothing". Same idempotency pattern as outage_history's
-- unique key.
--
-- outage_start comes from the shared detector (lib/outage-detection.js), so if a
-- device recovers and then breaks again it gets a NEW outage_start and therefore
-- a fresh escalation — correct, that is a genuinely new incident. recipient_email
-- is the comma-joined list of workspace_admins actually mailed (informational;
-- the unique key is the real guard).
CREATE TABLE IF NOT EXISTS outage_escalations (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id        VARCHAR(64) NOT NULL,
    workspace_id     VARCHAR(64) NOT NULL,
    outage_start     BIGINT NOT NULL,
    alerted_at       BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    recipient_email  VARCHAR(500) NOT NULL,
    UNIQUE KEY uq_outage_escalations_device_start (device_id, outage_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Serves the sweep's "already escalated?" prefilter.
CREATE INDEX idx_outage_escalations_start ON outage_escalations(outage_start);

-- ===================== DEVICE REGISTRATION CODES (Ref 30) =====================
-- Ref 30 Stage 1: advance device registration codes. A workspace_admin (or org /
-- platform admin) generates a 6-digit code ahead of an install, optionally naming
-- the device it is destined for. An installer later enters that code ON the device
-- to bind it to the workspace - no admin present at install time.
--
-- Distinct from devices.pairing_code: there the DEVICE generates the code on first
-- contact and the admin types it into the dashboard. Here the ADMIN generates the
-- code and the device consumes it (the device-side claim is Stage 2, not built yet).
--
-- status: 'unused' (freshly generated, claimable) | 'claimed' (a device consumed it).
-- A claimed row keeps its code value for the audit trail; new codes only avoid
-- colliding with other 'unused' rows, and any live lookup filters status = 'unused'.
--
-- expires_at: set at generation to created_at + 30 days. A code never claimed
-- stops being claimable past this point (the claim endpoint returns 410), so an
-- unused code can't linger indefinitely as a brute-force target. Expired rows are
-- kept (not deleted) for the audit trail; staff regenerate a fresh code from the
-- old row via POST .../:id/regenerate.
CREATE TABLE IF NOT EXISTS registration_codes (
    id                   VARCHAR(64) PRIMARY KEY,
    code                 VARCHAR(6) NOT NULL UNIQUE,
    workspace_id         VARCHAR(64) NOT NULL,
    planned_device_name  VARCHAR(255),
    status               VARCHAR(20) NOT NULL DEFAULT 'unused',
    created_by           VARCHAR(64) NOT NULL,
    created_at           BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    expires_at           BIGINT,
    claimed_by_device_id VARCHAR(64),
    claimed_at           BIGINT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (claimed_by_device_id) REFERENCES devices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_registration_codes_workspace ON registration_codes(workspace_id, created_at DESC);

-- ===================== TICKETS (Phase 4 Stage A + B) =====================
-- Operational tickets against a workspace (and optionally a specific device).
-- Stage A is manual: a workspace_editor+ opens one by hand. Stage B adds
-- automatic creation on a live SLA breach (services/sla-breach-ticket.js,
-- driven off the outage-escalation tick). Every route mutation is mirrored to
-- activity_log by the route handlers.
--
-- owner_category is a plain VARCHAR, NOT an ENUM - same philosophy as
-- device_events.event_type: the route validates against a known set
-- (routes/workspaces.js TICKET_OWNER_CATEGORIES) that can grow without a
-- schema migration. Current expected values: 'customer_it', 'store_staff',
-- 'platform', 'hardware', 'unassigned'.
-- status:   'open' | 'in_progress' | 'resolved' | 'closed'
-- priority: 'low' | 'medium' | 'high'
-- resolved_at is stamped when status first moves to resolved/closed and
-- cleared if it moves back to open/in_progress.
-- device_id ON DELETE SET NULL: a removed device leaves its ticket history
-- intact. created_by ON DELETE SET NULL: same for a removed user.
--
-- Stage B auto-creation tracking:
--   auto_source          NULL for a hand-made ticket; 'sla_breach' for one the
--                        SLA monitor opened. (created_by is also NULL for those,
--                        so system tickets are distinguishable two ways.)
--   source_outage_start  the detectOutages() outage_start epoch the ticket was
--                        opened for. Together with device_id this is the
--                        idempotency key: UNIQUE (device_id, source_outage_start)
--                        stops a second ticket for the same ongoing outage
--                        across ticks / concurrent sweeps - the exact pattern
--                        outage_escalations uses. Manual tickets leave
--                        source_outage_start NULL and MySQL does not collide
--                        NULLs, so any number of them coexist.
CREATE TABLE IF NOT EXISTS tickets (
    id                  VARCHAR(64) PRIMARY KEY,
    workspace_id        VARCHAR(64) NOT NULL,
    device_id           VARCHAR(64),
    title               VARCHAR(255) NOT NULL,
    description         TEXT,
    owner_category      VARCHAR(50) NOT NULL DEFAULT 'unassigned',
    status              VARCHAR(50) NOT NULL DEFAULT 'open',
    priority            VARCHAR(50) NOT NULL DEFAULT 'medium',
    created_by          VARCHAR(64),
    auto_source         VARCHAR(50),
    source_outage_start BIGINT,
    created_at          BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_at          BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    resolved_at         BIGINT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uq_tickets_source_outage (device_id, source_outage_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_tickets_workspace ON tickets(workspace_id, status, created_at DESC);
CREATE INDEX idx_tickets_device ON tickets(device_id);

-- ===================== SCHEMA MIGRATIONS =====================

CREATE TABLE IF NOT EXISTS schema_migrations (
    id              VARCHAR(255) PRIMARY KEY,
    ran_at          BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
