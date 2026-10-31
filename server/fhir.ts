import type { Bundle, BundleEntry, Resource } from 'fhir/r4';
import { createHash, randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class FhirError extends AppError {
  constructor(status: number, message: string, public diagnostics?: string) { super(status, message); }
}
export interface FhirStore {
  read<T extends Resource>(type: T['resourceType'], id: string): Promise<T | undefined>;
  search<T extends Resource>(type: T['resourceType'], query: string): Promise<T[]>;
  transaction(entries: BundleEntry[]): Promise<void>;
}

export function resourceFingerprint(resources: Resource[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  const sorted = [...resources].sort((a, b) => `${a.resourceType}/${a.id}`.localeCompare(`${b.resourceType}/${b.id}`));
  return createHash('sha256').update(JSON.stringify(canonical(sorted))).digest('hex');
}

export function put(resource: Resource, createOnly = false): BundleEntry {
  if (!resource.id) throw new Error('A stable resource ID is required.');
  if (createOnly) {
    const identifier = 'identifier' in resource && Array.isArray(resource.identifier) ? resource.identifier[0] : undefined;
    return {
      fullUrl: `urn:uuid:${randomUUID()}`, resource,
      request: {
        method: 'POST', url: resource.resourceType,
        ...(identifier?.system && identifier.value ? { ifNoneExist: `identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}` } : {})
      }
    };
  }
  return {
    resource,
    request: {
      method: 'PUT', url: `${resource.resourceType}/${resource.id}`,
      ...(resource.meta?.versionId ? { ifMatch: `W/"${resource.meta.versionId}"` } : {})
    }
  };
}
