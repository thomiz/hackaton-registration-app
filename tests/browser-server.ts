import { scryptSync } from 'node:crypto';
import { buildApp } from '../server/app';
import { MemoryStore } from './memory-store';
import { importRoster } from '../server/imports';
import type { Config } from '../server/config';

const salt = '0123456789abcdef0123456789abcdef';
const config: Config = {
  host: '127.0.0.1', port: 8099, publicUrl: 'http://localhost:8099', privacyUrl: 'https://example.invalid/privacy',
  dataDir: 'unused-in-memory',
  sessionSecret: 'synthetic-browser-test-secret-over-32-characters',
  staffUsername: 'organizer', staffPasswordHash: `${salt}:${scryptSync('synthetic-test-password', salt, 64).toString('hex')}`
};
const { app, service } = await buildApp(new MemoryStore(), config);
await service.initialize();
await importRoster(service, 'roster', [
  { id: 'test-alice', name: 'Alice Example', affiliation: 'Example Labs', email: 'alice@example.invalid', track: 'smart', role: 'attendee' },
  { id: 'test-alicia', name: 'Alicia Example', affiliation: 'Another Group', email: 'alicia@example.invalid', track: '', role: 'attendee' }
]);
await app.listen({ host: config.host, port: config.port });
console.log('SYNTHETIC TEST SERVER ONLY: all data is temporary and in memory. Not an event deployment.');
process.once('SIGINT', () => { void app.close(); });
process.once('SIGTERM', () => { void app.close(); });
