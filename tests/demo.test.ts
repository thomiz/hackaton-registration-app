import { existsSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as shim from '../src/demo/node-crypto';
import { DemoBuffer } from '../src/demo/buffer';
import { demoApi, demoExportCsv, resetDemo } from '../src/demo/router';
import type { Candidate, Confirmation, Dashboard, RosterChange, Selection } from '../shared/domain';

describe('demo node:crypto and Buffer shims', () => {
  it('match Node SHA-256 and HMAC-SHA-256', () => {
    for (const input of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'æøå 🦊 '.repeat(40)]) {
      expect(shim.createHash('sha256').update(input).digest('hex')).toBe(createHash('sha256').update(input).digest('hex'));
      for (const key of ['secret', 'k'.repeat(100)]) {
        expect(shim.createHmac('sha256', key).update(input).digest('base64url')).toBe(createHmac('sha256', key).update(input).digest('base64url'));
      }
    }
  });
  it('round-trips base64url like Buffer', () => {
    const json = JSON.stringify({ id: 'abc', purpose: 'candidate', name: 'Ærlig Østby' });
    const encoded = DemoBuffer.from(json).toString('base64url');
    expect(encoded).toBe(Buffer.from(json).toString('base64url'));
    expect(DemoBuffer.from(encoded, 'base64url').toString()).toBe(json);
    const digest = shim.createHmac('sha256', 'secret').update('value').digest();
    expect(shim.timingSafeEqual(DemoBuffer.from(digest.toString('base64url'), 'base64url'), digest)).toBe(true);
  });
});

describe.skipIf(!existsSync('fhir/fsh-generated/resources'))('demo backend seeded with IG examples', () => {
  beforeEach(() => resetDemo());

  it('checks in an attendee from the IG example roster', async () => {
    const [robin] = await demoApi<Candidate[]>('/matches?name=Robin+Sample&affiliation=', undefined, 'GET');
    expect(robin).toMatchObject({ name: 'Robin Sample', alreadyCheckedIn: false });
    const selected = await demoApi<Selection>('/select', { token: robin!.token }, 'POST');
    const receipt = await demoApi<Confirmation>('/checkin', { ...selected, track: 'smart' }, 'POST');
    expect(receipt).toMatchObject({ name: 'Robin Sample', role: 'attendee', track: 'smart', alreadyCheckedIn: false });
    const [again] = await demoApi<Candidate[]>('/matches?name=Robin+Sample', undefined, 'GET');
    expect(again?.alreadyCheckedIn).toBe(true);
  });

  it('starts with linked example Practitioners checked in', async () => {
    const [jamie] = await demoApi<Candidate[]>('/matches?name=Jamie+Learner', undefined, 'GET');
    expect(jamie).toMatchObject({ name: 'Jamie Learner', alreadyCheckedIn: true });
  });

  it('serves the organizer screen', async () => {
    await expect(demoApi('/staff/dashboard', undefined, 'GET')).rejects.toThrow('login required');
    await demoApi('/staff/login', { username: 'demo', password: 'demo' }, 'POST');
    const before = await demoApi<Dashboard>('/staff/dashboard', undefined, 'GET');
    expect(before.totals.roster).toBeGreaterThan(0);
    expect(before.totals.staff).toBeGreaterThan(0);
    expect(before.rows.map(row => row.name)).toContain('Alex Example');

    const manual = await demoApi<Confirmation>('/staff/manual', {
      name: 'Walk In', email: 'walk-in@example.invalid', affiliation: 'Synthetic walk-in org', track: '',
      role: 'attendee', reason: 'Demo walk-in', requestId: randomUUID()
    }, 'POST');
    expect(manual.alreadyCheckedIn).toBe(false);
    const after = await demoApi<Dashboard>('/staff/dashboard', undefined, 'GET');
    expect(after.totals.checkedIn).toBe(before.totals.checkedIn + 1);
    expect(after.totals.manual).toBe(before.totals.manual + 1);
    expect(await demoExportCsv()).toContain('Walk In');
    await expect(demoApi('/staff/import', { source: 'roster', csv: 'x' }, 'POST')).rejects.toThrow('not available in the demo');

    const added = await demoApi<RosterChange>('/staff/rosters/roster/participants', {
      name: 'Late Signup', email: 'late@example.invalid', affiliation: 'Synthetic late org', track: '', role: 'attendee', reason: 'Demo late sign-up'
    }, 'POST');
    expect(added).toMatchObject({ created: true, lists: ['roster'] });
    expect((await demoApi<Dashboard>('/staff/dashboard', undefined, 'GET')).totals.roster).toBe(after.totals.roster + 1);
    const [late] = await demoApi<Candidate[]>('/matches?name=Late+Signup', undefined, 'GET');
    expect(late).toMatchObject({ name: 'Late Signup', alreadyCheckedIn: false });
    const removed = await demoApi<RosterChange>(`/staff/rosters/roster/participants/${added.personId}`, { reason: 'Demo cancellation' }, 'DELETE');
    expect(removed.lists).toEqual([]);
    expect(await demoApi<Candidate[]>('/matches?name=Late+Signup', undefined, 'GET')).toEqual([]);
  });
});
