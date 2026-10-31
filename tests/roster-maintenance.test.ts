import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, Person } from 'fhir/r4';
import { importRoster, importRosters, previewRosters, verifyRosters, type ImportRow } from '../server/imports';
import { addRosterEntry, removeRosterEntry, stableRosterId } from '../server/roster';
import { MemoryStore } from './memory-store';
import { RegistrationService } from '../server/registration';
import { previewResetCheckins, resetCheckins } from '../server/reset-checkins';
import { detailsOf } from '../server/model';
import { LISTS } from '../shared/domain';

const alice: ImportRow = { id: 'alice', name: 'Alice Example', email: 'alice@example.invalid', affiliation: 'Example', track: 'smart', role: 'attendee' };
const bob: ImportRow = { id: 'bob', name: 'Bob Example', email: 'bob@example.invalid', affiliation: 'Example', track: 'fhir-101', role: 'track-lead' };
let store: MemoryStore;
let service: RegistrationService;
beforeEach(async () => {
  store = new MemoryStore();
  service = new RegistrationService(store, 'test-only-secret-at-least-32-characters');
  await service.initialize();
  await importRoster(service, 'roster', [alice]);
  await importRoster(service, 'staff', [alice]);
});

describe('roster maintenance previews and atomic imports', () => {
  it('previews additions, removals and changed details without writing', async () => {
    const snapshot = structuredClone(store.resources);
    const preview = await previewRosters(service, { roster: [{ ...alice, track: 'care-plans' }, bob] });
    expect(preview.rosters).toEqual([{
      source: 'roster', total: 2, added: 1, removed: 0, updated: 1, unchanged: 0, confirmedDetailsPreserved: 0
    }]);
    expect((await previewRosters(service, { roster: [bob] })).rosters[0]).toMatchObject({ added: 1, removed: 1 });
    expect((await previewRosters(service, { roster: [alice] })).rosters[0]).toMatchObject({ unchanged: 1 });
    expect(store.resources).toEqual(snapshot);
    expect((await previewRosters(service, { roster: [alice] })).fingerprint).toBe(preview.fingerprint);
  });
  it('updates overlapping roles in both lists in one transaction with one Person write', async () => {
    const updated = { ...alice, role: 'track-lead' as const };
    await expect(importRoster(service, 'roster', [updated])).rejects.toThrow('Conflicting roles');
    const before = (await store.search('Person', '')).map(p => p.id);
    const transaction = vi.spyOn(store, 'transaction');
    await importRosters(service, { roster: [updated], staff: [updated, bob] });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![0].filter(e => e.resource?.resourceType === 'Person')).toHaveLength(2);
    expect(await store.search('Person', '')).toHaveLength(2);
    expect((await store.search('Person', '')).map(p => p.id)).toEqual(expect.arrayContaining(before));
    await verifyRosters(service, { roster: [updated], staff: [updated, bob] });
    expect((await service.dashboard()).totals).toMatchObject({ roster: 1, staff: 2, checkedIn: 0 });
  });
  it('allows a role change when simultaneously removing membership from the other list', async () => {
    const updated = { ...alice, role: 'track-lead' as const };
    await importRosters(service, { roster: [updated], staff: [bob] });
    await verifyRosters(service, { roster: [updated], staff: [bob] });
  });
  it('creates a new overlapping participant only once', async () => {
    await importRosters(service, { roster: [alice, bob], staff: [bob] });
    expect(await store.search('Person', '')).toHaveLength(2);
    await verifyRosters(service, { roster: [alice, bob], staff: [bob] });
  });
  it('rejects inconsistent supplied rosters before any writes', async () => {
    const snapshot = structuredClone(store.resources);
    await expect(importRosters(service, { roster: [alice], staff: [{ ...alice, role: 'track-lead' }] })).rejects.toThrow('Conflicting roles');
    await expect(importRosters(service, { roster: [alice], staff: [{ ...alice, track: 'care-plans' }] })).rejects.toThrow('Conflicting details');
    await expect(importRosters(service, { roster: [alice, bob], staff: [{ ...bob, id: 'another-id' }] })).rejects.toThrow('Ambiguous');
    expect(store.resources).toEqual(snapshot);
  });
  it('does not partially replace either roster on transaction failure', async () => {
    const snapshot = structuredClone(store.resources);
    store.fail = true;
    await expect(importRosters(service, { roster: [bob], staff: [bob] })).rejects.toThrow('failure');
    expect(store.resources).toEqual(snapshot);
  });
  it('keeps checked-in details on import and previews the post-reset change without performing it', async () => {
    const [match] = await service.matches('Alice');
    const selected = await service.select(match!.token);
    await service.checkin({ ...selected, track: 'care-plans' }, selected.selection);
    const normal = await previewRosters(service, { roster: [alice] });
    expect(normal.rosters[0]).toMatchObject({ confirmedDetailsPreserved: 1, unchanged: 1, updated: 0 });
    const updated = { ...alice, role: 'track-lead' as const, track: 'fhir-101' as const };
    const inputs = { roster: [updated], staff: [updated] };
    await expect(previewRosters(service, inputs)).rejects.toThrow('Confirmed role conflict');
    const snapshot = structuredClone(store.resources);
    const afterReset = await previewRosters(service, inputs, true);
    expect(afterReset.rosters.every(r => r.updated === 1 && r.confirmedDetailsPreserved === 0)).toBe(true);
    expect(store.resources).toEqual(snapshot);
    await resetCheckins(service);
    await importRosters(service, inputs);
    await verifyRosters(service, inputs);
    expect(detailsOf((await store.search<Person>('Person', ''))[0]!)).toMatchObject({ track: 'fhir-101' });
    expect((await service.dashboard()).totals.checkedIn).toBe(0);
  });
  it('detects an import that cannot be verified', async () => {
    await expect(verifyRosters(service, { roster: [alice, bob] })).rejects.toThrow('could not be verified');
    await expect(verifyRosters(service, { roster: [{ ...alice, role: 'track-lead' }] })).rejects.toThrow('could not be verified');
  });
  it('rejects empty or oversized lists and a missing selection', async () => {
    await expect(previewRosters(service, {})).rejects.toThrow('Select');
    await expect(previewRosters(service, { roster: [] })).rejects.toThrow();
    await expect(previewRosters(service, { roster: Array.from({ length: 501 }, (_, i) => ({ ...alice, id: `id-${i}` })) })).rejects.toThrow();
  });
});

