import { scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { MemoryStore } from './memory-store';
import { importRoster } from '../server/imports';
import type { Config } from '../server/config';
import type { Selection } from '../shared/domain';

const salt = '0123456789abcdef0123456789abcdef';
export const config: Config = {
  host: '127.0.0.1', port: 8080, publicUrl: 'http://localhost:8080', privacyUrl: 'https://example.invalid/privacy',
  dataDir: 'unused-in-memory',
  sessionSecret: 'only-for-tests-secret-at-least-32-characters',
  staffUsername: 'organizer', staffPasswordHash: `${salt}:${scryptSync('test-password', salt, 64).toString('hex')}`
};
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); });
async function setup() {
  const result = await buildApp(new MemoryStore(), config);
  app = result.app;
  await result.service.initialize();
  return result;
}
const origin = { origin: config.publicUrl };
async function login() {
  const response = await app!.inject({ method: 'POST', url: '/api/staff/login', headers: origin, payload: { username: 'organizer', password: 'test-password' } });
  return response.cookies[0]!.value;
}
describe('HTTP authorization and input boundaries', () => {
  it('rejects unauthenticated staff operations', async () => {
    await setup();
    expect((await app!.inject('/api/staff/dashboard')).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/staff/manual', headers: origin, payload: {} })).statusCode).toBe(401);
  });
  it('rejects cross-origin mutation and wrong passwords', async () => {
    await setup();
    expect((await app!.inject({ method: 'POST', url: '/api/staff/login', headers: { origin: 'https://evil.invalid' }, payload: {} })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/staff/login', headers: origin, payload: { username: 'organizer', password: 'bad' } })).statusCode).toBe(401);
  });
  it('supports authenticated dashboard and manual check-in with validation', async () => {
    await setup();
    const staff = await login();
    const response = await app!.inject({
      method: 'POST', url: '/api/staff/manual', headers: origin, cookies: { staff },
      payload: { name: 'Synthetic Visitor', email: 'visitor@example.invalid', affiliation: 'Test', track: '', role: 'attendee', reason: 'Not in either list', requestId: 'd013a848-0639-4824-a97a-5d457e42ab21' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Synthetic Visitor', track: '', role: 'attendee', alreadyCheckedIn: false });
    const receiptUrl = `/api/staff/receipts/${response.json().receiptId}`;
    expect((await app!.inject(receiptUrl)).statusCode).toBe(401);
    const receipt = await app!.inject({ url: receiptUrl, cookies: { staff } });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual({ ...response.json(), alreadyCheckedIn: true });
    expect(receipt.headers['cache-control']).toBe('no-store');
    expect((await app!.inject({ url: '/api/staff/receipts/missing', cookies: { staff } })).statusCode).toBe(404);
    const exported = await app!.inject({ url: '/api/staff/export', cookies: { staff } });
    expect(exported.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('name,email,affiliation,track,role,arrived');
    expect((await app!.inject('/api/health')).json()).toEqual({ status: 'ok' });
    const dashboard = await app!.inject({ url: '/api/staff/dashboard', cookies: { staff } });
    expect(dashboard.json().totals.manual).toBe(1);
    expect(dashboard.headers['cache-control']).toBe('no-store');
    expect((await app!.inject({ method: 'POST', url: '/api/checkin', headers: origin, payload: { email: 'bad' } })).statusCode).toBe(400);
  });
  it('provides public matching summaries and explicit selection', async () => {
    const { service } = await setup();
    await importRoster(service, 'roster', [{ id: 'test', name: 'Alice Example', email: 'test@example.invalid', affiliation: 'Example', role: 'attendee', track: 'smart' }]);
    const match = await app!.inject('/api/matches?name=Alice');
    expect(match.json()[0]).not.toHaveProperty('email');
    expect(match.json()[0].alreadyCheckedIn).toBe(false);
    const selected = await app!.inject({ method: 'POST', url: '/api/select', headers: origin, payload: { token: match.json()[0].token } });
    expect(selected.json().email).toBe('test@example.invalid');
    const checkin = await app!.inject({ method: 'POST', url: '/api/checkin', headers: origin, payload: { ...selected.json<Selection>(), track: 'ehds-summary' } });
    expect(checkin.statusCode).toBe(200);
    expect(checkin.json()).toMatchObject({ name: 'Alice Example', email: 'test@example.invalid', track: 'ehds-summary' });
    expect((await app!.inject('/api/matches?name=Alice')).json()[0].alreadyCheckedIn).toBe(true);
    const staff = await login();
    expect((await app!.inject({ url: '/api/staff/matches?name=Alice', cookies: { staff } })).json()[0].alreadyCheckedIn).toBe(true);
    const again = await app!.inject({ method: 'POST', url: '/api/checkin', headers: origin, payload: selected.json() });
    expect(again.json()).toEqual({ ...checkin.json(), alreadyCheckedIn: true });
  });
  it('imports an attendee export without IDs through the staff endpoint and safely reimports it', async () => {
    const { service } = await setup();
    const staff = await login();
    const csv = 'E-postadresse,Your name,Your affiliation/employer,What primary track do you want to attend?\nalice@example.invalid,Alice Example,Example Labs,SMART on FHIR';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app!.inject({
        method: 'POST', url: '/api/staff/import', headers: origin, cookies: { staff }, payload: { source: 'roster', csv }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ imported: 1 });
    }
    expect((await service.dashboard()).totals).toMatchObject({ roster: 1, checkedIn: 0, attendees: 0 });
    expect(await service.matches('Alice')).toHaveLength(1);
    const response = await app!.inject({
      method: 'POST', url: '/api/staff/import', headers: origin, cookies: { staff },
      payload: { source: 'roster', csv: csv.replace('alice@example.invalid,Alice Example', 'bob@example.invalid,Bob Example') }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ imported: 1 });
    expect((await service.dashboard()).totals).toMatchObject({ roster: 1, checkedIn: 0 });
    expect(await service.matches('Alice')).toHaveLength(0);
    expect(await service.matches('Bob Example')).toHaveLength(1);
  });
  it('adds and removes single roster participants through audited staff endpoints', async () => {
    const { service } = await setup();
    await importRoster(service, 'staff', [{ id: 'lead', name: 'Lead Example', email: 'lead@example.invalid', affiliation: 'Example', role: 'track-lead', track: 'smart' }]);
    const payload = { name: 'Late Signup', email: 'late@example.invalid', affiliation: 'Example', track: 'smart', role: 'attendee', reason: 'Signed up by email this morning' };
    expect((await app!.inject({ method: 'POST', url: '/api/staff/rosters/roster/participants', headers: origin, payload })).statusCode).toBe(401);
    const staff = await login();
    expect((await app!.inject({ method: 'POST', url: '/api/staff/rosters/other/participants', headers: origin, cookies: { staff }, payload })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'POST', url: '/api/staff/rosters/roster/participants', headers: origin, cookies: { staff }, payload: { ...payload, reason: 'x' } })).statusCode).toBe(400);
    const added = await app!.inject({ method: 'POST', url: '/api/staff/rosters/roster/participants', headers: origin, cookies: { staff }, payload });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ created: true, lists: ['roster'] });
    expect((await app!.inject({ method: 'POST', url: '/api/staff/rosters/roster/participants', headers: origin, cookies: { staff }, payload })).statusCode).toBe(409);
    expect((await service.dashboard()).totals).toMatchObject({ roster: 1, staff: 1, checkedIn: 0 });
    const [match] = (await app!.inject({ url: '/api/staff/matches?name=Late', cookies: { staff } })).json();
    const selected = await app!.inject({ method: 'POST', url: '/api/staff/select', headers: origin, cookies: { staff }, payload: { token: match.token } });
    expect(selected.json()).toMatchObject({ id: added.json().personId, lists: ['roster'], email: 'late@example.invalid' });
    const removeUrl = `/api/staff/rosters/roster/participants/${added.json().personId}`;
    expect((await app!.inject({ method: 'DELETE', url: removeUrl, headers: origin, payload: { reason: 'Cancelled by email' } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'DELETE', url: removeUrl, headers: { origin: 'https://evil.invalid' }, cookies: { staff }, payload: { reason: 'Cancelled by email' } })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'DELETE', url: removeUrl, headers: origin, cookies: { staff }, payload: { reason: 'x' } })).statusCode).toBe(400);
    const removed = await app!.inject({ method: 'DELETE', url: removeUrl, headers: origin, cookies: { staff }, payload: { reason: 'Cancelled by email' } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ personId: added.json().personId, lists: [] });
    expect((await app!.inject({ method: 'DELETE', url: removeUrl, headers: origin, cookies: { staff }, payload: { reason: 'Cancelled by email' } })).statusCode).toBe(404);
    expect((await service.dashboard()).totals).toMatchObject({ roster: 0, staff: 1 });
    expect(await service.matches('Late Signup')).toHaveLength(0);
  });
});
