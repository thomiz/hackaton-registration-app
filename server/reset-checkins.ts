import type { BundleEntry, Person, Practitioner } from 'fhir/r4';
import { ID_SYSTEM, LISTS } from '../shared/domain.js';
import { AppError, put, resourceFingerprint } from './fhir.js';
import { refs } from './model.js';
import type { RegistrationService } from './registration.js';

async function planReset(service: RegistrationService) {
  const list = await service.list(LISTS.checkins);
  const people = await service.store.search<Person>('Person', '_count=200');
  const practitioners = await service.store.search<Practitioner>('Practitioner', '_count=200');
  const eventPractitioners = practitioners.filter(p => p.identifier?.some(i => i.system === ID_SYSTEM));
  const targets = new Set(eventPractitioners.map(p => `Practitioner/${p.id}`));
  if (eventPractitioners.some(p => !p.id) || refs(list).some(ref => !targets.has(ref))) {
    throw new AppError(409, 'Check-in records are inconsistent. Repair them before resetting attendance.');
  }
  const preview = {
    checkedIn: refs(list).length, practitioners: eventPractitioners.length,
    fingerprint: resourceFingerprint([list, ...people, ...practitioners])
  };
  const entries: BundleEntry[] = [];
  for (const p of people) {
    if (!p.link?.some(link => targets.has(link.target.reference ?? ''))) continue;
    p.link = p.link.filter(link => !targets.has(link.target.reference ?? ''));
    if (!p.link.length) delete p.link;
    entries.push(put(p));
  }
  list.entry = [];
  list.date = new Date().toISOString();
  entries.push(put(list));
  return { entries, eventPractitioners, preview };
}

export async function previewResetCheckins(service: RegistrationService) {
  return (await planReset(service)).preview;
}

export async function resetCheckins(service: RegistrationService): Promise<number> {
  const { entries, eventPractitioners } = await planReset(service);
  // References are checked before a transaction, so links are removed before the Practitioners are deleted.
  await service.store.transaction(entries);
  if (eventPractitioners.length) {
    await service.store.transaction(eventPractitioners.map(p => ({
      request: { method: 'DELETE', url: `Practitioner/${p.id}` }
    })));
  }
  const dashboard = await service.dashboard();
  const remaining = await service.store.search<Practitioner>('Practitioner', '_count=200');
  if (dashboard.totals.checkedIn !== 0 || remaining.some(p => p.identifier?.some(i => i.system === ID_SYSTEM))) {
    throw new AppError(503, 'Attendance reset could not be verified. Keep the app stopped and inspect the database.');
  }
  return eventPractitioners.length;
}
