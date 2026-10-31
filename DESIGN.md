# Design choices and migration history

See the [README](README.md) for installation, configuration, roster imports,
validation commands and event operations.

## Scope and architecture

The planning specification remains in the event repository at
`Norwegian-FHIR-hackathon-2026/planlegging/registreringsapp.md`.
All application and application-specific FHIR sources live here.

The application uses a React/TypeScript frontend, a Fastify backend and a local
Blaze FHIR R4 server. Blaze is the only container; its standalone RocksDB storage
needs no separate database, cache or administration application. Browsers talk
only to the check-in backend. Blaze is unauthenticated and restricted to
loopback.

All dashboard data comes from FHIR. There is no production memory fallback or
automatic success response when persistence is unavailable. Tests use a
test-only versioned in-memory FHIR adapter.

## Storage and transactions

Blaze stores data at `/app/data`, bind-mounted to `BLAZE_DATA_DIR` on the host.
Database files remain outside Docker images, container layers and named volumes
and can be backed up with ordinary file tools while Blaze is stopped.
Blaze creates its `index`, `transaction`, `resource` and admin subdirectories on
first start.

Docker Desktop shares Windows paths into the WSL 2 VM, which is slower than a
Docker volume for RocksDB. Expected event load is a few hundred attendees.
For better I/O while keeping files outside Docker, operators can use a WSL ext4
path such as `\\wsl$\Ubuntu\home\<user>\blaze-data`, create it inside WSL and
assign ownership to UID/GID 1001. Include that directory in backups.

The backend creates new resources with conditional POSTs (`ifNoneExist` on the
stable identifier) and transaction-local `urn:uuid` references; Blaze assigns
resource IDs. Stable identifiers provide idempotency. Existing resources are
updated with `If-Match`; the entire check-in transaction is retried after version
conflicts (HTTP 409/412). Blaze executes transactions atomically and serially.
Referential integrity requires references to existing resources or entries in
the same transaction.

List names in the planning specification are logical identifiers, not literal
Blaze resource IDs. Search pagination is followed; List entries are read as a
whole. Blaze uses `BASE_URL` for absolute paging links, and the backend rejects
paging links outside `FHIR_BASE_URL`.

## FHIR model and validation

The IG title and package ID are `hackathon-check-in-app`, with
canonical URL `https://hl7.no/fhir/ig/hackathon-check-in-app`.
Its FHIR machine-readable name is `HackathonCheckInApp`.
The repository, npm package and Compose project are also named
`hackathon-check-in-app`. The app and IG release version is `0.7.0`.

* Persons represent expected participants and use the event participant
  identifier system.
* Practitioners represent actual arrivals, share the participant identifier,
  and are linked from their Person.
* Roster/staff Lists reference Persons and carry expected event-role flags.
* The check-in List references Practitioners and records arrival dates.
* Event-role `qualification.code` is **not a professional credential**.
* Receipts read registered details and role from the saved Practitioner and the
  original timestamp from its check-in List entry.

Corrections update linked resources and roster roles transactionally and create
AuditEvents. Manual registration creates a Person, Practitioner, marked check-in
entry and audit atomically without adding to either expected roster.
Single-participant roster additions and removals (`server/roster.ts`) update one
roster List entry plus, for new people, a Person, in one transaction with an
AuditEvent. They reuse the import's stable-ID generation and duplicate/role
rules so that later complete CSV imports recognize the same Person, and they
never overwrite details confirmed at check-in.

The app uses typed resource builders and runtime input validation. Full profile
conformance is checked against the generated package, not assumed from
`meta.profile`. Validation runs locally with external terminology lookups
disabled. Fixtures include synthetic runtime output for check-in, manual
registration and audit, in addition to FSH examples.

Synthetic examples cover all tracks and no selected track, linked checked-in
attendees and an attendee-roster List. These are IG examples, not live seeds.
The bundled public agenda staff roster is separate from synthetic examples and
excluded from the IG package. It is not fetched from GitHub at runtime.

The agenda generator imports only named people from grouped rows, uses mailto
targets for contact addresses, and warns about grouped names or differing
displayed addresses. Review generated warnings and correct the master agenda
before regenerating; unnamed team members require organizer-provided details
or manual registration.

## Receipt design

Receipts are displayed only after a successful transaction and readback of the
saved check-in. The stable receipt reference is the server-assigned Practitioner
ID. Duplicate submissions return saved details and the original arrival time,
not the newly submitted draft or current time.

