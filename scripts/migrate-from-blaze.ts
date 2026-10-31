// One-off migration: copies the event's FHIR resources from a running Blaze server into the JSON data file.
// Usage: npm run migrate:blaze -- [http://localhost:8090/fhir]
import type { Bundle, Resource } from 'fhir/r4';
import { loadConfig } from '../server/config.js';
import { JsonFileStore } from '../server/file-store.js';

const base = (process.argv[2] ?? 'http://localhost:8090/fhir').replace(/\/+$/, '');
const config = loadConfig();
const store = await JsonFileStore.open(config.dataDir, 'Blaze migration');
try {
  if (store.resources.size) throw new Error(`The data file in ${config.dataDir} already contains ${store.resources.size} resources. Migrate into an empty DATA_DIR.`);
  const resources = new Map<string, Resource>();
  for (const type of ['List', 'Person', 'Practitioner', 'AuditEvent']) {
    let url: string | undefined = `${base}/${type}?_count=500`;
    while (url) {
      const response = await fetch(url, { headers: { accept: 'application/fhir+json' } });
      if (!response.ok) throw new Error(`Blaze returned HTTP ${response.status} for ${type}.`);
      const bundle = await response.json() as Bundle;
      for (const entry of bundle.entry ?? []) {
        if (entry.resource?.resourceType === type && entry.resource.id) resources.set(`${type}/${entry.resource.id}`, entry.resource);
      }
      url = bundle.link?.find(link => link.relation === 'next')?.url;
    }
    console.log(`${type}: ${[...resources.keys()].filter(key => key.startsWith(`${type}/`)).length}`);
  }
  await store.batch(async () => { store.resources = resources; });
  console.log(`Migrated ${resources.size} resources to ${store.paths.file}. Blaze was not changed.`);
} finally { await store.close(); }
