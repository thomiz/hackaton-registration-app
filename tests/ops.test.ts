import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOperationsArgs, readRosterInputs, runOperations } from '../scripts/ops';
import { errorMessage, Operations } from '../scripts/ops-core';
import type { Config } from '../server/config';
import { JsonFileStore, readStore } from '../server/file-store';
import { importRoster, parseRoster, type ImportRow } from '../server/imports';
import { RegistrationService } from '../server/registration';

const alice: ImportRow = { id: 'alice', name: 'Alice Example', email: 'alice@example.invalid', affiliation: 'Synthetic', track: 'smart', role: 'attendee' };
const bob: ImportRow = { id: 'bob', name: 'Bob Example', email: 'bob@example.invalid', affiliation: 'Synthetic', track: '', role: 'attendee' };
let base: string;
let operations: Operations;
let config: Config;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'checkin-ops-'));
  config = {
    host: '127.0.0.1', port: 1, publicUrl: 'http://localhost:1', privacyUrl: 'https://example.invalid/privacy',
    dataDir: join(base, 'data'), sessionSecret: 'synthetic-ops-test-secret-over-32-characters',
    staffUsername: 'organizer', staffPasswordHash: `${'a'.repeat(32)}:${'b'.repeat(128)}`
  };
  operations = new Operations({ root: base, config });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(base, { recursive: true, force: true }); });

async function seed(rows: ImportRow[] = [alice]) {
  const store = await JsonFileStore.open(config.dataDir);
  const service = new RegistrationService(store, config.sessionSecret);
  await service.initialize();
  await importRoster(service, 'roster', rows);
  return { store, service };
}

describe('operations command line', () => {
  it('shows help without .env or data', async () => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runOperations(['help'])).toBe(0);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('PREVIEWS'));
  });
  it('makes import and reset previews by default', () => {
    expect(parseOperationsArgs(['reset'])).toMatchObject({ command: 'reset', options: {} });
    expect(parseOperationsArgs(['import', '--attendees', 'reviewed.csv']).options.apply).toBeUndefined();
    expect(parseOperationsArgs(['reset', '--dry-run']).options['dry-run']).toBe(true);
    expect(parseOperationsArgs(['reset', '--apply']).options.apply).toBe(true);
    expect(parseOperationsArgs(['backup']).command).toBe('backup');
  });
  it.each([
    ['import'],
    ['import', '--staff', 'staff.csv', '--agenda', 'agenda.md'],
    ['reset', '--apply', '--dry-run'],
    ['reset', '--confirm', 'anything'],
    ['reset', '--apply', '--confirm', ''],
    ['import', '--attendees', 'first.csv', '--attendees', 'second.csv'],
    ['import', '--attendees', 'file.csv', '--backup-dir', 'private'],
    ['start', '--attendees', 'file.csv'],
    ['backup', '--backup-dir', ''],
    ['status', 'stop'],
    ['stop'],
    ['unknown'],
    ['reset', '--yes']
  ])('rejects invalid or ambiguous arguments: %j', (...args) => {
    expect(() => parseOperationsArgs(args)).toThrow();
  });
  it('accepts combined imports and explicit reset without splitting Windows paths', () => {
    const { options } = parseOperationsArgs([
      'import', '--attendees', 'D:\\private data\\attendees.csv', '--staff', 'D:\\private data\\staff.csv',
      '--reset-checkins', '--apply', '--backup-dir', 'D:\\private backups', '--confirm', 'EXACT PHRASE'
    ]);
    expect(options.attendees).toBe('D:\\private data\\attendees.csv');
    expect(options['reset-checkins']).toBe(true);
    expect(options.confirm).toBe('EXACT PHRASE');
  });
  it('reads complete CSVs and warns about files inside the application folder', async () => {
    const file = join(base, 'reviewed.csv');
    await writeFile(file, 'id,name,email,affiliation,track,role\nalice,Alice Example,alice@example.invalid,Synthetic,smart,attendee\n');
    const { options } = parseOperationsArgs(['import', '--attendees', file]);
    const result = await readRosterInputs(options, base, base);
    expect(result.rosters.roster).toHaveLength(1);
    expect(result.warnings[0]).toContain('inside the application folder');
    expect(result.warnings.join(' ')).not.toContain('alice@example.invalid');
  });
  it('reports agenda review warnings without logging personal contacts', async () => {
    const file = join(base, 'agenda.md');
    await writeFile(file, '#### Track leads and partners\n\n| Track | Name | Contact | Affiliate |\n| --- | --- | --- | --- |\n' +
      '| SMART on FHIR | Synthetic Lead + others | [wrong@example.invalid](mailto:lead@example.invalid) | Synthetic |\n');
    const { options } = parseOperationsArgs(['import', '--agenda', file]);
    await mkdir(join(base, 'elsewhere'));
    const result = await readRosterInputs(options, join(base, 'elsewhere'), base);
    expect(result.rosters.staff).toHaveLength(1);
    expect(result.agendaWarnings).toBe(2);
    expect(result.warnings.join(' ')).not.toContain('lead@example.invalid');
    expect(result.warnings.join(' ')).not.toContain('Synthetic Lead');
  });
  it('redacts invalid row values from command-line error output', () => {
    try { parseRoster('name,email,affiliation,track,role\nAlice Example,alice@example.invalid,Synthetic,secret-personal-value,attendee'); }
    catch (error) {
      expect(errorMessage(error)).toContain('Invalid input');
      expect(errorMessage(error)).not.toContain('secret-personal-value');
    }
    try { parseRoster('name,email\n"secret-personal-value'); }
    catch (error) {
      expect(errorMessage(error)).toContain('CSV parsing failed');
      expect(errorMessage(error)).not.toContain('secret-personal-value');
    }
  });
});

