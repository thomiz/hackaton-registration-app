import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// The application folder: the nearest directory with package.json, from source or compiled output.
export const repositoryRoot = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the application folder (package.json).');
    directory = parent;
  }
  return directory;
})();

export function loadConfig(environment?: NodeJS.ProcessEnv) {
  if (!environment) {
    // Values already set in the environment take precedence over .env.
    try { process.loadEnvFile(resolve(repositoryRoot, '.env')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    environment = process.env;
  }
  const schema = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    PUBLIC_URL: z.string().url().default('http://localhost:8080'),
    DATA_DIR: z.string().trim().min(1).default('data'),
    SESSION_SECRET: z.string().min(32),
    STAFF_USERNAME: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
    STAFF_PASSWORD_HASH: z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/),
    PRIVACY_NOTICE_URL: z.string().url().default('https://hl7norway.github.io/Norwegian-FHIR-Hackathon-2026/currentbuild/privacy.html')
  });
  const result = schema.safeParse(environment);
  if (!result.success) throw new Error(`Invalid environment configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const value = result.data;
  return {
    host: value.HOST, port: value.PORT, publicUrl: new URL(value.PUBLIC_URL).origin,
    privacyUrl: value.PRIVACY_NOTICE_URL,
    // Relative paths are resolved against the application folder, not the current directory.
    dataDir: resolve(repositoryRoot, value.DATA_DIR),
    sessionSecret: value.SESSION_SECRET, staffUsername: value.STAFF_USERNAME, staffPasswordHash: value.STAFF_PASSWORD_HASH
  };
}
export type Config = ReturnType<typeof loadConfig>;