describe('single participant roster changes', () => {
  const carol = { name: 'Carol Example', email: 'carol@example.invalid', affiliation: 'Example', track: '' as const, role: 'attendee' as const };
  const audits = async () => (await store.search<AuditEvent>('AuditEvent', '')).map(a => a.entity?.[0]?.description);

  it('adds a new person to the attendee list with the import-compatible ID, an audit and no check-in', async () => {
    const result = await addRosterEntry(service, 'roster', carol, 'Late sign-up by email', 'organizer');
    expect(result).toMatchObject({ created: true, id: stableRosterId(carol.name, carol.affiliation), lists: ['roster'] });
    expect(await store.search('Practitioner', '')).toHaveLength(0);
    expect((await service.dashboard()).totals).toMatchObject({ roster: 2, staff: 1, checkedIn: 0, rosterMissing: 2 });
    expect(await audits()).toEqual(['Added to attendee list: Late sign-up by email']);
    const [match] = await service.matches('Carol Example');
    expect(match).toMatchObject({ name: 'Carol Example', alreadyCheckedIn: false });
    const selected = await service.select(match!.token);
    expect((await service.checkin(selected, selected.selection)).role).toBe('attendee');
    // A later complete reimport recognizes the same person.
    const preview = await previewRosters(service, { roster: [alice, { ...carol, id: stableRosterId(carol.name, carol.affiliation) }] });
    expect(preview.rosters[0]).toMatchObject({ added: 0, confirmedDetailsPreserved: 1 });
  });
  it('reuses an existing person from the other list and rejects duplicates and role conflicts', async () => {
    await importRoster(service, 'staff', [alice, bob]);
    await expect(addRosterEntry(service, 'roster', { ...alice, role: 'attendee' }, 'Already there', 'organizer')).rejects.toThrow('already in the attendee list');
    await expect(addRosterEntry(service, 'roster', { ...bob, role: 'attendee' }, 'Wrong role', 'organizer')).rejects.toThrow('listed as track-lead in the staff list');
    const result = await addRosterEntry(service, 'roster', { ...bob, email: 'BOB@example.invalid' }, 'Also signed up', 'organizer');
    expect(result).toMatchObject({ created: false, id: 'bob', lists: ['roster', 'staff'] });
    expect(await store.search('Person', '')).toHaveLength(2);
    expect((await service.dashboard()).totals).toMatchObject({ roster: 2, staff: 2 });
    await verifyRosters(service, { roster: [alice, bob], staff: [alice, bob] });
  });
  it('does not overwrite confirmed details or role when re-adding a checked-in person', async () => {
    const [match] = await service.matches('Alice');
    const selected = await service.select(match!.token);
    await service.checkin({ ...selected, track: 'care-plans' }, selected.selection);
    const personId = (await store.search<Person>('Person', ''))[0]!.id!;
    await removeRosterEntry(service, 'roster', personId, 'Cancelled', 'organizer');
    await removeRosterEntry(service, 'staff', personId, 'Cancelled', 'organizer');
    await expect(addRosterEntry(service, 'staff', { ...alice, role: 'track-lead' }, 'Promote', 'organizer')).rejects.toThrow('Confirmed role conflict');
    await addRosterEntry(service, 'staff', { ...alice, track: 'fhir-101' }, 'Also helps at the desk', 'organizer');
    await expect(addRosterEntry(service, 'roster', { ...alice, role: 'track-lead' }, 'Promote', 'organizer')).rejects.toThrow('listed as attendee in the staff list');
    const person = (await store.search<Person>('Person', '')).find(p => p.identifier?.some(i => i.value === 'alice'))!;
    expect(detailsOf(person).track).toBe('care-plans');
    expect((await service.dashboard()).totals).toMatchObject({ roster: 0, staff: 1, checkedIn: 1, staffMissing: 0 });
  });
  it('removes a person from one list only, keeping the Person, the other list and attendance', async () => {
    const [match] = await service.matches('Alice');
    const selected = await service.select(match!.token);
    const receipt = await service.checkin(selected, selected.selection);
    const personId = (await store.search<Person>('Person', ''))[0]!.id!;
    const result = await removeRosterEntry(service, 'roster', personId, 'Cancelled attendance', 'organizer');
    expect(result).toMatchObject({ personId, id: 'alice', created: false, lists: ['staff'] });
    expect(await audits()).toEqual(['Removed from attendee list: Cancelled attendance']);
    expect((await service.dashboard()).totals).toMatchObject({ roster: 0, staff: 1, checkedIn: 1 });
    expect((await service.dashboard()).rows[0]).toMatchObject({ lists: ['staff'] });
    expect(await service.receipt(receipt.receiptId)).toMatchObject({ name: 'Alice Example' });
    await expect(removeRosterEntry(service, 'roster', personId, 'Already removed', 'organizer')).rejects.toThrow('not in the attendee list');
    await expect(removeRosterEntry(service, 'staff', 'missing-person', 'Unknown', 'organizer')).rejects.toThrow('not in the staff list');
    await removeRosterEntry(service, 'staff', personId, 'Left the team', 'organizer');
    expect(await service.matches('Alice')).toHaveLength(0);
    expect(await store.search('Person', '')).toHaveLength(1);
    expect((await service.dashboard()).rows[0]).toMatchObject({ lists: [] });
  });
  it('rejects a stale selection after removal and allows re-adding with the same identity', async () => {
    await removeRosterEntry(service, 'staff', (await store.search<Person>('Person', ''))[0]!.id!, 'Not staff', 'organizer');
    const [match] = await service.matches('Alice');
    const selected = await service.select(match!.token);
    const personId = (await store.search<Person>('Person', ''))[0]!.id!;
    await removeRosterEntry(service, 'roster', personId, 'Cancelled', 'organizer');
    await expect(service.checkin(selected, selected.selection)).rejects.toThrow('no longer exists');
    const result = await addRosterEntry(service, 'roster', { ...alice, role: 'attendee' }, 'Un-cancelled', 'organizer');
    expect(result).toMatchObject({ created: false, personId, id: 'alice', lists: ['roster'] });
    expect(await store.search('Person', '')).toHaveLength(1);
  });
  it('leaves everything unchanged when the transaction fails', async () => {
    const snapshot = structuredClone(store.resources);
    store.fail = true;
    await expect(addRosterEntry(service, 'roster', carol, 'Late sign-up', 'organizer')).rejects.toThrow('failure');
    await expect(removeRosterEntry(service, 'roster', (await store.search<Person>('Person', ''))[0]!.id!, 'Cancelled', 'organizer')).rejects.toThrow('failure');
    expect(store.resources).toEqual(snapshot);
  });
});

describe('reset preview', () => {
  it('counts event records even after a partially completed reset, without writing', async () => {
    const [match] = await service.matches('Alice');
    const selected = await service.select(match!.token);
    await service.checkin(selected, selected.selection);
    const snapshot = structuredClone(store.resources);
    expect(await previewResetCheckins(service)).toMatchObject({ checkedIn: 1, practitioners: 1 });
    expect(store.resources).toEqual(snapshot);
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, 'transaction').mockImplementationOnce(transaction).mockRejectedValueOnce(new Error('Deletion failed'));
    await expect(resetCheckins(service)).rejects.toThrow('Deletion failed');
    expect(await previewResetCheckins(service)).toMatchObject({ checkedIn: 0, practitioners: 1 });
    vi.restoreAllMocks();
    await resetCheckins(service);
    expect(await previewResetCheckins(service)).toMatchObject({ checkedIn: 0, practitioners: 0 });
    expect((await service.list(LISTS.roster)).entry).toHaveLength(1);
  });
});
