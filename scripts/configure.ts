import { randomBytes, scryptSync } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { repositoryRoot } from '../server/config.js';

const envFile = join(repositoryRoot, '.env');

try {
  await access(envFile);
  throw new Error('.env already exists. Edit it manually; refusing to overwrite credentials.');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const prompt = createInterface({ input: process.stdin, output: process.stdout });
let password: string;
try {
  console.log('This local setup prompt displays input. Run it privately; use a unique event staff password.');
  password = await prompt.question('Staff password (at least 12 characters): ');
} finally { prompt.close(); }
if (password.length < 12) throw new Error('Password must have at least 12 characters.');
const salt = randomBytes(16).toString('hex');
const values: Record<string, string> = {
  SESSION_SECRET: randomBytes(32).toString('hex'),
  STAFF_PASSWORD_HASH: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
};
const template = await readFile(join(repositoryRoot, '.env.example'), 'utf8');
await writeFile(envFile, template.replace(/^([A-Z_]+)=(.*)$/gm, (line, key: string) => key in values ? `${key}=${values[key]}` : line), { flag: 'wx', mode: 0o600 });
console.log('Created .env with generated secrets. Restrict its Windows file permissions to event operators.');
console.log('Next start the app with "npm run ops -- start". See README.md.');