QR generation uses `qrcode.react` (ISC license) locally, without an external
service, API key, font, CDN or internet request. It renders a black-on-white SVG
with a four-module quiet zone and at least medium error correction. The payload
is an RFC 6068 `mailto:` URI, because phone cameras (notably iOS) only offer an
action for recognised payload types and ignore plain text. It is addressed to
the participant's registered email with the subject "Norwegian FHIR Hackathon
2026 check-in confirmation" and a percent-encoded body containing the participant
name, primary-track code, original arrival time and receipt reference. No URL to
the check-in server or FHIR JSON is embedded, so phones never contact the
check-in server. Event date/location, affiliation, role and
the participation-duration disclaimer remain on screen only to reduce QR
density without removing full receipt details from the UI.

The development-only dependency `jsqr` (Apache-2.0) decodes rendered QR codes in
tests to verify exact `mailto:` URI round trips, including maximum-length and Unicode
fields. It is not bundled into the application.

If rendering fails, the persisted check-in remains valid and readable details,
an explicit error and a retry button remain available. Persistence or retrieval
failures never produce fabricated confirmation.

Tests also cover imports, single roster additions/removals, matching thresholds, roles, linked resources,
duplicate/concurrent arrivals, manual audit, API authorization, track changes,
transaction failure, persisted receipts and Blaze request shapes.

## Legacy deployment upgrades

These steps apply only to deployments running older versions. For a new
installation, follow the [README setup instructions](README.md#windows-setup).

### Upgrading to 0.6.0

The app and FHIR IG now use `hackathon-check-in-app`. This release changes the
FHIR canonical namespace, including profile URLs, extensions, terminology and
identifier systems. Existing Blaze resources are not migrated automatically;
the new app will not find old rosters or check-ins by their previous identifiers.

Before upgrading, stop the app and stop Blaze with `docker compose stop` using
the old Compose project configuration. The renamed Compose project otherwise
creates a separate container that can conflict on port 8090 or the same Blaze
data directory. Back up `BLAZE_DATA_DIR` while Blaze is stopped.

If existing attendance must be retained, migrate the old app-specific canonical
URLs in the saved resources to the new namespace and validate the migrated data
before restarting the app. Do not mix old and new namespaces in a live database.
For a rehearsal with no attendance to retain, use a new Blaze data directory and
reimport the reviewed rosters instead; keep the backup.

Rebuild the FHIR definitions and package from clean generated output so the
previously named ImplementationGuide and old canonical resources are not retained.

### Replacing emailed receipts

Stop the old application before upgrading. Email sending, provider
configuration, retry routes, status columns and email Task creation have been
removed. Remove obsolete `BREVO_*` settings from the private `.env` and revoke
unused provider credentials. The attendee email field remains registered
contact data.

Existing FHIR email Tasks are left untouched for retention/audit review; the app
neither reads nor processes them. Existing check-ins need no Tasks to reopen a
receipt. This receipt change does not migrate or delete attendance data or local
FHIR storage.

Rebuild the FHIR definitions/package in a clean generated-output directory so
obsolete email profiles, extensions, terminology and examples are not retained.

### Migrating from Medplum to Blaze

Earlier versions stored data in Medplum (PostgreSQL/Redis Docker volumes). The
app now talks only to Blaze; data is **not** migrated automatically and a new
Blaze database starts empty.

1. Stop the old application and run `docker compose stop` with the *old*
   `compose.yaml` before upgrading. Do not run `docker compose down -v`;
   keep the old volumes until retention/deletion is approved.
2. Remove `MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET`,
   `POSTGRES_PASSWORD` and `REDIS_PASSWORD` from the private `.env`, and add
   `FHIR_BASE_URL` and `BLAZE_DATA_DIR` as in `.env.example`.
3. Create the Blaze data directory, start Blaze and the app using the
   [README instructions](README.md#start-the-blaze-fhir-server).
   The staff roster is preloaded on first start; reimport reviewed attendee CSVs.
4. If existing Medplum check-ins must be carried over, export Person,
   Practitioner, List and AuditEvent resources as a FHIR transaction Bundle
   with references rewritten to `urn:uuid` entries, and POST it to
   `http://localhost:8090/fhir` before admitting attendees. Rehearse this on a
   test Blaze directory first.

For deployments with no recorded attendance to retain, use a clean start and
reimport the reviewed rosters.
