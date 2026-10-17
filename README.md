# TripTrack

TripTrack is an offline-first factory visit scheduler for overseas sourcing trips. All edits land in a local SQLite database first and sync to a server when a connection is available.

## Architecture

```
frontend/                     Local app (data layer + app server + web UI)
  src/db/                     SQLite schema, connection, migrations (node:sqlite)
  src/repositories/           Trip / city / supplier / visit / sample / photo / settings CRUD
  src/sync/                   Pending-op queue, sync engine, HTTP transport, photo uploader
  src/server/appServer.ts     JSON API + static UI server
  public/                     Dependency-free web UI (vanilla HTML/CSS/JS)
backend/
  src/server.ts               Sync server: push/pull endpoints + photo upload storage
android/
  AndroidManifest.xml         Android client (WebView shell for the TripTrack server)
  src/.../MainActivity.java
  build.sh                    Builds build/TripTrack.apk with plain SDK tools (no Gradle)
```

Zero npm dependencies anywhere — everything runs on Node ≥ 22 built-ins (`node:sqlite`, `node:http`, `node:test`).

## Running

Start the sync server (defaults to port 4000):

```bash
cd backend
TRIPTRACK_SERVER_DB=server.db npm start
```

Start the app (defaults to port 3000), then open http://localhost:3000:

```bash
cd frontend
TRIPTRACK_DB=local.db TRIPTRACK_SYNC_URL=http://localhost:4000 npm start
```

Both DB env vars are optional (in-memory if unset). Without `TRIPTRACK_SYNC_URL` the app runs fully offline and the Sync button is disabled.

## How sync works

- Every repository write stamps a UTC `updated_at`, sets `synced = 0`, and enqueues an `upsert` op in `pending_ops` carrying the full row as JSON. Ops are coalesced: one op per row, always holding the latest state (soft deletes are `deleted = 1`), at its original queue position.
- **Push** drains the queue in order through a pluggable `SyncTransport`, marks rows `synced = 1` (guarded by `updated_at` so in-flight edits stay dirty), and stops at the first failure.
- **Pull** applies remote rows with last-write-wins on `updated_at`, marks them `synced = 1` without re-queueing, and records `last_sync_at` (in `settings`) to pass as `since` next time.
- The server tracks its own `server_updated_at` per row so pulls never miss late-arriving edits, and applies the same last-write-wins rule on push.
- Photos upload separately: `uploaded = 0` rows queue locally until `uploadPendingPhotos` posts the bytes and `markPhotoUploaded` stamps the returned `server_url`.

## Tests

```bash
cd frontend && npm test    # repositories, sync engine, app server, HTTP integration
cd backend && npm test     # sync server endpoints
```

## Build history

