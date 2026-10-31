import { scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z, ZodError } from 'zod';
import { checkinSchema, detailsSchema, manualSchema, roleSchema, rosterEntrySchema, rosterRemovalSchema, rosterSourceSchema, tracks } from '../shared/domain.js';
import { checkinsCsv } from '../shared/export.js';
import { AppError, type FhirStore } from './fhir.js';
import { RegistrationService } from './registration.js';
import { importRoster, parseRoster } from './imports.js';
import { addRosterEntry, removeRosterEntry } from './roster.js';
import { repositoryRoot, type Config } from './config.js';

export async function buildApp(store: FhirStore, config: Config) {
  const app = Fastify({ bodyLimit: 1024 * 1024, logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] }, disableRequestLogging: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  const service = new RegistrationService(store, config.sessionSecret);
  const session = (request: FastifyRequest): string => {
    try {
      const user = service.verify(request.cookies.staff ?? '', 'staff');
      if (user !== config.staffUsername) throw new AppError(401, 'Staff login required.');
      return user;
    } catch { throw new AppError(401, 'Staff login required or session expired.'); }
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.publicUrl) {
        throw new AppError(403, 'This action must originate from the check-in website.');
      }
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    } else if (error instanceof AppError) {
      if (error.status >= 500) request.log.error({ message: error.message }, 'Backend operation failed');
      reply.code(error.status).send({ error: error.message });
    } else {
      request.log.error({ name: error.name, message: error.message }, 'Request failed');
      reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
        .send({ error: error.statusCode && error.statusCode < 500 ? error.message : 'An unexpected error occurred. Ask staff for assistance.' });
    }
  });
  app.get('/api/config', async () => ({ tracks, privacyUrl: config.privacyUrl }));
  app.get('/api/health', async () => {
    await service.list('hackathon-2026-checkins');
    return { status: 'ok' };
  });
  app.get('/api/matches', async request => {
    const query = z.object({ name: z.string().max(160), affiliation: z.string().max(160).default('') }).parse(request.query);
    return service.matches(query.name, query.affiliation);
  });
  app.post('/api/select', async request => service.select(z.object({ token: z.string().max(2048) }).parse(request.body).token));
  app.post('/api/checkin', async request => {
    const input = checkinSchema.parse(request.body);
    return service.checkin(input, input.selection);
  });
  app.post('/api/staff/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({ username: z.string().max(64), password: z.string().min(1).max(256) }).parse(request.body);
    const [salt, hash] = config.staffPasswordHash.split(':');
    const valid = timingSafeEqual(scryptSync(input.password, salt!, 64), Buffer.from(hash!, 'hex'));
    if (!valid || input.username !== config.staffUsername) throw new AppError(401, 'Incorrect staff username or password.');
    reply.setCookie('staff', service.sign(input.username, 'staff'), {
      httpOnly: true, sameSite: 'strict', secure: config.publicUrl.startsWith('https:'), path: '/api/staff', maxAge: 1800
    });
    return { username: input.username };
  });
  app.post('/api/staff/logout', async (_request, reply) => {
    reply.clearCookie('staff', { path: '/api/staff' });
    return { ok: true };
  });
  app.get('/api/staff/session', async request => ({ username: session(request) }));
  app.get('/api/staff/matches', async request => {
    session(request);
    const query = z.object({ name: z.string().max(160).default(''), affiliation: z.string().max(160).default('') }).parse(request.query);
    return service.matches(query.name, query.affiliation, true);
  });
  app.get('/api/staff/dashboard', async request => { session(request); return service.dashboard(); });
  app.post('/api/staff/select', async request => {
    session(request);
    const { token } = z.object({ token: z.string().max(2048) }).parse(request.body);
    const id = service.verify(token, 'candidate');
    return { ...await service.select(token), id, lists: await service.memberships(id) };
  });
  app.post('/api/staff/manual', async request => {
    const staff = session(request);
    const input = manualSchema.parse(request.body);
    return service.manual(input, input.role, input.reason, input.requestId, staff);
  });
  app.put('/api/staff/participants/:id', async request => {
    const staff = session(request);
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).parse(request.params);
    const input = detailsSchema.extend({ role: roleSchema, reason: z.string().trim().min(5).max(500) }).parse(request.body);
    await service.correct(id, input, input.role, input.reason, staff);
    return { ok: true };
  });
  app.post('/api/staff/import', async request => {
    session(request);
    const { source, csv } = z.object({ source: rosterSourceSchema, csv: z.string().min(1).max(900000) }).parse(request.body);
    return { imported: await importRoster(service, source, parseRoster(csv)) };
  });
  app.post('/api/staff/rosters/:source/participants', async request => {
    const staff = session(request);
    const { source } = z.object({ source: rosterSourceSchema }).parse(request.params);
    const input = rosterEntrySchema.parse(request.body);
    return addRosterEntry(service, source, input, input.reason, staff);
  });
  app.delete('/api/staff/rosters/:source/participants/:id', async request => {
    const staff = session(request);
    const { source, id } = z.object({ source: rosterSourceSchema, id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).parse(request.params);
    const { reason } = rosterRemovalSchema.parse(request.body);
    return removeRosterEntry(service, source, id, reason, staff);
  });
  app.get('/api/staff/receipts/:id', async request => {
    session(request);
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).parse(request.params);
    return service.receipt(id);
  });
  app.get('/api/staff/export', async (request, reply) => {
    session(request);
    const { rows } = await service.dashboard();
    reply.header('Content-Disposition', 'attachment; filename="hackathon-2026-checkins.csv"').type('text/csv; charset=utf-8');
    return checkinsCsv(rows);
  });
  const dist = resolve(repositoryRoot, 'dist');
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'API endpoint not found.' });
      return reply.sendFile('index.html');
    });
  }
  return { app, service };
}
