import { parse } from 'csv-parse/sync';
import type { BundleEntry, Person, Practitioner } from 'fhir/r4';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ID_SYSTEM, LISTS, ROLE_SYSTEM, tracks, type RosterSource } from '../shared/domain.js';
import { AppError, put, resourceFingerprint } from './fhir.js';
import { detailsOf, person, refs, roleOf } from './model.js';
import type { RegistrationService } from './registration.js';
import { rowSchema, sameParticipant, stableRosterId, type ImportRow } from './roster.js';

export type { ImportRow } from './roster.js';
export type { RosterSource } from '../shared/domain.js';
export type RosterUpdates = Partial<Record<RosterSource, ImportRow[]>>;
export interface RosterPreview {
  source: RosterSource;
  total: number;
  added: number;
  removed: number;
  updated: number;
  unchanged: number;
  confirmedDetailsPreserved: number;
}

const inputRowSchema = rowSchema.extend({ id: rowSchema.shape.id.or(z.literal('')).optional() }).transform(row => ({
  ...row,
  id: row.id || stableRosterId(row.name, row.affiliation)
}));
const exportTrackCodes = new Map<string, string>([
  ...tracks.map(({ label, code }): [string, string] => [label, code]),
  ['Medication Definition on FHIR', 'medication-definition'],
  ['Document sharing for IHE MHD', 'ihe-mhd'],
  ['Digital home monitoring plans and observations', 'care-plans']
]);

export function parseRoster(csv: string): ImportRow[] {
  const records: unknown = parse(csv, { columns: true, skip_empty_lines: true, bom: true, trim: true });
  const rows = z.array(z.record(z.string())).min(1).max(500).parse(records);
  return rows.map(row => inputRowSchema.parse('Your name' in row ? {
    id: row.id,
    name: row['Your name'],
    email: row['E-postadresse'],
    affiliation: row['Your affiliation/employer'],
    track: exportTrackCodes.get(row['What primary track do you want to attend?'] ?? '') ?? row['What primary track do you want to attend?'],
    role: row.role ?? 'attendee'
  } : row));
}
const sources: RosterSource[] = ['roster', 'staff'];
const sameDetails = (a: ImportRow | Person, b: ImportRow): boolean => {
  const details = 'resourceType' in a ? detailsOf(a) : a;
  return details.name === b.name && details.email === b.email && details.affiliation === b.affiliation && details.track === b.track;
};