- **Step 1** — SQLite schema (trips, cities, suppliers, visits, samples, photos, pending_ops, settings) and the trip repository.
- **Step 2** — City, supplier, visit (status transitions), and sample repositories with shared helpers.
- **Step 3** — Offline sync: coalescing pending-op queue, settings repository, sync engine with pluggable transport.
- **Step 4** — Photo repository with parent lookup, pending-upload queue, and upload stamping.
- **Step 5** — Backend sync server (push/pull/photo upload), real HTTP transport, photo uploader, end-to-end integration test.
- **Step 6** — App server (JSON API over the repositories) and the dependency-free web UI: trips & itinerary, day schedule with visit status flow and samples, supplier book, and a sync bar with pending-op count.
- **Step 7** — Admin page: user management (create/edit/soft-delete with `ADMIN`/`MEMBER` roles, unique active emails; users are a synced table like everything else) and data transfer — Export downloads a full-fidelity JSON dump of every synced table; Import merges a dump with last-write-wins on `updated_at`, treats applied rows as local edits (queued for sync), and validates tables/columns so a crafted file cannot inject SQL. Endpoints: `/api/users`, `/api/admin/export`, `/api/admin/import`.
- **Step 8** — Supplier map links: `map_url` column (with a `COLUMN_MIGRATIONS` mechanism that upgrades existing databases on startup), a Google Maps link field on the supplier form, and a 📍 Map button on every supplier card — opens the saved share link, or falls back to a Google Maps search for the supplier's Chinese/English address or name.
- **Step 9** — Android APK (`android/`): a native WebView client for the TripTrack server, built with plain SDK tools via `android/build.sh` (aapt2 → javac → d8 → zipalign → apksigner; no Gradle). In the emulator it reaches the host server at `http://10.0.2.2:3600` automatically; on a real phone, install `build/TripTrack.apk` and launch with `adb shell am start -n com.triptrack.app/.MainActivity -e server_url http://<laptop-ip>:3600` (phone and laptop on the same WiFi). The app itself remains server-hosted — the APK is a thin client, not an offline port.
- **Step 10** — Supplier Excel import: an "Import from Excel" card on the Suppliers page accepting `.xlsx` or `.csv` (`POST /api/suppliers/import`). The `.xlsx` parser is dependency-free (`src/importers/supplierImport.ts` reads the ZIP container with `node:zlib` and the sheet/sharedStrings XML directly). Headers are matched flexibly (Name, Name CN, Contact, Mobile/Phone, WeChat, Category, Address, Address CN, Map URL, Notes — first row must be headers), rows missing a name are reported, existing suppliers are skipped by name, and imported rows queue for sync like normal writes. A "Download sample sheet" button (`GET /api/suppliers/sample-sheet`) serves a generated `.xlsx` template with the expected headers and two example rows.
- **Step 11** — Full supplier profile, driven by a real manufacturer master sheet: nine new supplier columns (`whatsapp`, `email`, `website`, `region`, `products`, `specialty`, `established`, `employees`, `export_markets`), importer aliases for real-world headers (e.g. "Headquarters/Factory Address"), `-`/`—` treated as empty, recognized secondary columns (Office, Alt office, Landline) folded into notes, and a tap-to-expand profile box on each supplier card with clickable email/website links. Supplier cards show region in the summary line.
- **Step 13** — Authentication: users get a `password_hash` column (scrypt, `node:crypto`), and the app server requires a signed HttpOnly session cookie (HMAC, secret stored in `settings`) for every `/api/*` route except `/api/auth/*`. First visit with no credentialed user shows a create-admin setup screen; after that, a sign-in screen. `/api/users` and `/api/admin/*` additionally require the `ADMIN` role; user API responses never include password hashes. The sync server accepts `TRIPTRACK_BIND` (set to `127.0.0.1` in deployment) so its unauthenticated push/pull API is only reachable from the host itself. Endpoints: `/api/auth/status`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`.
- **Step 12** — UX redesign informed by field-app research: a Today home view (date header, stat tiles for visits today / trip visits / suppliers / sample follow-ups, today's visit list with map links, tap-through to the schedule), live supplier search + region filter with result counts, all entry forms collapsed behind "+ Add"/"Import" toggles, prev/next day arrows on the schedule, bottom tab navigation with icons on phone widths (thumb zone), auto-refreshing sync status, and empty-state hints throughout. New endpoint: `GET /api/samples/follow-ups`.
- **Step 14** — Supplier priorities and trip shortlists: suppliers get `priority` (`MUST`/`MAYBE`/`SKIP`, default `MAYBE`, validated → HTTP 400) and a one-line `skip_reason`, both added via `COLUMN_MIGRATIONS`. A new synced `trip_suppliers` table holds each trip's shortlist (adding a pair twice reuses or revives the existing row). Suppliers are returned with a computed `visited` / `last_visit_date` (any non-deleted DONE visit). Suppliers and Map tabs share persisted filter chips (Must, Maybe, Hide visited, Hide skipped, Only this trip's shortlist); map pins are colored by priority (red Must, orange Maybe, grey visited) and clustered with vendored `leaflet.markercluster` 1.5.3. The visit picker lists the shortlist first and hides Skip suppliers unless "Show all" is ticked; trips show their shortlist count. Endpoints: `GET /api/suppliers?priority=MUST,MAYBE&hide_skipped=1&hide_visited=1&trip_id=…`, `GET /api/trips/:id/suppliers`, `POST /api/trip-suppliers`, `DELETE /api/trip-suppliers/:id`, `DELETE /api/trips/:tripId/suppliers/:supplierId`.
