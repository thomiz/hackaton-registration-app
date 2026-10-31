# Operations guide

Use this guide after initial installation. For full setup and configuration,
see the [README](README.md).

Run commands in PowerShell from the application folder. For this PC:

```powershell
Set-Location 'C:\GitRepo\hackathon-check-in-app'
```

Use your actual installation path if different. Run each numbered step
separately. **If a command fails, stop and resolve the error before continuing.**
Never delete the Blaze data directory to fix a startup or import error.

## Operations CLI (recommended)

The local operations tool combines startup, shutdown, status, verified backups,
import previews and attendance resets. It is a command-line tool, not a web
console or Windows service. Run it on the registration PC with Windows,
Node.js 18.17+ and Docker Desktop using a **local Linux-container engine**.
It supports the installed Compose 2.4 generation without requiring
`--wait-timeout`.

Complete the [initial installation](README.md#windows-setup) first. Configure
`.env` using `npm.cmd run configure` if it does not exist; keep existing
credentials when updating an installation. Set `BLAZE_DATA_DIR` explicitly
to the existing database directory. The tool resolves Compose paths relative
to the checkout, checks the actual container mount and loopback endpoint,
and **never creates a missing database directory** or silently selects a new
one. It does not install dependencies, rebuild, rotate passwords or import
rosters during ordinary startup. The existing first-start staff preload still
applies when the staff List is empty.

If an existing Blaze container points to a different directory or endpoint,
the tool refuses to replace or stop it implicitly. Reconcile the configuration
with the intended existing database before proceeding; use the documented
backup/migration procedure for an intentional storage change.

```powershell
npm.cmd run ops -- help
```

| Command | Behavior |
|---|---|
| `npm.cmd run ops -- start` | Starts Blaze, waits for health, then runs the built app in this terminal. |
| `npm.cmd run ops -- start --blaze-only` | Starts only Blaze, for maintenance or recovery. |
| `npm.cmd run ops -- status` | Reports health, managed/manual app ownership, disk space, last verified backup, aggregate attendance and track totals. |
| `npm.cmd run --silent ops -- status --json` | The same one-shot status as JSON; suppresses npm's banner for machine-readable output. No names, emails, credentials or control tokens. |
| `npm.cmd run ops -- stop --app-only` | Gracefully stops an ops-managed app; leaves Blaze running for maintenance. |
| `npm.cmd run ops -- stop` | Gracefully stops the ops-managed app, then stops Blaze. |
| `npm.cmd run ops -- backup --backup-dir 'D:\private\hackathon-backups'` | Makes and verifies a new cold backup; the app must already be stopped. |
| `npm.cmd run ops -- import --attendees 'D:\private\reviewed-attendees.csv'` | **Read-only preview** of replacing the attendee roster. |
| `npm.cmd run ops -- import --staff 'D:\private\reviewed-staff.csv'` | **Read-only preview** of replacing the staff/track-lead-and-partner roster. |
| `npm.cmd run ops -- reset` | **Read-only preview** of resetting attendance, including leftover event Practitioners from an interrupted reset. |

Commands return a nonzero exit code on failure. `status` also returns nonzero
when the app or Blaze is unavailable, or maintenance is unfinished. That is
expected while the app is deliberately stopped; it is not permission to
discard the database. Status is a snapshot, not a background monitoring service.

### Backup destination and verification

Create a private backup parent directory once, on an access-restricted,
preferably encrypted disk **outside both the checkout and the database**:

```powershell
New-Item -ItemType Directory -Force 'D:\private\hackathon-backups'
```

Choose your actual backup disk; a separate disk also protects against loss of
the database disk. Restrict its NTFS permissions to event operators. The tool
does not set Windows ACLs, encrypt backups or delete old backups automatically.

For a standalone backup, stop the app first, then run:

```powershell
npm.cmd run ops -- stop --app-only
npm.cmd run ops -- backup --backup-dir 'D:\private\hackathon-backups'
```

The tool checks the configured container/mount, stops Blaze, uses `robocopy`
without `/MIR`, and compares the SHA-256 digest and size of every source and
copied file. It checks the source again to detect changes during the copy.
Only after verification does it write `backup.json` in a new timestamped
backup directory. Database files are in that directory's **`blaze` subfolder**.
It restarts the same container if it was previously running; otherwise it
leaves Blaze stopped. The app always remains stopped.

If copying or verification fails, the tool does not restart Blaze or mark the
copy as verified. Resolve the error and take another backup. If the copy
verified but restarting Blaze failed, the error identifies the usable backup.
The backup does **not** contain `.env`; keep that file separately and securely.
Restore using the [approved recovery procedure](README.md#backup-and-restore-of-the-host-data-directory),
copying from the backup's `blaze` subfolder, not from its parent.

### Preview, confirmation and recovery rules

* `import` and `reset` default to previews; `--dry-run` makes that explicit.
  Previews do not initialize missing event Lists or modify FHIR resources,
  configuration, seed files or backups. Start the app once after a new
  installation to initialize its Lists, then stop it before maintenance.
* To apply, repeat the command with **`--apply --backup-dir <directory>`**.
  The tool shows the target database, counts and an exact confirmation phrase.
  Type that phrase when prompted. Any other input cancels without a backup or
  database write. For noninteractive use, pass `--confirm '<exact phrase>'`;
  there is no generic `--yes` bypass.
* Every apply takes a **fresh verified cold backup**, even if a recent backup
  exists. It rechecks the preview after backup before making changes.
  Imports require the complete selected roster(s), not a file of differences.
* Applying requires a stopped app. A local database lock prevents concurrent
  startup and CLI maintenance; it also covers the normal `npm run start`,
  development backend, and existing import/reset CLI entry points. Unknown
  listeners on the configured app port block maintenance too. An app started
  manually must be stopped with **Ctrl+C**; the tool never kills unrelated
  processes by name or by a saved PID.
* Stop other installations, older versions and external FHIR writers yourself.
  This is coordination for this toolchain, **not an access lock inside Blaze**.
  Use the same checkout/operator account for recovery. Never run two Blaze
  containers against the same directory.
* Runtime control tokens, the last-backup record and an unfinished-operation
  journal are kept under the Git-ignored `data\ops` directory. Protect it along
  with `.env`. An interrupted reset/import blocks both normal and ops app
  startup. **Do not remove the journal to bypass the block.** Keep the original
  reviewed input files and backup; retry the same ops operation with the same
  inputs, review its new counts and confirm again. If needed, use
  `start --blaze-only` to bring Blaze back for recovery.
* A combined reset/import is **not one atomic operation**: reset requires two
  FHIR transactions, followed by the roster import transaction. Errors leave
  the app stopped and identify the failed stage and original backup.
  No automatic rollback or restart of registration is attempted. If the
  original inputs are unavailable or the failure persists, have the maintainer
  investigate or follow the approved restore procedure.

## 1. Start the program after installation and testing

### What must already be done

Before first real use, confirm:

* Git, Node.js/npm and Docker Desktop are installed; Docker uses Linux containers.
* Dependencies are installed and `npm.cmd test` and `npm.cmd run build` passed.
* `.env` is configured, including the staff login, application URL, FHIR URL
  and Blaze data location. Keep this file private.
* The Blaze data directory exists and is accessible. Keep the same directory
  when restarting; do not substitute a new empty one.
* The latest reviewed attendee CSV has been imported, and the staff roster
  has been checked. Staff are preloaded only when the staff List is empty.
* Check-in, receipts, staff access, and backup/restore have been rehearsed.
  The privacy notice and workstation/network settings are ready for event use.

These are preparation tasks, **not tasks to repeat on every startup**.
See the [event checklist](README.md#verification-and-event-operation).

### Normal startup

1. Open **Docker Desktop** and wait until its engine is running.
2. Open PowerShell, go to the application folder, and start the services:

   ```powershell
   npm.cmd run ops -- start
   ```

   The command verifies configuration and the existing data directory, waits
   for Blaze and checks application health before printing `Check-in app ready`.
   Startup does not recreate rosters or attendance. If it fails, registration
   remains unavailable; inspect the reported error rather than switching data
   directories.

3. **Leave this PowerShell window open.** It runs the app; it is not a
   background service. Docker Desktop alone does not start the check-in app.
4. In a **second PowerShell window**, check readiness:

   ```powershell
   npm.cmd run ops -- status
   ```

   Expect `Overall: READY`. Open `http://localhost:8080` in the browser, sign in
   through **Staff access**, and check the roster counts.

The addresses above are the default workstation configuration. If you configured
a different application address, use it for the browser and application health
check. Keep Blaze accessible only on loopback.

**No rebuild or CSV reimport is needed for an ordinary restart.** Rosters and
check-ins remain in the existing Blaze database. The manual alternative remains
`docker compose up -d`, wait for Blaze health, then `npm.cmd run start`;
see the [README](README.md#start-and-check). Do not use the development servers
for event operation.

### Normal shutdown

1. Finish the current registration.
2. From a second PowerShell window, run:

   ```powershell
   npm.cmd run ops -- stop
   ```

   This drains app requests before stopping Blaze. Use `--app-only` to leave
   Blaze running for maintenance. **Ctrl+C** in the startup window also stops
   only the app. For an app started with the old `npm.cmd run start`, press
   Ctrl+C first, then use `ops stop` to stop Blaze.

Stopping does not erase the database. Take a
[verified backup](#backup-destination-and-verification) at agreed intervals and
before maintenance.

## 2. When the attendee list or staff roster changes

**Editing a source file does not update the database. You must import it.**
Keep Blaze running. Previews can run while the app is open, but schedule applying
changes when nobody is checking in. The ops apply workflow below requires the
app to be stopped and takes its own fresh backup.

### Single last-minute changes from the dashboard

For one person at a time (a late sign-up, a cancellation, or a staff member who
also signed up as an attendee), use the staff dashboard instead of a reimport.
The app can stay running and nobody else is affected.

* **Add someone:** open **Staff access**, fill in the *Manual registration or
  late sign-up* form (name, email, affiliation, track, verified role, reason),
  choose the list under **Add to list without check-in** and press **Add to
  attendee list** (or **staff list**). This does **not** check the person in;
  they check in from the attendee page like everyone else. If the person
  already exists in the other list, the existing record is reused and the roles
  must agree.
* **Remove someone:** search for the person in the staff search (or press
  **Correct details** in the arrivals table), enter a reason and press
  **Remove from attendee list** or **Remove from staff list** under *Roster
  membership*. Only that list entry is removed: the person, any recorded
  check-in, receipt and export rows are kept, exactly as if the latest CSV no
  longer contained the row. Someone removed from both lists can no longer use
  roster-based check-in.

Both actions are recorded as AuditEvents with the staff username and reason,
and the roster totals update immediately. **Afterwards, update the reviewed
CSV sources to match**: the next complete import of a list replaces it with
exactly the CSV rows, so a dashboard-only addition disappears again unless the
CSV includes that person (use the same name and affiliation, or the generated
`id`), and a dashboard-only removal is undone if the CSV still lists them.

### Attendee list changes

1. Export the latest Google Forms attendee CSV. Save it in a private location,
   for example `D:\private\reviewed-attendees.csv`. Use the **complete latest
   list**, not only new or changed rows: each import replaces the attendee list.
2. Review changed people before importing:
   * Missing IDs are generated from name and affiliation. Repeat imports retain
     identity if those fields are unchanged.
   * If correcting a name or affiliation, supply the person's previous `id`
     rather than generating a new one.
   * For a person also in the staff roster, supply the same `id` and event
     `role` as the staff CSV. The import rejects ambiguous overlaps.
3. Preview the reviewed file and check additions, removals and updates:

   ```powershell
   npm.cmd run ops -- import --attendees 'D:\private\reviewed-attendees.csv'
   ```

4. Stop the app, then apply and type the displayed confirmation phrase:

   ```powershell
   npm.cmd run ops -- stop --app-only
   npm.cmd run ops -- import --attendees 'C:\hackathon-data\attendees.csv' --apply --backup-dir 'C:\hackathon-data\hackathon-backups'
   ```

   Expect `Maintenance verified (import)`. The tool replaces only the selected
   list and preserves attendance. If validation fails, correct the CSV and
   preview again; the import transaction is atomic.
5. Run `npm.cmd run ops -- start`, sign in to the staff dashboard and check the
   expected roster count and changes.
   The reported import count is the number of input rows, not the number of
   newly added people. People absent from the CSV are removed from the attendee
   list. An import does not check anyone in.

You can still paste the CSV into **Import reviewed roster CSV** on the staff
page with **Google Sheet attendees** selected, or use the existing
`npm.cmd run import -- roster 'D:\private\reviewed-attendees.csv'` command.
These alternatives do **not** perform the ops preview/confirmation/backup
workflow; take a backup separately and schedule changes at a quiet moment.
See [CSV format and ID rules](README.md#google-sheet-attendees-and-optional-staff-updates).

### Staff roster changes

1. Update or obtain the latest event agenda Markdown file. Its **Track leads
   and partners** table is the master source.
2. Generate the local staff files, substituting your actual agenda path:

   ```powershell
   npm.cmd run staff:generate -- 'D:\path\to\hack-agenda.md'
   ```

3. Review the generation warnings and `seed\staff.csv`. If someone was renamed,
   reconcile their existing participant ID before importing. Track-associated
   people are `track-lead`; Partner rows are `attendee`.
4. Preview the complete generated roster, then stop the app and apply:

   ```powershell
   npm.cmd run ops -- import --staff '.\seed\staff.csv'
   npm.cmd run ops -- stop --app-only
   npm.cmd run ops -- import --staff '.\seed\staff.csv' --apply --backup-dir 'D:\private\hackathon-backups'
   ```

5. Run `npm.cmd run ops -- start`, then check dashboard counts and changes.

**Restarting the app does not refresh an existing staff roster.** Generation
and import are separate steps. If you receive an already reviewed staff CSV
instead, use `--staff 'D:\private\reviewed-staff.csv'` in the preview and apply
commands above.

Alternatively, `--agenda 'D:\path\to\hack-agenda.md'` can be used instead of
`--staff`. It parses the agenda in memory without changing the bundled seed
files. Review warnings block applying directly from the agenda: generate the
staff files privately, review them and import the reviewed CSV instead.
Input files inside the checkout generate a warning; never commit private
attendee exports.

### Update both rosters together

Supply both complete CSVs to one command:

```powershell
npm.cmd run ops -- import --attendees 'D:\private\reviewed-attendees.csv' --staff 'D:\private\reviewed-staff.csv'
npm.cmd run ops -- stop --app-only
npm.cmd run ops -- import --attendees 'D:\private\reviewed-attendees.csv' --staff 'D:\private\reviewed-staff.csv' --apply --backup-dir 'D:\private\hackathon-backups'
```

Both Lists and their Person updates are committed in **one FHIR transaction**.
For someone in both input files, use matching stable IDs, roles and details.
This permits a coordinated roster-role change for a person who has not checked
in. Already confirmed roles still require an audited correction, or an explicit
reset when starting a new attendance run.

### Removals, role changes and already checked-in people

* **Each import replaces only the selected list.** Removing a CSV row and
  importing the complete updated file removes that person from that list.
  The active roster/search combines the attendee and staff lists: someone
  present in either remains eligible. Import both latest CSVs when both change.
  Empty/header-only CSVs are rejected; failed imports leave the old list intact.
* Removal from both lists prevents further roster-based selection/check-in,
  including with an earlier selection token. Existing Person resources,
  confirmed attendance, receipts and exports are preserved. A removed person
  who already checked in still appears in attendance history. Do not delete the
  database or attendance history to remove someone from the active roster.
* Imports preserve already confirmed check-in details. Use the staff correction
  workflow for a checked-in person's details or event role, then align source
  files with that correction.
* A conflicting role across rosters must be reconciled before importing.
  Do not bypass the error by giving the same person a different ID.

## 3. When server, client, scripts or dependencies are updated

Plan a maintenance window: check-in will be unavailable during this procedure.
Keep the previous known-working application version and a database backup.

When upgrading to 0.6.0, first follow the
[namespace and Compose migration guidance](DESIGN.md#upgrading-to-060).

The check-in app runs directly on Windows; Docker runs only the Blaze FHIR
server. Changes in `server/`, `src/`, `shared/` or `scripts/` do **not** require
building or recreating a Docker image. Follow the app test, build and restart
steps below. Blaze needs updating only in the cases listed in step 8.

1. Finish active check-ins and stop the app with **Ctrl+C**.
2. Take a [database backup](README.md#backup-and-restore-of-the-host-data-directory).
   Keep `.env` securely for recovery too.
3. Obtain the reviewed application update using your normal Git or release-copy
   process. Preserve `.env`, private CSVs and the Blaze data directory.
   Do not overwrite uncommitted local work.
4. If `package.json` or `package-lock.json` changed, restore the locked dependencies:

   ```powershell
   npm.cmd ci
   ```

5. Run the tests:

   ```powershell
   npm.cmd test
   ```

6. Build the application:

   ```powershell
   npm.cmd run build
   ```

   This checks TypeScript and rebuilds the browser files. **Restarting alone
   does not rebuild the client.** Server code and CLI scripts run from source;
   restart the server and use the updated scripts for subsequent commands.

7. Apply any additional steps relevant to the update:

   | What else changed? | Required action |
   |---|---|
   | FHIR definitions or packaging/validation scripts | Follow the [FHIR build and validation instructions](README.md#fhir-data-and-validation) before reopening registration. |
   | Agenda source or bundled staff files | Generate if needed, then explicitly import staff as described above. |
   | Attendee CSV | Import the reviewed attendee file as described above. |
   | `.env.example` or configuration requirements | Review new settings and update the private `.env`; do not replace it with the example. |

8. **Update Blaze only if `compose.yaml` changed.** Blaze is configured
   entirely by `compose.yaml` plus `BLAZE_DATA_DIR` in `.env`. Check
   whether the update changed `compose.yaml`, replacing `<previous-version>`
   with the commit or tag you were running:

   ```powershell
   git --no-pager diff --stat <previous-version> HEAD -- compose.yaml
   ```

   No output means Blaze is unchanged: leave the container running and
   continue to step 9. Otherwise, update Blaze before restarting the app.
   Changes requiring this include:

   * a new pinned `image:` tag (a Blaze version upgrade);
   * Blaze `environment:` settings, such as memory or cache sizes;
   * `ports`, `volumes`, `healthcheck`, `restart` or `stop_grace_period`.
     If the published port changes, update `FHIR_BASE_URL` in `.env` to match.

   Blaze is **not** updated automatically when Samply publishes a new release.
   The version changes only when a reviewed update edits the `image:` tag.
   Changes in `server/`, `src/`, `shared/`, `scripts/`, FHIR definitions,
   rosters, `package.json` or app-only `.env` settings never require a Blaze
   update. App-only settings include `HOST`, `PORT`, `PUBLIC_URL`,
   `FHIR_BASE_URL`, secrets and staff login. Do not change `BLAZE_DATA_DIR`
   during an upgrade: it must keep pointing at the existing database.

   Apply the update explicitly here instead of letting `npm.cmd run ops -- start`
   apply it. That command runs `docker compose up -d blaze`. Compose silently
   recreates the container with a changed image or environment, and downloads
   the image if needed. The command refuses to start only if the existing
   container's port or database mount no longer matches `compose.yaml`.
   Read the release notes for any Blaze version upgrade before
   applying it, because Blaze can migrate the database. Older Blaze versions
   may not be able to read the migrated database, so keep the backup from step 2.
   Apply the update:

   ```powershell
   docker compose pull
   docker compose up -d
   docker compose ps
   Invoke-RestMethod 'http://localhost:8090/health'
   ```

   Wait for Blaze to be healthy before continuing. Compose downloads the pinned
   image and recreates the container if needed; there is no local Docker image
   to build with `docker compose build`.

9. Follow [Normal startup](#normal-startup), then reload the browser so it loads
   the new client. If it still shows the old UI, use **Ctrl+F5**.
10. Check application health, staff login, dashboard counts and the changed
   functionality. Rehearse actual check-in changes on a separate test database,
   not by creating fictitious attendance in the live event database.

If tests, builds or startup fail, keep registration closed and investigate.
Do not switch to an empty database or assume an older app can safely read a
database changed by an upgrade. Restore only through the approved recovery
procedure. Legacy Medplum and email-receipt upgrades have
[separate migration guidance](DESIGN.md#legacy-deployment-upgrades).

## 4. Start check-ins again (reset all attendance)

Use this after a rehearsal or when an authorized organizer decides to restart
attendance collection. **This resets every check-in for this app's event,
not just a selected person.** It does not reset roster counts or restore
original CSV details.

The reset command:

* Empties the check-in List and removes event Practitioner check-in records.
* Removes links from Persons to those deleted check-in records, allowing
  roster members to check in again with a new arrival time and receipt.
* Preserves attendee and staff Lists, participant IDs, and the latest saved
  names, emails, affiliations and tracks, including check-in corrections.
* Preserves Persons created through manual registration and existing AuditEvents.
  Unrelated Practitioner records are not deleted.

**This is an operational reset, not secure erasure of personal data.** FHIR
resource history, audit records, backups, and previously saved receipt copies
can still contain earlier attendance information. Old receipts cannot be
reopened in the app after reset.

### Guarded reset procedure

1. Confirm approval and stop all check-in activity. Export the arrivals CSV
   from the staff dashboard if you need a readable record of the previous run.
2. Stop the app but keep Blaze running:

   ```powershell
   npm.cmd run ops -- stop --app-only
   ```

   For a manually started app, use Ctrl+C instead. Stop any other app instance,
   development server or external import process using this database.
   **Keep the app stopped until verification is complete.**
3. Preview the reset:

   ```powershell
   npm.cmd run ops -- reset
   ```

   Check the target database, check-in count and event Practitioner count.
   The latter can be nonzero after a partially completed reset even when the
   dashboard shows zero arrivals.
4. Apply and type the exact phrase shown in the preview:

   ```powershell
   npm.cmd run ops -- reset --apply --backup-dir 'D:\private\hackathon-backups'
   ```

   This takes and verifies a fresh cold backup first. Reset then uses two FHIR
   transactions: remove Person links and clear the check-in List, then delete
   event Practitioners. Blaze checks delete references against the database
   before each transaction, so these steps cannot be combined. Finally it
   verifies zero active check-ins, zero event Practitioners and unchanged
   roster Lists. Expect `Maintenance verified (reset)`.

   If it reports an error, **do not reopen registration**. A transport error
   can mean the write outcome is uncertain. Follow the
   [recovery rules](#preview-confirmation-and-recovery-rules), keeping the app
   stopped and retrying the same ops command. A completed reset can safely be
   repeated, but zero dashboard arrivals alone do not prove completion.
   Inconsistent references must be repaired before resetting. A conflict with
   diagnostics saying `Referential integrity violated` is not a version conflict;
   if it persists with the two-stage reset, have the maintainer inspect additional
   references rather than disabling referential-integrity checks.

5. Follow [Normal startup](#normal-startup). Reload the browser to discard old
   selections and receipts, sign in, and refresh the dashboard.
6. Verify:
   * Checked-in, attendee-arrival, track-lead-arrival and manual-arrival totals
     are zero; the arrivals table is empty.
   * Attendee and staff roster counts are unchanged.
   * Expected roster members appear as not yet checked in.

### Reset and import updated rosters in the same maintenance window

After stopping the app, preview the combined operation, then apply:

```powershell
npm.cmd run ops -- import --reset-checkins --attendees 'D:\private\reviewed-attendees.csv' --staff 'D:\private\reviewed-staff.csv'
npm.cmd run ops -- import --reset-checkins --attendees 'D:\private\reviewed-attendees.csv' --staff 'D:\private\reviewed-staff.csv' --apply --backup-dir 'D:\private\hackathon-backups'
```

Omit either roster flag to leave that roster unchanged. The tool validates the
proposed post-reset imports **before** resetting anything, confirms the counts,
takes a fresh backup, resets attendance, and imports the selected roster(s).
This allows reviewed details/roles to be applied for the new run instead of
preserving the preceding run's confirmed details. Shared IDs in both supplied
rosters must agree. Restart only after the combined operation verifies.

The original `npm.cmd run checkins:reset -- --confirm-reset-checkins` command
remains an advanced manual alternative, with a separately verified backup.
It does not provide the ops backup/journal workflow and cannot bypass an
unfinished ops operation. Prefer the guarded procedure above.

No roster reimport is needed for existing roster members. Manual-only people
remain outside both rosters, as before; they are not automatically eligible for
public roster check-in. If they should participate in the next run, arrange a
reviewed roster import using their existing participant IDs before reopening.
Do not create duplicate manual registrations with new IDs to bypass duplicate
checks.

Do any trial check-in on a separate test database. A check-in on the live
database after reset is a real new attendance record.

## 5. Monitor check-ins remotely over Wi-Fi

Use this to follow check-in status from a second computer, for example when
both computers are connected to the organizer's phone hotspot. **Never expose
Blaze or the app directly on the Wi-Fi.** Blaze has no authentication, so anyone
who can reach port 8090 can read, change or delete every record. Plain HTTP would
also send staff passwords and personal data unencrypted. Keep both services
bound to `127.0.0.1` as configured and use an encrypted SSH tunnel with key
authentication instead:

```text
Monitoring PC ──(SSH, port 22, key login, encrypted)──> Registration PC
  localhost:8080  →  check-in app (staff dashboard)
  localhost:8090  →  Blaze FHIR API (optional, full access)
```

No change to `.env`, `compose.yaml` or the application is needed.

### Prepare the registration PC (once)

Run in an administrator PowerShell window:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic
Start-Service sshd
```

* On the monitoring PC, create a key with `ssh-keygen -t ed25519` and copy the
  public key (`id_ed25519.pub`) into the event operator account's
  `%USERPROFILE%\.ssh\authorized_keys` on the registration PC. For an account in
  the Administrators group, use `C:\ProgramData\ssh\administrators_authorized_keys`
  instead (only Administrators and SYSTEM may have access to that file).
* Disable password logins: set `PasswordAuthentication no` in
  `C:\ProgramData\ssh\sshd_config`, then run `Restart-Service sshd`.
* Allow SSH only from the hotspot subnet. Find the PC's address with `ipconfig`;
  iPhone hotspots typically use `172.20.10.0/28`:

  ```powershell
  Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -RemoteAddress 172.20.10.0/28
  ```

### Disable rule

 ```powershell
Disable-NetFirewallRule -Name OpenSSH-Server-In-TCP
```

### Slacker rules

```powershell
Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Private -RemoteAddress LocalSubnet
```

### Connect from the monitoring PC

Check the connection, then open the tunnel and leave the window open while
monitoring (replace the user and address):

```powershell
Test-NetConnection 172.20.10.2 -Port 22
ssh -N -L 8080:127.0.0.1:8080 eventops@172.20.10.2
```

Add `-L 8090:127.0.0.1:8090` only if raw FHIR access to Blaze is needed.
Some Android hotspots isolate clients from each other; if the connection test
fails, check the hotspot settings.

### What to view

**Recommended: the staff dashboard.** Open `http://localhost:8080` on the
monitoring PC and sign in via **Staff access** to see check-in counts, track
totals, arrivals, receipts and CSV export. `PUBLIC_URL` remains
`http://localhost:8080`, matching the tunneled browser origin, so same-origin
checks and cookies work unchanged.

**Optional: raw FHIR queries to Blaze** (requires the 8090 tunnel). A Practitioner
is created only at check-in, so their count equals the number of arrivals:

* Count of checked-in participants:
  `http://localhost:8090/fhir/Practitioner?_summary=count`
* Check-in List with arrival times plus the referenced Practitioners:
  `http://localhost:8090/fhir/List?identifier=https://hl7.no/fhir/ig/hackathon-check-in-app/identifier/list%7Chackathon-2026-checkins&_include=List:item`
* All checked-in Practitioners:
  `http://localhost:8090/fhir/Practitioner?_count=500`

### Stop the SSH server after monitoring

1. On the monitoring PC, press `Ctrl+C` in the SSH tunnel terminal.
2. On the registration PC, open **PowerShell as Administrator** and run:

   ```powershell
   Stop-Service sshd
   Get-Service sshd
   ```

   Confirm that the status is `Stopped`. Stopping the server interrupts SSH
   access; closing the tunnel alone does not stop the server.
3. To also prevent SSH from starting automatically after a reboot, run:

   ```powershell
   Set-Service sshd -StartupType Disabled
   ```

   Before the next monitoring session, restore automatic startup and start SSH:

   ```powershell
   Set-Service sshd -StartupType Automatic
   Start-Service sshd
   ```

   If you also disabled the firewall rule, re-enable it with
   `Enable-NetFirewallRule -Name OpenSSH-Server-In-TCP`. This preserves its
   configured subnet restriction.

### Security notes

* The 8090 tunnel gives **full read/write/delete** access to Blaze. For
  read-only monitoring, forward only 8080 and use the authenticated dashboard.
* Use a private hotspot with WPA2/WPA3 and a strong password; do not share it.
* The monitoring PC displays personal data: lock its screen, avoid local
  exports unless needed and close the SSH window after monitoring.
* Without SSH, the only acceptable alternative is the trusted HTTPS reverse
  proxy described under [Configuration](README.md#configuration), never
  `HOST=0.0.0.0` over plain HTTP or publishing Blaze on `0.0.0.0:8090`.
