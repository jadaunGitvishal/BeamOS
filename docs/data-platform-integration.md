# Data Platform Integration (Snowflake / Databricks / dbt / Atlan)

Ref 28 — "Extensibility and integrations". (This is a separate, unrelated item
from the earlier Android offline-resilience Ref 28 work; the PMI tracking sheet
uses the same ID for both. Neither has been renamed.)

A guide to BeamOS's **out-of-the-box data-platform connector**: a background
service that lands content-analytics and player-metrics data in an
S3-compatible object store as gzipped newline-delimited JSON, and how
Snowflake, Databricks, dbt and Atlan each consume that landing zone. Written
the same way as [docs/bi-integration.md](bi-integration.md) and
[docs/data-export.md](data-export.md): what is actually built, cited against
real code, and an honest split between what BeamOS does automatically and
what your platform admin still has to configure.

The other half of the requirement ("expose interfaces allowing for custom
integration") was already covered before this Ref by the public REST API
([`docs/openapi.yaml`](openapi.yaml), served at `/docs`), the per-endpoint
exports in [docs/data-export.md](data-export.md), and Ref 73's read-scoped
API-token access for BI tools ([docs/bi-integration.md](bi-integration.md)).
Those are pull interfaces: something outside BeamOS has to call them. The
connector below is push. BeamOS writes the files itself on a schedule, so
nothing on the platform side has to poll an API.

## 1. What BeamOS does automatically

| | |
|---|---|
| **Service** | [`server/services/data-platform-export.js`](../server/services/data-platform-export.js), started from `server.js` **only** when `DATA_PLATFORM_EXPORT_ENABLED=true` |
| **Query logic** | [`server/lib/data-platform-export.js`](../server/lib/data-platform-export.js). It reuses existing queries instead of adding new SQL. See §3 |
| **Destination** | Any S3-compatible bucket: AWS S3, MinIO, Cloudflare R2, etc. (`@aws-sdk/client-s3`, with a configurable endpoint) |
| **Format** | Newline-delimited JSON (one object per line), gzipped (`.ndjson.gz`, `Content-Type: application/gzip`) |
| **Cadence** | Every `DATA_PLATFORM_EXPORT_INTERVAL_MIN` minutes (default 60) |
| **Granularity** | One object per workspace, per data domain, per sweep. Nothing is written when a domain has no new rows |

### Configuration

Set these in the process environment. See [`.env.example`](../.env.example);
the values are read in [`server/config.js`](../server/config.js)
(`dataPlatformExport`):

| Variable | Default | Notes |
|---|---|---|
| `DATA_PLATFORM_EXPORT_ENABLED` | off | Must be exactly `true`. Anything else means the interval never starts |
| `DATA_PLATFORM_S3_BUCKET` | — | Required |
| `DATA_PLATFORM_S3_PREFIX` | `beamos/` | Key prefix inside the bucket |
| `DATA_PLATFORM_S3_REGION` | `us-east-1` | Use `auto` for Cloudflare R2 |
| `DATA_PLATFORM_S3_ENDPOINT` | — | Only for non-AWS stores. When set, path-style addressing is used, which MinIO requires |
| `DATA_PLATFORM_S3_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | — | Leave both unset on AWS to use the SDK's default credential chain (e.g. an EC2/ECS instance role) |
| `DATA_PLATFORM_EXPORT_INTERVAL_MIN` | `60` | Minutes between sweeps |

The BeamOS side needs only `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>*`.
It never reads, lists or deletes anything.

### Object key layout

```
s3://<bucket>/<prefix><domain>/workspace_id=<workspace id>/dt=<YYYY-MM-DD>/<ts>.ndjson.gz
```

For example:

```
s3://my-data-lake/beamos/proof_of_play/workspace_id=3f1c…/dt=2026-09-29/1790690400.ndjson.gz
```

- `<domain>` is one of `device`, `uptime`, `sla`, `proof_of_play`, `tickets`,
  `sim_inventory`.
- `workspace_id=` and `dt=` are Hive-style partition segments. Databricks
  turns them into columns automatically, and Snowflake can read them from
  `METADATA$FILENAME`. `workspace_id` is also a field inside every row, so
  you don't need to parse the path.
- `dt` / `<ts>` are the end of the export window (UTC date, Unix seconds).
  Built by `exportObjectKey` in
  [`lib/data-platform-export.js`](../server/lib/data-platform-export.js).

### Windowing and delivery semantics

Each (workspace, domain) pair has its own watermark in `app_settings`, under
`data_platform_export_through:<workspace_id>:<domain>`. This is the same
restart-safe watermark pattern as
[`services/report-digest.js`](../server/services/report-digest.js). Each sweep
exports that domain's `[watermark, now)` window, and the watermark only moves
forward **after** the S3 write for that domain succeeds. If a write fails,
nothing is skipped: the same window is retried on the next sweep. A failure
in one workspace is logged and recorded, and doesn't stop the others.

| Domain | What each file contains | Natural key downstream |
|---|---|---|
| `device` | A **full snapshot** of the workspace's devices, taken every sweep | `device_id` (keep the latest file) |
| `uptime` | One row per device per **completed** UTC day. A day is exported once, on the first sweep after it ends, because its accrual row is still changing until midnight | `(device_id, uptime_day)` |
| `sla` | Outages that **ended** inside the window. Ongoing outages appear once they complete | `(device_id, sla_outage_started_at)` |
| `proof_of_play` | Plays that **started** inside the window | `(device_id, pop_started_at, pop_content_name)`. The play-log row id isn't in the export field registry |
| `tickets` | Tickets **created or changed** inside the window (`updated_at`), i.e. a change log | `id`, latest `updated_at` wins |
| `sim_inventory` | SIM records created or changed inside the window (`updated_at`) | `id`, latest `updated_at` wins |

Be aware of the following:

- **At-least-once, not exactly-once.** If the S3 write succeeds but the
  following watermark update fails (the DB is briefly unavailable), that
  window is written again on the next sweep under a new `<ts>` key.
  Deduplicate on the natural keys above. The dbt example in §6 does this.
- **The first sweep backfills everything.** A workspace with no watermark
  exports from epoch 0, so its first `proof_of_play` object holds the full
  play history. Each batch is built in memory, as the exports in
  [docs/data-export.md](data-export.md) are. That's fine for typical fleets,
  but check memory headroom before turning this on for a very large,
  long-lived tenant.
- **Deletes aren't propagated** for `tickets` / `sim_inventory`, because the
  change log only sees rows that still exist. `device` is a full snapshot, so
  a removed device simply disappears from the next file.
- **One bucket for every workspace on the instance.** The partitioning is by
  workspace, but whoever can read the bucket can read every workspace's
  files. Grant platform-side access at the prefix level, e.g.
  `beamos/*/workspace_id=<id>/`, if tenants must be kept apart downstream.

## 2. Setup checklist

| Step | Who | Where |
|---|---|---|
| Create the bucket, plus a write-only credential or instance role for BeamOS | Platform / cloud admin | AWS / MinIO / R2 |
| Set the `DATA_PLATFORM_*` env vars and restart BeamOS | BeamOS operator | Process manager / container env |
| Grant the warehouse read access to the bucket (storage integration / external location) | Warehouse admin | Snowflake / Databricks (§4, §5) |
| Create stages/tables and schedule loading | Warehouse admin | Snowflake / Databricks (§4, §5) |
| Declare the loaded tables as dbt sources and build models | Analytics engineer | dbt project (§6) |
| Point Atlan's crawlers at the bucket and warehouse | Data governance | Atlan (§7) |

Only the first two rows touch BeamOS. Everything after that is standard
platform-side configuration. BeamOS doesn't create Snowflake or Databricks
objects, and it holds no warehouse credentials.

### Checking and testing the export

Two endpoints in [`server/routes/workspaces.js`](../server/routes/workspaces.js)
let an admin check the export without reading server logs. They require a
dashboard session (JWT) and workspace-admin rights (`canAdminWorkspace`: the
workspace's `workspace_admin`, its org owner/admin, or a platform admin).
They are **not** reachable with an `st_` API token, because `/api/workspaces`
is a JWT-only router.

- `GET /api/workspaces/{id}/data-platform-export/status` returns `enabled`,
  `interval_min`, the S3 location for this workspace, each domain's
  `exported_through` watermark (epoch + ISO), and `last_error`
  (`{ at, domain, message }`, cleared by the next clean run).
- `POST /api/workspaces/{id}/data-platform-export/run-now` runs one sweep
  immediately for **this workspace only**. It returns the objects written and
  the updated status, so you can check that your Snowflake stage or
  Databricks location sees the files without waiting for the interval.
  It returns `409` when the feature is off or a sweep of this workspace is
  already running, and `502` with the error when the S3 write failed. Each
  manual run is recorded in the activity log (`data_platform_export_run`).

## 3. Schema

Every row is a flat JSON object. Timestamps are **Unix epoch seconds**
(integers). `uptime_day` is a `'YYYY-MM-DD'` string. Row shapes come from
existing code, so a field added to those sources shows up in the export
automatically:

- **`device` / `uptime` / `sla` / `proof_of_play`** use Ref 74's custom-report
  field registry ([`server/lib/report-fields.js`](../server/lib/report-fields.js))
  and are queried through `buildCustomReportQuery`
  ([`server/lib/report-query-builder.js`](../server/lib/report-query-builder.js)).
  Workspace scoping is the same `getWorkspaceDeviceFilter` every report uses.
  Keys are the registry field ids, with `workspace_id` prepended:

  | Domain | Fields |
  |---|---|
  | `device` | `workspace_id`, `device_id`, `device_name`, `device_status`, `device_blocked`, `device_manufacturer`, `device_model`, `device_android_version`, `device_app_version`, `device_installed_at`, `device_warranty_expiry`, `device_created_at`, `device_last_heartbeat` |
  | `uptime` | `workspace_id`, `device_id`, `device_name`, `uptime_day`, `uptime_online_seconds`, `uptime_pct` |
  | `sla` | `workspace_id`, `device_id`, `device_name`, `sla_outage_started_at`, `sla_outage_ended_at`, `sla_outage_duration_seconds`, `sla_outage_cause` |
  | `proof_of_play` | `workspace_id`, `device_id`, `device_name`, `pop_content_name`, `pop_started_at`, `pop_ended_at`, `pop_duration_sec`, `pop_completed`, `pop_trigger_type` |

- **`tickets`** uses exactly the shape `GET /api/workspaces/:id/tickets` and
  the Ref 73 `GET /api/tickets` return: `TICKET_SELECT` + `ticketRow` in
  [`server/lib/ticket-query.js`](../server/lib/ticket-query.js). That includes
  the computed `response_status`, `sla_due_at` and `sla_target_hours`.
- **`sim_inventory`** uses exactly the shape `GET /api/sim-inventory` returns:
  `SIM_SELECT` + `simRow` in [`server/lib/sim-query.js`](../server/lib/sim-query.js).

## 4. Snowflake

BeamOS writes the files, and the Snowflake admin creates the stage and loads
it. For AWS S3, a storage integration is the recommended form of access:

```sql
CREATE STORAGE INTEGRATION beamos_s3
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'S3'
  ENABLED = TRUE
  STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::<account>:role/snowflake-beamos-read'
  STORAGE_ALLOWED_LOCATIONS = ('s3://my-data-lake/beamos/');

CREATE FILE FORMAT beamos_ndjson
  TYPE = JSON
  COMPRESSION = GZIP;

CREATE STAGE beamos_landing
  URL = 's3://my-data-lake/beamos/'
  STORAGE_INTEGRATION = beamos_s3
  FILE_FORMAT = beamos_ndjson;
```

For a non-AWS S3-compatible store (MinIO, R2), Snowflake's S3-compatible
external stages use `URL = 's3compat://<bucket>/beamos/'` plus
`ENDPOINT = '<host>'` and `CREDENTIALS = (AWS_KEY_ID = … AWS_SECRET_KEY = …)`.
Check that your Snowflake account supports S3-compatible storage before you
rely on this.

Land each domain in a raw `VARIANT` table. This survives BeamOS adding fields
later:

```sql
CREATE TABLE IF NOT EXISTS beamos_raw.proof_of_play (
  v          VARIANT,
  file_name  STRING,
  loaded_at  TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

COPY INTO beamos_raw.proof_of_play (v, file_name)
  FROM (SELECT $1, METADATA$FILENAME FROM @beamos_landing/proof_of_play/)
  FILE_FORMAT = (TYPE = JSON, COMPRESSION = GZIP);
```

Repeat for `device`, `uptime`, `sla`, `tickets` and `sim_inventory`,
changing the table name and stage sub-path. `COPY INTO` tracks which files it
has already loaded, so it's safe to run on a schedule (a Snowflake `TASK`)
more often than BeamOS writes. If you'd rather load continuously, a Snowpipe
(`CREATE PIPE … AUTO_INGEST = TRUE AS COPY INTO …`) with an S3 event
notification on the prefix loads each object as soon as it lands.

If you want typed columns instead of `VARIANT`, create the table with the
field names from §3 and add `MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE` to the
`COPY INTO`.

## 5. Databricks

BeamOS writes the files, and the Databricks admin grants access (a Unity
Catalog **storage credential** + **external location** on
`s3://my-data-lake/beamos/`, or an instance profile) and schedules the load.

**Auto Loader** (incremental, tracks processed files in its checkpoint). Run
it as a scheduled job with `availableNow`, or continuously:

```python
(spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")          # .gz is decompressed by extension
    .option("cloudFiles.schemaLocation", "s3://my-data-lake/_databricks/schemas/proof_of_play")
    .option("cloudFiles.partitionColumns", "workspace_id,dt")
    .load("s3://my-data-lake/beamos/proof_of_play/")
  .writeStream
    .option("checkpointLocation", "s3://my-data-lake/_databricks/checkpoints/proof_of_play")
    .trigger(availableNow=True)
    .toTable("main.beamos_raw.proof_of_play"))
```

**`COPY INTO`** in SQL (also idempotent, since it skips already-loaded files):

```sql
CREATE TABLE IF NOT EXISTS main.beamos_raw.proof_of_play;

COPY INTO main.beamos_raw.proof_of_play
  FROM 's3://my-data-lake/beamos/proof_of_play/'
  FILEFORMAT = JSON
  COPY_OPTIONS ('mergeSchema' = 'true');
```

For MinIO or R2, set the S3A endpoint on the cluster
(`spark.hadoop.fs.s3a.endpoint`, `…path.style.access true`) and read via
`s3a://`.

## 6. dbt

dbt doesn't read S3. It models data that's already in the warehouse, so it
comes after §4 or §5. Declare the raw tables as sources:

```yaml
# models/beamos/sources.yml
version: 2

sources:
  - name: beamos
    database: ANALYTICS          # Snowflake database / Databricks catalog
    schema: beamos_raw
    loaded_at_field: loaded_at   # Snowflake example above; drop for Databricks
    freshness:
      warn_after: { count: 3, period: hour }   # ~3x the default 60-min export
    tables:
      - name: device
      - name: uptime
      - name: sla
      - name: proof_of_play
      - name: tickets
      - name: sim_inventory
```

A staging model that applies the §1 dedupe key (Snowflake `VARIANT` syntax):

```sql
-- models/beamos/stg_beamos__tickets.sql
select
  v:id::string                         as ticket_id,
  v:workspace_id::string               as workspace_id,
  v:device_id::string                  as device_id,
  v:status::string                     as status,
  v:priority::string                   as priority,
  v:response_status::string            as response_status,
  to_timestamp(v:created_at::number)   as created_at,
  to_timestamp(v:updated_at::number)   as updated_at
from {{ source('beamos', 'tickets') }}
qualify row_number() over (partition by v:id order by v:updated_at desc) = 1
```

If you'd rather have dbt manage external tables directly over the stage, the
`dbt-labs/dbt_external_tables` package can declare them against the same
`@beamos_landing` stage. It's still Snowflake/Databricks reading the files,
and dbt only orchestrates.

## 7. Atlan

**BeamOS doesn't integrate with Atlan directly, and can't.** BeamOS has no
metadata API for Atlan to crawl, and it doesn't push metadata into Atlan.
What makes Atlan work is the landing zone plus the schema documented above.
Atlan's own connectors catalog it from the platform side:

- Atlan's **Amazon S3** connector can catalog the bucket/prefix, so the six
  domain folders appear as assets.
- Atlan's **Snowflake** / **Databricks** connectors crawl the `beamos_raw`
  tables from §4/§5, including column-level metadata.
- Atlan's **dbt** connector picks up the §6 sources and models, which gives
  lineage from raw table to staging model to marts.

Nothing is needed on the BeamOS side beyond this export being on. Give
Atlan's crawler credentials read access to the bucket and warehouse,
following Atlan's own connector setup. To enrich the catalog, the field
descriptions in §3 can be copied into Atlan asset descriptions (or into dbt
`description:` fields, which Atlan imports).

## 8. Boundaries / what this is not

- **Batch, not streaming.** Latency is at most one interval (default 60 min)
  plus however often the warehouse loads. Live operational views stay on the
  API ([docs/bi-integration.md](bi-integration.md)).
- **One-way.** Nothing flows back from the data platform into BeamOS.
- **Not verified against a live S3 endpoint in CI.** The connector is covered
  by [`server/test/data-platform-export.test.js`](../server/test/data-platform-export.test.js),
  which runs against the real MySQL test database with a fake S3 client that
  records `putObject` calls. That test covers key layout, gzip, watermarks
  advancing only on a successful write, and one workspace's failure not
  blocking the others. The AWS SDK call itself (`PutObjectCommand` in
  `createS3Client`) is the one untested line, so run a first sweep against
  your real bucket before relying on it.