async function planRosters(service: RegistrationService, updates: RosterUpdates, afterReset = false) {
  const selected = sources.filter(source => updates[source] !== undefined);
  if (!selected.length) throw new AppError(400, 'Select an attendee and/or staff roster to import.');
  const rowsBySource = new Map<RosterSource, ImportRow[]>();
  const combined = new Map<string, ImportRow>();
  for (const source of selected) {
    const rows = z.array(rowSchema).min(1).max(500).parse(updates[source]);
    rowsBySource.set(source, rows);
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id)) throw new AppError(400, `Duplicate participant ID ${row.id} in CSV.`);
      ids.add(row.id);
      const other = combined.get(row.id);
      if (other && other.role !== row.role) throw new AppError(409, `Conflicting roles for ID ${row.id} in the supplied rosters.`);
      if (other && !sameDetails(other, row)) throw new AppError(409, `Conflicting details for ID ${row.id}. Supply matching rows in both rosters.`);
      combined.set(row.id, row);
    }
  }
  const [roster, staff, all, practitioners] = await Promise.all([
    service.list(LISTS.roster), service.list(LISTS.staff),
    service.store.search<Person>('Person', '_count=200'), service.store.search<Practitioner>('Practitioner', '_count=200')
  ]);
  const fingerprint = resourceFingerprint([roster, staff, ...all, ...practitioners]);
  const lists = { roster, staff };
  const resetTargets = new Set(afterReset ? practitioners
    .filter(p => p.identifier?.some(i => i.system === ID_SYSTEM)).map(p => `Practitioner/${p.id}`) : []);
  const entries: BundleEntry[] = [];
  const people = new Map<string, { id: string; existing?: Person }>();
  const rows = [...combined.values()];
  for (const row of rows) {
    const matches = all.filter(p => p.identifier?.some(i => i.system === ID_SYSTEM && i.value === row.id));
    if (matches.length > 1) throw new AppError(409, `Ambiguous database participant ID ${row.id}.`);
    const existing = matches[0] ? structuredClone(matches[0]) : undefined;
    if (existing?.link && afterReset) existing.link = existing.link.filter(link => !resetTargets.has(link.target.reference ?? ''));
    const id = existing?.id ?? randomUUID();
    people.set(row.id, { id, existing });
    for (const p of all) {
      if (p.id !== id && sameParticipant(detailsOf(p), row)) {
        throw new AppError(409, `Ambiguous duplicate for ID ${row.id}. Reconcile stable IDs before importing.`);
      }
    }
    if (rows.some(other => other.id !== row.id && sameParticipant(other, row))) {
      throw new AppError(400, `Ambiguous duplicate within CSV for ID ${row.id}.`);
    }
    const checkedInReference = existing?.link?.find(link => link.target.reference?.startsWith('Practitioner/'))?.target.reference;
    if (checkedInReference) {
      const checkedIn = practitioners.find(p => `Practitioner/${p.id}` === checkedInReference);
      if (!checkedIn || roleOf(checkedIn) !== row.role) throw new AppError(409, `Confirmed role conflict for ID ${row.id}. Use an audited staff correction first.`);
    }
    // Reimports must not overwrite confirmed details or track changes made at check-in.
    if (!existing?.link?.length) entries.push(put(person(id, row, existing, row.id), !existing));
  }
  const previews: RosterPreview[] = [];
  for (const source of selected) {
    const list = lists[source];
    const otherSource = source === 'roster' ? 'staff' : 'roster';
    const previous = list.entry?.filter(e => !e.deleted) ?? [];
    const incoming = rowsBySource.get(source)!;
    const nextReferences = new Set(incoming.map(row => `Person/${people.get(row.id)!.id}`));
    let added = 0, updated = 0, unchanged = 0, confirmedDetailsPreserved = 0;
    for (const row of incoming) {
      const { id, existing } = people.get(row.id)!;
      const otherRows = rowsBySource.get(otherSource);
      const other = lists[otherSource].entry?.find(e => !e.deleted && e.item.reference === `Person/${id}`);
      const otherRole = otherRows ? otherRows.find(r => r.id === row.id)?.role
        : other?.flag?.coding?.find(c => c.system === ROLE_SYSTEM)?.code;
      if ((otherRows ? otherRole !== undefined : !!other) && otherRole !== row.role) {
        throw new AppError(409, `Conflicting roles for ID ${row.id}. Resolve the organizer-reviewed role first.`);
      }
      const old = previous.find(e => e.item.reference === `Person/${id}`);
      if (existing?.link?.length) confirmedDetailsPreserved++;
      if (!old) added++;
      else if ((!existing?.link?.length && existing && !sameDetails(existing, row)) ||
        old.flag?.coding?.find(c => c.system === ROLE_SYSTEM)?.code !== row.role) updated++;
      else unchanged++;
    }
    previews.push({
      source, total: incoming.length, added, updated, unchanged, confirmedDetailsPreserved,
      removed: refs(list).filter(ref => !nextReferences.has(ref)).length
    });
    list.entry = incoming.map(row => ({
      item: { reference: `Person/${people.get(row.id)!.id}` }, flag: { coding: [{ system: ROLE_SYSTEM, code: row.role }] }
    }));
    list.date = new Date().toISOString();
    entries.push(put(list));
  }
  return { entries, previews, fingerprint };
}

export async function previewRosters(service: RegistrationService, updates: RosterUpdates, afterReset = false) {
  const { previews, fingerprint } = await planRosters(service, updates, afterReset);
  return { rosters: previews, fingerprint };
}

export async function importRosters(service: RegistrationService, updates: RosterUpdates): Promise<RosterPreview[]> {
  return service.retry(async () => {
    const { entries, previews } = await planRosters(service, updates);
    await service.store.transaction(entries);
    return previews;
  });
}

export async function verifyRosters(service: RegistrationService, updates: RosterUpdates): Promise<void> {
  const people = await service.store.search<Person>('Person', '_count=200');
  for (const source of sources) {
    const rows = updates[source];
    if (!rows) continue;
    const list = await service.list(LISTS[source]);
    const entries = list.entry?.filter(e => !e.deleted) ?? [];
    if (entries.length !== rows.length || rows.some(row => {
      const person = people.find(p => p.identifier?.some(i => i.system === ID_SYSTEM && i.value === row.id));
      return !person?.id || !entries.some(e => e.item.reference === `Person/${person.id}` &&
        e.flag?.coding?.some(c => c.system === ROLE_SYSTEM && c.code === row.role));
    })) throw new AppError(503, `The ${source} import could not be verified. Keep the app stopped.`);
  }
}

export async function importRoster(service: RegistrationService, source: RosterSource, rows: ImportRow[]): Promise<number> {
  const [preview] = await importRosters(service, { [source]: rows });
  return preview!.total;
}
