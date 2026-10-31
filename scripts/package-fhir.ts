import { readdir, readFile, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CANONICAL } from '../shared/domain.js';

const generated = resolve('fhir', 'fsh-generated', 'resources');
// The IG is versioned independently of the app: take its identity from the SUSHI configuration.
const sushiConfig = await readFile(resolve('fhir', 'sushi-config.yaml'), 'utf8');
const setting = (key: string) => {
  const value = sushiConfig.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  if (!value) throw new Error(`fhir/sushi-config.yaml has no ${key}.`);
  return value;
};
const name = setting('id');
const version = setting('version');
const output = resolve('fhir', 'output');
const staging = join(output, 'package');
await mkdir(staging, { recursive: true });
const previous = await readdir(staging);
for (const name of previous) {
  if (name.endsWith('.json')) await rm(join(staging, name));
}
for (const name of await readdir(generated)) {
  if (!name.endsWith('.json')) continue;
  const resource = JSON.parse(await readFile(join(generated, name), 'utf8')) as { resourceType: string };
  if (['StructureDefinition', 'CodeSystem', 'ValueSet'].includes(resource.resourceType)) {
    await copyFile(join(generated, name), join(staging, name));
  }
}
await writeFile(join(staging, 'package.json'), JSON.stringify({
  name, version, type: 'fhir.ig',
  canonical: CANONICAL, fhirVersions: ['4.0.1'], dependencies: { 'hl7.fhir.r4.core': '4.0.1' },
  title: name
}, null, 2));
const result = spawnSync('tar', ['-czf', join(output, 'package.tgz'), '-C', output, 'package'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('FHIR package archive creation failed.');
console.log('Built fhir\\output\\package.tgz');
