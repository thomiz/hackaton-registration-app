import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle, Person } from 'fhir/r4';
import { JsonFileStore, readStore } from '../server/file-store';
import { put } from '../server/fhir';
import { importRoster } from '../server/imports';
import { RegistrationService } from '../server/registration';

const person = (id: string, name = 'Alice Example'): Person => ({ resourceType: 'Person', id, name: [{ text: name }] });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkin-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('JSON file FHIR store', () => {
  it('persists transactions as a FHIR collection Bundle and reloads them', async () => {
    const store = await JsonFileStore.open(dir);
    await store.transaction([put(person('a'))]);
    await store.close();
    const bundle = JSON.parse(await readFile(join(dir, 'fhir-store.json'), 'utf8')) as Bundle;
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Person', id: 'a', meta: { versionId: '1' } } }] });
    const reopened = await JsonFileStore.open(dir);
    expect(await reopened.read<Person>('Person', 'a')).toMatchObject({ name: [{ text: 'Alice Example' }] });
    await reopened.close();
  });
  it('allows only one process to open the data and recovers a stale lock', async () => {
    const store = await JsonFileStore.open(dir);
    await expect(JsonFileStore.open(dir, 'second app')).rejects.toThrow(/in use by check-in app \(PID \d+\)/);
    await store.close();
    await writeFile(join(dir, 'fhir-store.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, purpose: 'crashed app' }));
    const recovered = await JsonFileStore.open(dir);
    await recovered.close();
  });
  it('serializes concurrent writers and rejects stale versions without losing updates', async () => {
    const store = await JsonFileStore.open(dir);
    await store.transaction([put(person('a'))]);
    const current = (await store.read<Person>('Person', 'a'))!;
    const results = await Promise.allSettled([
      store.transaction([put({ ...current, name: [{ text: 'First' }] } as Person)]),
      store.transaction([put({ ...current, name: [{ text: 'Second' }] } as Person)])
    ]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    await store.close();
    expect((await (await readStore(dir)).read<Person>('Person', 'a'))!.name?.[0]?.text).toBe('First');
  });
  it('keeps both simultaneous check-ins through the registration service', async () => {
    const store = await JsonFileStore.open(dir);
    const service = new RegistrationService(store, 'synthetic-store-test-secret-over-32-characters');
    await service.initialize();
    await importRoster(service, 'roster', [
      { id: 'alice', name: 'Alice Example', email: 'alice@example.invalid', affiliation: 'Synthetic', track: '', role: 'attendee' },
      { id: 'bob', name: 'Robert Sample', email: 'bob@example.invalid', affiliation: 'Other', track: '', role: 'attendee' }
    ]);
    const a = await service.select((await service.matches('Alice Example'))[0]!.token);
    const b = await service.select((await service.matches('Robert Sample'))[0]!.token);
    await Promise.all([service.checkin(a, a.selection), service.checkin(b, b.selection)]);
    await store.close();
    const reloaded = new RegistrationService(await readStore(dir), 'synthetic-store-test-secret-over-32-characters');
    expect((await reloaded.dashboard()).totals.checkedIn).toBe(2);
  });
  it('writes a batch atomically and discards it entirely on failure', async () => {
    const store = await JsonFileStore.open(dir);
    await store.transaction([put(person('a'))]);
    const before = await readFile(store.paths.file, 'utf8');
    await expect(store.batch(async () => {
      await store.transaction([put(person('b'))]);
      throw new Error('Verification failed');
    })).rejects.toThrow('Verification failed');
    expect(await readFile(store.paths.file, 'utf8')).toBe(before);
    expect(await store.read('Person', 'b')).toBeUndefined();
    await store.batch(async () => {
      await store.transaction([put(person('b'))]);
      await store.transaction([put(person('c'))]);
    });
    await store.close();
    expect((await readStore(dir)).resources.size).toBe(3);
  });
  it('keeps the previous file when a write fails and refuses a corrupt file', async () => {
    const store = await JsonFileStore.open(dir);
    await store.transaction([put(person('a'))]);
    store.fail = true;
    await expect(store.transaction([put(person('b'))])).rejects.toThrow('Injected');
    store.fail = false;
    await store.transaction([put(person('c'))]);
    await store.close();
    expect([...(await readStore(dir)).resources.keys()]).toEqual(['Person/a', 'Person/c']);
    await writeFile(join(dir, 'fhir-store.json'), '{"resourceType":"Bundle","entry":[{');
    await expect(JsonFileStore.open(dir)).rejects.toThrow('not valid JSON');
    await JsonFileStore.open(dir).catch(() => undefined);
    // The lock is released after a refused open.
    await writeFile(join(dir, 'fhir-store.json'), '{"resourceType":"Bundle","type":"collection"}');
    await (await JsonFileStore.open(dir)).close();
  });
});
