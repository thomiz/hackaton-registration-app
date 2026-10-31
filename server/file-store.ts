import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bundle, BundleEntry, Resource } from 'fhir/r4';
import { FhirError } from './fhir.js';
import { MemoryStore } from './memory-store.js';

export const STORE_FILE = 'fhir-store.json';
export const LOCK_FILE = 'fhir-store.lock';

const hasCode = (error: unknown, ...codes: string[]) => error instanceof Error && 'code' in error && codes.includes(String(error.code));
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

export function storePaths(dataDir: string) {
  const directory = resolve(dataDir);
  return { directory, file: join(directory, STORE_FILE), lock: join(directory, LOCK_FILE) };
}

/** Parses a snapshot file, refusing anything that is not a Bundle of identified resources. */
export function parseSnapshot(text: string): Map<string, Resource> {
  let bundle: Bundle;
  try { bundle = JSON.parse(text) as Bundle; }
  catch { throw new FhirError(503, 'The FHIR data file is not valid JSON. Restore it from a backup; do not delete it.'); }
  if (bundle?.resourceType !== 'Bundle' || !Array.isArray(bundle.entry ?? [])) {
    throw new FhirError(503, 'The FHIR data file is not a FHIR Bundle. Restore it from a backup; do not delete it.');
  }
  const resources = new Map<string, Resource>();
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource?.resourceType || !resource.id) throw new FhirError(503, 'The FHIR data file contains a resource without type or ID.');
    resources.set(`${resource.resourceType}/${resource.id}`, resource);
  }
  return resources;
}

export function snapshot(resources: Map<string, Resource>): Bundle {
  return {
    resourceType: 'Bundle', type: 'collection', timestamp: new Date().toISOString(),
    entry: [...resources.values()].map(resource => ({ resource }))
  };
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Loads a snapshot without taking the lock, for read-only reporting while the app may be running. */
export async function readStore(dataDir: string): Promise<MemoryStore> {
  const store = new MemoryStore();
  try { store.resources = parseSnapshot(await readFile(storePaths(dataDir).file, 'utf8')); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  return store;
}

/**
 * FHIR resources kept in memory and persisted as one FHIR collection Bundle.
 * Each transaction is validated in memory (versions, conditional creates, references), written to a
 * temporary file, flushed and atomically renamed over the previous snapshot, then made visible.
 * Transactions are serialized, and an exclusive lock file prevents a second process from opening the data.
 */
export class JsonFileStore extends MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private batching = false;
  private released = false;
  private readonly exitHandler = () => { this.releaseSync(); };

  private constructor(readonly paths: ReturnType<typeof storePaths>) { super(); }

  static async open(dataDir: string, purpose = 'check-in app'): Promise<JsonFileStore> {
    const store = new JsonFileStore(storePaths(dataDir));
    await mkdir(store.paths.directory, { recursive: true });
    await store.acquire(purpose);
    try {
      store.resources = parseSnapshot(await readFile(store.paths.file, 'utf8'));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) { await store.close(); throw error; }
    }
    return store;
  }

  private async acquire(purpose: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.paths.lock, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() })); }
        finally { await handle.close(); }
        process.once('exit', this.exitHandler);
        return;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        const holder = await readFile(this.paths.lock, 'utf8').then(text => JSON.parse(text) as { pid?: number; purpose?: string }).catch(() => ({}) as { pid?: number; purpose?: string });
        if (attempt === 0 && holder.pid && !processAlive(holder.pid)) {
          await unlink(this.paths.lock).catch(() => undefined);
          continue;
        }
        throw new FhirError(409, `The data in ${this.paths.directory} is in use by ${holder.purpose ?? 'another process'}` +
          `${holder.pid ? ` (PID ${holder.pid})` : ''}. Stop it first (Ctrl+C in its window). ` +
          `If no app or command is running, delete ${this.paths.lock}.`);
      }
    }
  }

  override async transaction(entries: BundleEntry[]): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.released) throw new FhirError(503, 'The FHIR data store is closed.');
      const pending = this.apply(entries);
      if (!this.batching) await this.persist(pending);
      this.resources = pending;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs several transactions as one unit: either all are written to disk together or none are. */
  async batch<T>(action: () => Promise<T>): Promise<T> {
    await this.queue;
    const before = this.resources;
    this.batching = true;
    try {
      const result = await action();
      this.batching = false;
      await this.persist(this.resources);
      return result;
    } catch (error) {
      this.resources = before;
      throw error;
    } finally { this.batching = false; }
  }

  private async persist(resources: Map<string, Resource>): Promise<void> {
    const temporary = `${this.paths.file}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot(resources)));
      await handle.sync();
    } finally { await handle.close(); }
    // Antivirus or indexing tools on Windows can briefly hold the target file open.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, this.paths.file); return; }
      catch (error) {
        if (attempt >= 20 || !hasCode(error, 'EPERM', 'EACCES', 'EBUSY')) {
          await unlink(temporary).catch(() => undefined);
          throw new FhirError(503, `Could not save the FHIR data file; the change was not applied. ${error instanceof Error ? error.message : ''}`);
        }
        await delay(25 * (attempt + 1));
      }
    }
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.released) return;
    this.released = true;
    process.removeListener('exit', this.exitHandler);
    await unlink(this.paths.lock).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
  }

  private releaseSync(): void {
    if (this.released) return;
    this.released = true;
    try { unlinkSync(this.paths.lock); } catch { /* already removed */ }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return hasCode(error, 'EPERM'); }
}
