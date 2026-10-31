import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agendaRoster } from '../server/agenda.js';
import { parseRoster, type RosterUpdates } from '../server/imports.js';
import { runUntilStopped } from '../server/startup.js';
import { EVENT } from '../shared/domain.js';
import { errorMessage, loadOperationsEnvironment, Operations, type MaintenancePreview, type MaintenanceRequest } from './ops-core.js';

export const help = `Local check-in operations

  npm run ops -- start
  npm run ops -- status [--json]
  npm run ops -- backup [--backup-dir <directory>]
  npm run ops -- import --attendees <csv> [--staff <csv> | --agenda <md>] [--reset-checkins]
  npm run ops -- import --staff <csv> | --agenda <md>
  npm run ops -- reset

Import/reset default to READ-ONLY PREVIEWS and can run while the app is running.
Apply with --apply (the app must be stopped with Ctrl+C first).
  Optional: --backup-dir <directory> (default: <DATA_DIR>\\backups)
  Optional: --confirm "<exact phrase printed by the preview>" for noninteractive use.
  --dry-run explicitly requests a preview and cannot be combined with --apply.

Start runs the app in the foreground; Ctrl+C stops it.
Backup copies the data file and can run while the app is running.
Every apply takes a verified backup first and writes all changes in one atomic step.
Each selected CSV REPLACES the entire selected roster. Attendance is preserved unless reset is explicit.
Reset is NOT secure erasure: audit records and backups remain.
See OPERATIONS.md for details.
`;

