import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person, Practitioner } from 'fhir/r4';
import { ID_SYSTEM, LISTS } from '../shared/domain';
import { importRoster } from '../server/imports';
import { RegistrationService } from '../server/registration';
import { resetCheckins } from '../server/reset-checkins';
import { MemoryStore } from './memory-store';

let store: MemoryStore;
let service: RegistrationService;
const attendee = { id: 'alice', name: 'Alice Example', email: 'alice@example.invalid', affiliation: 'Example', track: 'smart' as const, role: 'attendee' as const };
async function arrive() {
  const [match] = await service.matches('Alice');
  const selection = await service.select(match!.token);
  return service.checkin({ ...selection, track: 'care-plans' }, selection.selection);
}
beforeEach(async () => {
  store = new MemoryStore();
  service = new RegistrationService(store, 'test-only-secret-at-least-32-characters');
  await service.initialize();
  await importRoster(service, 'roster', [attendee]);
  await importRoster(service, 'staff', [attendee]);
});
describe('attendance reset', () => {
  it('preserves rosters and confirmed details and allows a fresh check-in', async () => {
    const first = await arrive();
    const roster = await service.list(LISTS.roster);
    const staff = await service.list(LISTS.staff);
    expect(await resetCheckins(service)).toBe(1);
    expect(await service.list(LISTS.roster)).toEqual(roster);
    expect(await service.list(LISTS.staff)).toEqual(staff);
    expect((await store.search<Person>('Person', ''))[0]!.link).toBeUndefined();
    expect((await service.dashboard()).totals).toMatchObject({ checkedIn: 0, rosterMissing: 1, staffMissing: 1 });
    await expect(service.receipt(first.receiptId)).rejects.toThrow('not found');
    const [match] = await service.matches('Alice');
    expect(match!.alreadyCheckedIn).toBe(false);
    expect((await service.select(match!.token)).track).toBe('care-plans');
    const second = await arrive();
    expect(second.alreadyCheckedIn).toBe(false);
    expect(second.receiptId).not.toBe(first.receiptId);
  });
  it('retains manual participant details and audits, but removes their attendance', async () => {
    await service.manual({ ...attendee, name: 'Manual Visitor', email: 'manual@example.invalid' }, 'attendee', 'Test registration', 'a14ea792-4264-49d4-ade3-25bb411c266e', 'organizer');
    const audits = await store.search('AuditEvent', '');
    expect(await resetCheckins(service)).toBe(1);
    expect(await store.search('Person', '')).toHaveLength(2);
    expect(await store.search('AuditEvent', '')).toEqual(audits);
    expect(await store.search('Practitioner', '')).toHaveLength(0);
  });
  it('does not change anything on transaction failure', async () => {
    await arrive();
    const snapshot = structuredClone(store.resources);
    store.fail = true;
    await expect(resetCheckins(service)).rejects.toThrow('Injected transaction failure');
    expect(store.resources).toEqual(snapshot);
  });
  it('resumes deletion after references were cleared but the delete transaction failed', async () => {
    await arrive();
    const transaction = store.transaction.bind(store);
    const spy = vi.spyOn(store, 'transaction')
      .mockImplementationOnce(transaction)
      .mockRejectedValueOnce(new Error('Delete transaction failed'));
    await expect(resetCheckins(service)).rejects.toThrow('Delete transaction failed');
    expect((await service.dashboard()).totals.checkedIn).toBe(0);
    expect(await store.search('Practitioner', '')).toHaveLength(1);
    spy.mockRestore();
    expect(await resetCheckins(service)).toBe(1);
    expect(await store.search('Practitioner', '')).toHaveLength(0);
    expect((await arrive()).alreadyCheckedIn).toBe(false);
  });
  it('rejects deletes whose references are only removed in the same transaction', async () => {
    const first = await arrive();
    const list = await service.list(LISTS.checkins);
    list.entry = [];
    const snapshot = structuredClone(store.resources);
    await expect(store.transaction([
      { resource: list, request: { method: 'PUT', url: `List/${list.id}` } },
      { request: { method: 'DELETE', url: `Practitioner/${first.receiptId}` } }
    ])).rejects.toThrow('Referential integrity');
    expect(store.resources).toEqual(snapshot);
  });
  it('is repeatable and preserves unrelated Practitioners', async () => {
    const unrelated: Practitioner = { resourceType: 'Practitioner', id: 'unrelated' };
    store.resources.set('Practitioner/unrelated', unrelated);
    await arrive();
    expect(await resetCheckins(service)).toBe(1);
    expect(await resetCheckins(service)).toBe(0);
    expect(await store.read('Practitioner', 'unrelated')).toEqual(unrelated);
    expect((await store.search<Practitioner>('Practitioner', '')).some(p => p.identifier?.some(i => i.system === ID_SYSTEM))).toBe(false);
  });
  it('refuses inconsistent check-in references without writing', async () => {
    const list = await service.list(LISTS.checkins);
    list.entry = [{ item: { reference: 'Practitioner/missing' } }];
    store.resources.set(`List/${list.id}`, list);
    const snapshot = structuredClone(store.resources);
    await expect(resetCheckins(service)).rejects.toThrow('inconsistent');
    expect(store.resources).toEqual(snapshot);
  });
});
