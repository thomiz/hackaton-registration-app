# Design choices and migration history

See the [README](README.md) for installation, configuration, roster imports,
validation commands and event operations.

## Scope and architecture

The planning specification remains in the event repository at
`Norwegian-FHIR-hackathon-2026/planlegging/registreringsapp.md`.
All application and application-specific FHIR sources live here.

The application uses a React/TypeScript frontend and a Fastify backend that
stores FHIR R4 resources in a local JSON file. There is no separate database,
FHIR server, container or administration application. Browsers talk only to
the check-in backend. The server and command-line tools are compiled with
`tsc` (`tsconfig.server.json`, Node module resolution) into `dist-server` and
run with plain Node.js 22+; `tsx` is used only for development and the FHIR IG
tooling.

All dashboard data comes from the stored FHIR resources. There is no automatic
success response when persistence fails.

## Storage and transactions

`server/file-store.ts` implements the same small `FhirStore` interface
(read, search, transaction) that earlier versions implemented against Blaze.
All resources are held in memory and saved as one FHIR `collection` Bundle in
`DATA_DIR/fhir-store.json`. Expected event load is a few hundred participants,
so the whole file (well under a few MB) is rewritten for each transaction.

* **Atomicity and durability.** A transaction is validated against an in-memory
  copy, written to a temporary file, flushed to disk and renamed over the
  previous snapshot before it becomes visible. A crash leaves the old or the
  new file, never a mix. Renames are retried briefly when Windows antivirus or
  indexing tools hold the file.
* **Concurrency.** Node handles requests on one thread; transactions are queued
  so each one sees the result of the previous one. Updates carry `If-Match`
  versions and the registration service retries the whole operation after a
  version conflict, so simultaneous arrivals are never lost. Creates use
  conditional `ifNoneExist` on the stable identifier, which makes repeated
  submissions idempotent. Deletes are refused while other resources still
  reference the target.
* **Single writer.** `fhir-store.lock` (with the owner PID) prevents a second
  app or maintenance command from opening the same data. A lock whose process
  no longer exists is replaced automatically.
* **Maintenance batches.** Operations CLI changes (reset, imports, and both
  combined) run as a batch that is written once at the end or discarded
  entirely, so no maintenance journal is needed.
* **Reads and backups.** Search and the dashboard read memory. Because the file
  is only ever replaced atomically, it can be copied or read by `ops status`
  and `ops backup` while the app runs.

Resource history is not kept; the current versions, AuditEvents and backups
form the record. The stored resources are unchanged from the Blaze-based
versions, so the file can be loaded into any FHIR server if needed.
## FHIR model and validation

The IG title and package ID are `hackathon-check-in-app`, with
canonical URL `https://hl7.no/fhir/ig/hackathon-check-in-app`.
Its FHIR machine-readable name is `HackathonCheckInApp`.
The repository and npm package are also named
`hackathon-check-in-app`. The app version is `0.8.0`; the IG release version
is `0.7.0` (its FHIR definitions did not change in 0.8.0).

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
transaction failure, persisted receipts, the JSON file store (atomic writes,
locking, concurrent writers, batches) and the operations CLI.

## Legacy deployment upgrades

These steps apply only to deployments running older versions. For a new
installation, follow the [README setup instructions](README.md#windows-setup).

### Replacing Blaze with the JSON data file (0.8.0)

Versions before 0.8.0 used a Blaze FHIR server in Docker. Stop the app,
then either run `npm.cmd run migrate:blaze` while the old Blaze container is
still running (see the [README](README.md#migrating-from-an-earlier-blaze-installation)),
or start with an empty `DATA_DIR` and reimport the reviewed rosters. Then
remove `FHIR_BASE_URL` and `BLAZE_DATA_DIR` from `.env` (they are ignored),
stop the Blaze container with `docker compose stop` from the previous
checkout, and keep its data directory as an archive until retention ends.
The ops `stop` command, maintenance journal and cold Blaze backups no longer
exist: stop the app with Ctrl+C, and use `ops backup`.

### Upgrading to 0.6.0

The app and FHIR IG now use `hackathon-check-in-app`. This release changes the
FHIR canonical namespace, including profile URLs, extensions, terminology and
identifier systems. Existing resources are not migrated automatically;
the new app will not find old rosters or check-ins by their previous identifiers.

Before upgrading, stop the app and back up the data used by the old version.

If existing attendance must be retained, migrate the old app-specific canonical
URLs in the saved resources to the new namespace and validate the migrated data
before restarting the app. Do not mix old and new namespaces in a live database.
For a rehearsal with no attendance to retain, use a new, empty data directory and
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

### Migrating from Medplum

Even earlier versions stored data in Medplum (PostgreSQL/Redis Docker volumes).
Data is **not** migrated automatically. Stop the old application and its
Compose services (do not run `docker compose down -v`; keep the volumes until
retention/deletion is approved), remove the `MEDPLUM_*`, `POSTGRES_PASSWORD`
and `REDIS_PASSWORD` settings from `.env`, start this version with an empty
`DATA_DIR` and reimport the reviewed rosters. The staff roster is preloaded on
first start.