const commandOptions: Record<string, string[]> = {
  status: ['json'], start: [], backup: ['backup-dir'],
  import: ['attendees', 'staff', 'agenda', 'reset-checkins', 'apply', 'dry-run', 'backup-dir', 'confirm'],
  reset: ['apply', 'dry-run', 'backup-dir', 'confirm']
};
export function parseOperationsArgs(args: string[]) {
  const parsed = parseArgs({
    args, allowPositionals: true, strict: true, tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      'backup-dir': { type: 'string' }, attendees: { type: 'string' }, staff: { type: 'string' }, agenda: { type: 'string' },
      'reset-checkins': { type: 'boolean' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, confirm: { type: 'string' }
    }
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Option --${token.name} must only be supplied once.`);
    seen.add(token.name);
  }
  const command = parsed.positionals[0] ?? 'help';
  if (parsed.values.help || command === 'help') return { command: 'help', options: parsed.values };
  const allowed = commandOptions[command];
  if (!allowed || parsed.positionals.length !== 1) throw new Error('Choose exactly one operations command. Run "npm run ops -- help".');
  for (const key of Object.keys(parsed.values)) {
    if (!allowed.includes(key)) throw new Error(`Option --${key} is not valid for ${command}.`);
  }
  const options = parsed.values;
  for (const name of ['backup-dir', 'attendees', 'staff', 'agenda', 'confirm'] as const) {
    if (options[name] !== undefined && !options[name]!.trim()) throw new Error(`--${name} must not be empty.`);
  }
  if (options.staff && options.agenda) throw new Error('Choose --staff or --agenda, not both.');
  if (command === 'import' && !options.attendees && !options.staff && !options.agenda) throw new Error('Import requires --attendees, --staff or --agenda.');
  if (options.apply && options['dry-run']) throw new Error('--apply and --dry-run cannot be combined.');
  if ((command === 'import' || command === 'reset') && !options.apply && (options.confirm !== undefined || options['backup-dir'])) {
    throw new Error('Confirmation and backup options require --apply. Without --apply, import/reset are previews only.');
  }
  return { command, options };
}
type Options = ReturnType<typeof parseOperationsArgs>['options'];

const isWithin = (parent: string, child: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase() + sep);

export async function readRosterInputs(options: Options, root: string, cwd: string) {
  const rosters: RosterUpdates = {};
  const warnings: string[] = [];
  let agendaWarnings = 0;
  const read = async (path: string) => {
    const resolved = await realpath(resolve(cwd, path));
    if (isWithin(root, resolve(cwd, path)) || isWithin(await realpath(root), resolved)) {
      warnings.push(`Input is inside the application folder: ${resolved}. Keep private attendee CSVs outside Git; do not commit them.`);
    }
    return readFile(resolved, 'utf8');
  };
  if (options.attendees) rosters.roster = parseRoster(await read(options.attendees));
  if (options.staff) rosters.staff = parseRoster(await read(options.staff));
  if (options.agenda) {
    const markdown = await read(options.agenda);
    try {
      const generated = agendaRoster(markdown);
      rosters.staff = generated.rows;
      agendaWarnings = generated.warnings.length;
      if (agendaWarnings) warnings.push(`Agenda has ${agendaWarnings} review warning(s). Run staff:generate privately, review the result, then import the reviewed staff CSV instead.`);
    } catch {
      throw new Error('The agenda could not be parsed. Check the Track leads and partners table; run staff:generate privately for detailed diagnostics.');
    }
  }
  return { rosters, warnings, agendaWarnings };
}

export function printPreview(preview: MaintenancePreview): void {
  console.log(`Current attendance: ${preview.checkins} check-ins; ${preview.eventRecords} event Practitioner records.`);
  for (const roster of preview.rosters) {
    console.log(`${roster.source === 'roster' ? 'Attendees' : 'Staff / track leads and partners'}: ${roster.total} rows; ` +
      `${roster.added} added, ${roster.removed} removed, ${roster.updated} updated, ${roster.unchanged} unchanged.`);
    if (roster.confirmedDetailsPreserved) console.log(`  Confirmed details preserved for ${roster.confirmedDetailsPreserved} checked-in participant(s).`);
  }
  console.log(preview.reset
    ? 'All active attendance will be reset before any import. This does not securely erase personal data.'
    : 'Attendance and confirmed check-in details will be preserved.');
  console.log(`Exact confirmation: ${preview.confirmation}`);
}

function printStatus(report: Awaited<ReturnType<Operations['status']>>) {
  console.log(`Overall: ${report.ready ? 'READY' : 'NOT READY'}`);
  console.log(`App: ${report.app.detail} - ${report.appUrl}`);
  console.log(`Data file: ${report.dataFile}${report.data ? ` (${report.data.bytes} bytes, last changed ${report.data.modified})` : ' (not created yet)'}`);
  if (report.lock) console.log(`In use by: ${report.lock.purpose} (PID ${report.lock.pid}) since ${report.lock.since}`);
  if (report.disk) console.log(`Data disk free: ${(report.disk.freeBytes / 1024 ** 3).toFixed(1)} GiB`);
  if (report.lastBackup) console.log(`Last verified backup: ${report.lastBackup.file} (${report.lastBackup.ageHours.toFixed(1)} hours ago)`);
  else console.log('Last verified backup: none.');
  if (report.attendance) {
    console.log('Attendance totals:', JSON.stringify(report.attendance.totals));
    console.log('Arrivals by track:', JSON.stringify(report.attendance.tracks));
  }
  for (const error of report.errors) console.error(error);
}

export async function runOperations(args: string[]): Promise<number> {
  const { command, options } = parseOperationsArgs(args);
  if (command === 'help') { console.log(help); return 0; }
  const cwd = process.cwd();
  const environment = loadOperationsEnvironment();
  const operations = new Operations(environment);
  if (command === 'status') {
    const status = await operations.status();
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    return status.ready ? 0 : 1;
  }
  if (command === 'start') {
    const running = await operations.start();
    console.log(`Check-in app ready: ${environment.config.publicUrl}`);
    console.log(`Data: ${operations.paths.file}`);
    console.log('Leave this window open. Ctrl+C stops the app.');
    await runUntilStopped(running);
    return 0;
  }
  const backupDirectory = options['backup-dir'] ? resolve(cwd, options['backup-dir']) : undefined;
  if (command === 'backup') {
    const result = await operations.backup(backupDirectory);
    console.log(result
      ? `Backup verified: ${result.file} (${result.resources} resources, ${result.bytes} bytes).`
      : 'Nothing to back up yet: the data file has not been created.');
    return 0;
  }
  const inputs = await readRosterInputs(options, environment.root, cwd);
  for (const warning of inputs.warnings) console.warn(`REVIEW: ${warning}`);
  const request: MaintenanceRequest = { resetCheckins: command === 'reset' || !!options['reset-checkins'], rosters: inputs.rosters };
  console.log(`Target event: ${EVENT}; data file: ${operations.paths.file}`);
  if (!options.apply) {
    printPreview(await operations.preview(request));
    console.log('PREVIEW ONLY: nothing was changed. Stop the app, then repeat with --apply to proceed.');
    return 0;
  }
  if (inputs.agendaWarnings) throw new Error('Agenda review warnings block apply. Import an organizer-reviewed staff CSV instead.');
  const result = await operations.apply(request, backupDirectory, async preview => {
    printPreview(preview);
    if (options.confirm !== undefined) return options.confirm.trim();
    if (!process.stdin.isTTY) throw new Error('Interactive confirmation requires a terminal. For automation, pass --confirm with the exact current preview phrase.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await prompt.question('Type the exact confirmation above (anything else cancels): ')).trim(); }
    finally { prompt.close(); }
  });
  console.log(`Maintenance verified (${result.preview.action}).${result.backup ? ` Backup: ${result.backup.file}` : ''}`);
  console.log('Start the app again with "npm run ops -- start".');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runOperations(process.argv.slice(2)); }
  catch (error) { console.error(`Operations failed: ${errorMessage(error)}`); process.exitCode = 1; }
}
