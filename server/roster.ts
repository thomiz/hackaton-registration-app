// Single-participant roster maintenance shared by the staff API, the in-browser demo and CSV imports.
import type { BundleEntry, List, Person, Practitioner } from 'fhir/r4';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  detailsSchema, ID_SYSTEM, LISTS, ROLE_SYSTEM, roleSchema, rosterSourceLabels,
  type Details, type Role, type RosterChange, type RosterSource
} from '../shared/domain.js';
import { AppError, put } from './fhir.js';
import { detailsOf, person, refs, roleOf } from './model.js';
import { normalize, type RegistrationService } from './registration.js';

export const rowSchema = detailsSchema.extend({ id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), role: roleSchema });
export type ImportRow = z.infer<typeof rowSchema>;

export const stableRosterId = (name: string, affiliation: string): string =>
  `roster-${createHash('sha256').update(JSON.stringify([normalize(name), normalize(affiliation)])).digest('hex').slice(0, 32)}`;
// The same person: identical email, or identical normalized name and affiliation.
export const sameParticipant = (a: Details, b: Details): boolean =>
  a.email.toLowerCase() === b.email.toLowerCase() ||
  (normalize(a.name) === normalize(b.name) && normalize(a.affiliation) === normalize(b.affiliation));
const listRole = (list: List, personId: string) =>
  list.entry?.find(e => !e.deleted && e.item.reference === `Person/${personId}`)?.flag?.coding?.find(c => c.system === ROLE_SYSTEM)?.code;

/**
 * Adds one person to the selected roster List without replacing it and without checking anyone in.
 * Reuses an existing Person matching by email or normalized name/affiliation (for example someone
 * already in the other list), applies the same role rules as CSV imports, and records an AuditEvent.
 */
export async function addRosterEntry(service: RegistrationService, source: RosterSource, input: Details & { role: Role }, reason: string, staff: string): Promise<RosterChange> {
  const row = rowSchema.parse({ ...input, id: stableRosterId(input.name, input.affiliation) });
  const otherSource: RosterSource = source === 'roster' ? 'staff' : 'roster';
  return service.retry(async () => {
    const [roster, staffList, people, practitioners] = await Promise.all([
      service.list(LISTS.roster), service.list(LISTS.staff),
      service.store.search<Person>('Person', '_count=200'), service.store.search<Practitioner>('Practitioner', '_count=200')
    ]);
    const lists = { roster, staff: staffList };
    const matches = people.filter(p => sameParticipant(detailsOf(p), row) || p.identifier?.some(i => i.system === ID_SYSTEM && i.value === row.id));
    if (matches.length > 1) throw new AppError(409, 'Several existing participants match these details. Reconcile them with a reviewed roster import first.');
    const existing = matches[0] ? structuredClone(matches[0]) : undefined;
    const personId = existing?.id ?? randomUUID();
    if (existing && refs(lists[source]).includes(`Person/${personId}`)) {
      throw new AppError(409, `${detailsOf(existing).name} is already in the ${rosterSourceLabels[source]}. Use Correct participant to change details.`);
    }
    const otherRole = listRole(lists[otherSource], personId);
    if (otherRole && otherRole !== row.role) {
      throw new AppError(409, `This participant is listed as ${otherRole} in the ${rosterSourceLabels[otherSource]}. Use the same event role, or correct the role first.`);
    }
    const checkedInReference = existing?.link?.find(link => link.target.reference?.startsWith('Practitioner/'))?.target.reference;
    const checkedIn = checkedInReference ? practitioners.find(p => `Practitioner/${p.id}` === checkedInReference) : undefined;
    if (checkedIn && roleOf(checkedIn) !== row.role) throw new AppError(409, 'Confirmed role conflict. Use an audited staff correction first.');
    const stableIdentifier = existing?.identifier?.find(i => i.system === ID_SYSTEM)?.value ?? row.id;
    const list = lists[source];
    list.entry = [...(list.entry ?? []).filter(e => !e.deleted), { item: { reference: `Person/${personId}` }, flag: { coding: [{ system: ROLE_SYSTEM, code: row.role }] } }];
    list.date = new Date().toISOString();
    const entries: BundleEntry[] = [];
    // Like reimports, adding never overwrites details confirmed at check-in.
    if (!existing?.link?.length) entries.push(put(person(personId, row, existing, stableIdentifier), !existing));
    entries.push(put(list), put(service.audit(personId, staff, reason, `Added to ${rosterSourceLabels[source]}`), true));
    await service.store.transaction(entries);
    const saved = await service.store.search<Person>('Person', `identifier=${encodeURIComponent(`${ID_SYSTEM}|${stableIdentifier}`)}`);
    if (saved.length !== 1 || !saved[0]?.id) throw new AppError(503, 'Cannot resolve the saved participant. Refresh the dashboard and search for the person.');
    return { personId: saved[0].id, id: stableIdentifier, created: !existing, lists: await service.memberships(saved[0].id) };
  });
}

/**
 * Removes one person from the selected roster List. The Person, any recorded check-in and the
 * other list are retained, matching the semantics of a CSV reimport without that row.
 */
export async function removeRosterEntry(service: RegistrationService, source: RosterSource, personId: string, reason: string, staff: string): Promise<RosterChange> {
  return service.retry(async () => {
    const [list, existing] = await Promise.all([service.list(LISTS[source]), service.store.read<Person>('Person', personId)]);
    const current = list.entry?.filter(e => !e.deleted) ?? [];
    const remaining = current.filter(e => e.item.reference !== `Person/${personId}`);
    if (!existing || remaining.length === current.length) throw new AppError(404, `Participant is not in the ${rosterSourceLabels[source]}.`);
    list.entry = remaining;
    list.date = new Date().toISOString();
    await service.store.transaction([put(list), put(service.audit(personId, staff, reason, `Removed from ${rosterSourceLabels[source]}`), true)]);
    const id = existing.identifier?.find(i => i.system === ID_SYSTEM)?.value ?? personId;
    return { personId, id, created: false, lists: await service.memberships(personId) };
  });
}
