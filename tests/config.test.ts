import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { loadConfig, repositoryRoot } from '../server/config';

beforeEach(() => {
  const values = {
    SESSION_SECRET: 'synthetic-only-secret-over-32-characters', STAFF_USERNAME: 'organizer',
    STAFF_PASSWORD_HASH: `${'a'.repeat(32)}:${'b'.repeat(128)}`, HOST: '127.0.0.1', PUBLIC_URL: 'http://localhost:8080'
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
describe('configuration', () => {
  it('supports local workstation configuration with data in the application folder', () => {
    vi.stubEnv('DATA_DIR', '');
    expect(() => loadConfig()).toThrow('DATA_DIR');
    vi.stubEnv('DATA_DIR', undefined);
    expect(loadConfig(Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DATA_DIR')))).toMatchObject({
      host: '127.0.0.1', publicUrl: 'http://localhost:8080', dataDir: join(repositoryRoot, 'data')
    });
  });
  it('resolves a relative data directory against the application folder', () => {
    vi.stubEnv('DATA_DIR', 'private-data');
    expect(loadConfig().dataDir).toBe(join(repositoryRoot, 'private-data'));
  });
  it('rejects a missing session secret', () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => loadConfig()).toThrow('SESSION_SECRET');
  });
});