describe('operations against the JSON data file', () => {
  it('previews on a fresh installation and while the app holds the data, without writing', async () => {
    expect(await operations.preview({ resetCheckins: false, rosters: { roster: [alice] } }))
      .toMatchObject({ action: 'import', rosters: [{ added: 1 }], confirmation: 'IMPORT 1 ATTENDEES; REMOVE 0 ROSTER MEMBERSHIPS' });
    const { store } = await seed();
    const before = await readFile(store.paths.file, 'utf8');
    expect(await operations.preview({ resetCheckins: true, rosters: { roster: [bob] } }))
      .toMatchObject({ action: 'reset-and-import', rosters: [{ added: 1, removed: 1 }] });
    expect(await readFile(store.paths.file, 'utf8')).toBe(before);
    await store.close();
  });
  it('backs up while the app is running and records the verified copy', async () => {
    expect(await operations.backup()).toBeUndefined();
    const { store } = await seed();
    const record = await operations.backup(join(base, 'backups'));
    expect(record).toMatchObject({ resources: 4, source: store.paths.file });
    expect(await readFile(record!.file, 'utf8')).toBe(await readFile(store.paths.file, 'utf8'));
    expect((await operations.status()).lastBackup?.file).toBe(record!.file);
    await store.close();
  });
  it('refuses to apply while the app holds the data', async () => {
    const { store } = await seed();
    await expect(operations.apply({ resetCheckins: true, rosters: {} }, undefined, async p => p.confirmation)).rejects.toThrow('in use by check-in app');
    await store.close();
  });
  it('cancels on a wrong confirmation without a backup or write', async () => {
    const { store } = await seed();
    await store.close();
    const before = await readFile(store.paths.file, 'utf8');
    await expect(operations.apply({ resetCheckins: false, rosters: { roster: [bob] } }, undefined, async () => 'nope')).rejects.toThrow('did not match');
    expect(await readFile(store.paths.file, 'utf8')).toBe(before);
    expect((await operations.status()).lastBackup).toBeUndefined();
  });
  it('resets and imports in one atomic step after a backup', async () => {
    const { store, service } = await seed();
    const selected = await service.select((await service.matches('Alice'))[0]!.token);
    await service.checkin(selected, selected.selection);
    await store.close();
    const result = await operations.apply({ resetCheckins: true, rosters: { roster: [alice, bob] } }, undefined, async p => p.confirmation);
    expect(result.preview.confirmation).toBe('RESET 1 CHECK-INS AND 1 EVENT RECORDS; IMPORT 2 ATTENDEES; REMOVE 0 ROSTER MEMBERSHIPS');
    expect(result.backup?.file).toContain(join('data', 'backups'));
    const after = new RegistrationService(await readStore(config.dataDir), config.sessionSecret);
    expect((await after.dashboard()).totals).toMatchObject({ roster: 2, checkedIn: 0 });
  });
  it('rejects invalid combined input before any backup or write', async () => {
    const { store } = await seed();
    await store.close();
    const before = await readFile(store.paths.file, 'utf8');
    const conflicting = { ...bob, email: alice.email };
    await expect(operations.apply({ resetCheckins: true, rosters: { roster: [alice, conflicting] } }, undefined, async p => p.confirmation)).rejects.toThrow('Ambiguous');
    expect(await readFile(store.paths.file, 'utf8')).toBe(before);
    expect((await operations.status()).lastBackup).toBeUndefined();
  });
});
