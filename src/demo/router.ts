// In-browser stand-in for the Fastify API (server/app.ts), used by the static demo build.
// It runs the real RegistrationService against an in-memory store seeded with the IG examples.
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { checkinSchema, detailsSchema, manualSchema, roleSchema, rosterEntrySchema, rosterRemovalSchema, rosterSourceSchema, tracks } from '../../shared/domain';
import { checkinsCsv } from '../../shared/export';
import { AppError } from '../../server/fhir';
import { MemoryStore } from '../../server/memory-store';
import { RegistrationService } from '../../server/registration';
import { addRosterEntry, removeRosterEntry } from '../../server/roster';
import { installBuffer } from './buffer';
import { demoResources } from './seed';

installBuffer();

type Demo = { service: RegistrationService; staff?: string };
let current: Promise<Demo> | undefined;

async function create(): Promise<Demo> {
  const store = new MemoryStore();
  for (const resource of demoResources()) store.resources.set(`${resource.resourceType}/${resource.id}`, resource);
  const service = new RegistrationService(store, randomUUID());
  await service.initialize();
  return { service };
}

const demo = () => current ??= create();
export function resetDemo(): void { current = undefined; }

const idSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) });

async function route(method: string, path: string, body: unknown): Promise<unknown> {
  const state = await demo();
  const { service } = state;
  const url = new URL(path, 'https://demo.invalid');
  const query = Object.fromEntries(url.searchParams);
  const staff = () => {
    if (!state.staff) throw new AppError(401, 'Staff login required or session expired.');
    return state.staff;
  };
  const participant = url.pathname.match(/^\/staff\/participants\/([^/]+)$/);
  const receipt = url.pathname.match(/^\/staff\/receipts\/([^/]+)$/);
  const rosterEntry = url.pathname.match(/^\/staff\/rosters\/([^/]+)\/participants(?:\/([^/]+))?$/);
  switch (`${method} ${url.pathname}`) {
    case 'GET /config': return { tracks, privacyUrl: '' };
    case 'GET /health': return { status: 'ok' };
    case 'GET /matches': {
      const input = z.object({ name: z.string().max(160), affiliation: z.string().max(160).default('') }).parse(query);
      return service.matches(input.name, input.affiliation);
    }
    case 'POST /select': return service.select(z.object({ token: z.string().max(2048) }).parse(body).token);
    case 'POST /checkin': {
      const input = checkinSchema.parse(body);
      return service.checkin(input, input.selection);
    }
    case 'POST /staff/login': {
      const input = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) }).parse(body);
      state.staff = input.username;
      return { username: input.username };
    }
    case 'POST /staff/logout': state.staff = undefined; return { ok: true };
    case 'GET /staff/session': return { username: staff() };
    case 'GET /staff/matches': {
      staff();
      const input = z.object({ name: z.string().max(160).default(''), affiliation: z.string().max(160).default('') }).parse(query);
      return service.matches(input.name, input.affiliation, true);
    }
    case 'GET /staff/dashboard': staff(); return service.dashboard();
    case 'POST /staff/select': {
      staff();
      const { token } = z.object({ token: z.string().max(2048) }).parse(body);
      const id = service.verify(token, 'candidate');
      return { ...await service.select(token), id, lists: await service.memberships(id) };
    }
    case 'POST /staff/manual': {
      const user = staff();
      const input = manualSchema.parse(body);
      return service.manual(input, input.role, input.reason, input.requestId, user);
    }
    case 'POST /staff/import': staff(); throw new AppError(501, 'CSV import is not available in the demo.');
  }
  if (participant && method === 'PUT') {
    const user = staff();
    const { id } = idSchema.parse({ id: decodeURIComponent(participant[1]!) });
    const input = detailsSchema.extend({ role: roleSchema, reason: z.string().trim().min(5).max(500) }).parse(body);
    await service.correct(id, input, input.role, input.reason, user);
    return { ok: true };
  }
  if (receipt && method === 'GET') {
    staff();
    return service.receipt(idSchema.parse({ id: decodeURIComponent(receipt[1]!) }).id);
  }
  if (rosterEntry && method === 'POST' && !rosterEntry[2]) {
    const user = staff();
    const source = rosterSourceSchema.parse(rosterEntry[1]);
    const input = rosterEntrySchema.parse(body);
    return addRosterEntry(service, source, input, input.reason, user);
  }
  if (rosterEntry && method === 'DELETE' && rosterEntry[2]) {
    const user = staff();
    const source = rosterSourceSchema.parse(rosterEntry[1]);
    const { id } = idSchema.parse({ id: decodeURIComponent(rosterEntry[2]) });
    return removeRosterEntry(service, source, id, rosterRemovalSchema.parse(body).reason, user);
  }
  throw new AppError(404, 'API endpoint not found.');
}

export async function demoApi<T>(path: string, body: unknown, method: string): Promise<T> {
  try {
    // Round-trip through JSON like a real HTTP request, so callers never share store objects.
    const result = await route(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    return JSON.parse(JSON.stringify(result)) as T;
  } catch (error) {
    if (error instanceof ZodError) throw new Error(error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    if (error instanceof AppError) throw new Error(error.message);
    console.error('Demo request failed', error);
    throw new Error('An unexpected error occurred in the demo.');
  }
}

export async function demoExportCsv(): Promise<string> {
  const state = await demo();
  if (!state.staff) throw new Error('Staff login required or session expired.');
  return checkinsCsv((await state.service.dashboard()).rows);
}
