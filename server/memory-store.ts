import { randomUUID } from 'node:crypto';
import type { BundleEntry, Resource, Person, List } from 'fhir/r4';
import { FhirError, type FhirStore } from './fhir.js';

export class MemoryStore implements FhirStore {
  resources = new Map<string, Resource>();
  fail = false;
  conflicts = 0;
  async read<T extends Resource>(type: T['resourceType'], id: string): Promise<T | undefined> {
    return structuredClone(this.resources.get(`${type}/${id}`)) as T | undefined;
  }
  async search<T extends Resource>(type: T['resourceType'], query: string): Promise<T[]> {
    const params = new URLSearchParams(query);
    let items = [...this.resources.values()].filter(resource => resource.resourceType === type);
    for (const [key, value] of params) {
      if (key === '_count') continue;
      items = items.filter(resource => {
        if (key === 'identifier' && 'identifier' in resource && Array.isArray(resource.identifier)) {
          const [system, token] = value.split('|');
          return resource.identifier.some(i => i.system === system && i.value === token);
        }
        if (key === 'code' && 'code' in resource && resource.code && typeof resource.code === 'object' && 'coding' in resource.code) {
          const [system, token] = value.split('|');
          return (resource as List).code?.coding?.some(i => i.system === system && i.code === token);
        }
        if (key === 'link' && resource.resourceType === 'Person') return (resource as Person).link?.some(l => l.target.reference === value);
        return false;
      });
    }
    return structuredClone(items) as T[];
  }
  async transaction(entries: BundleEntry[]): Promise<void> {
    this.resources = this.apply(entries);
  }
  /** Validates a transaction against the current resources and returns the resulting state without committing it. */
  protected apply(entries: BundleEntry[]): Map<string, Resource> {
    if (this.fail) throw new FhirError(503, 'Injected transaction failure.');
    if (this.conflicts > 0) { this.conflicts--; throw new FhirError(409, 'Injected conflict.'); }
    const deletions = new Set(entries.filter(entry => entry.request?.method === 'DELETE').map(entry => entry.request!.url));
    const references = (value: unknown, target: string): boolean => {
      if (Array.isArray(value)) return value.some(item => references(item, target));
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(([key, item]) => key === 'reference' && item === target || references(item, target));
    };
    for (const target of deletions) {
      for (const [key, resource] of this.resources) {
        if (!deletions.has(key) && references(resource, target)) {
          throw new FhirError(409, 'Referential integrity violated: resource is still referenced before the transaction.');
        }
      }
    }
    const pending = new Map(this.resources);
    const now = new Date().toISOString();
    const aliases = new Map<string, string>();
    const creations = new Map<BundleEntry, string>();
    for (const entry of entries) {
      if (entry.request?.method === 'DELETE') continue;
      if (!entry.resource || !entry.request) throw new Error('Invalid transaction entry.');
      if (entry.request.method === 'POST') {
        const identifier = entry.request.ifNoneExist ? new URLSearchParams(entry.request.ifNoneExist).get('identifier') : undefined;
        const [system, value] = identifier?.split('|') ?? [];
        const existing = identifier ? [...pending.values()].find(r => r.resourceType === entry.resource!.resourceType &&
          'identifier' in r && Array.isArray(r.identifier) && r.identifier.some(i => i.system === system && i.value === value)) : undefined;
        const id = existing?.id ?? randomUUID();
        aliases.set(`${entry.resource.resourceType}/${entry.resource.id}`, `${entry.resource.resourceType}/${id}`);
        creations.set(entry, id);
      }
    }
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, key === 'reference' && typeof item === 'string' ? aliases.get(item) ?? item : rewrite(item)]));
      return value;
    };
    for (const entry of entries) {
      if (entry.request?.method === 'DELETE') {
        pending.delete(entry.request.url);
        continue;
      }
      const resource = rewrite(entry.resource) as Resource;
      if (creations.has(entry)) {
        resource.id = creations.get(entry)!;
        if (pending.has(`${resource.resourceType}/${resource.id}`)) continue;
      }
      const key = `${resource.resourceType}/${resource.id}`;
      const existing = pending.get(key);
      if (entry.request?.ifMatch && entry.request.ifMatch !== `W/"${existing?.meta?.versionId}"`) throw new FhirError(409, 'Version conflict.');
      resource.meta = { ...resource.meta, versionId: String(Number(existing?.meta?.versionId ?? 0) + 1), lastUpdated: now };
      pending.set(key, resource);
    }
    return pending;
  }
}
