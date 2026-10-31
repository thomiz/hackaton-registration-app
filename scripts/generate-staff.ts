import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Bundle, Person } from 'fhir/r4';
import { agendaRoster, rosterCsv } from '../server/agenda.js';
import { repositoryRoot } from '../server/config.js';
import { person } from '../server/model.js';
import { CANONICAL, ROLE_SYSTEM } from '../shared/domain.js';

const source = process.argv[2];
if (!source) throw new Error('Usage: npm run staff:generate -- "D:\\path\\to\\hack-agenda.md"');
const { rows, warnings } = agendaRoster(await readFile(resolve(source), 'utf8'));
const bundle: Bundle<Person> = {
  resourceType: 'Bundle', type: 'collection',
  identifier: { system: `${CANONICAL}/identifier/seed`, value: 'agenda-staff-2026' },
  entry: rows.map(row => ({
    fullUrl: `${CANONICAL}/Person/${row.id}`,
    resource: person(row.id, row)
  }))
};
const directory = resolve(repositoryRoot, 'seed');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'staff.csv'), '\uFEFF' + rosterCsv(rows));
await writeFile(join(directory, 'staff-persons.json'), JSON.stringify(bundle, null, 2) + '\n');
await writeFile(join(directory, 'staff-source.json'), JSON.stringify({
  sourceRepository: 'HL7Norway/Norwegian-FHIR-Hackathon-2026',
  sourceFile: 'Norwegian-FHIR-hackathon-2026/input/pagecontent/hack-agenda.md',
  section: 'Track leads and partners',
  roleSystem: ROLE_SYSTEM,
  roleRule: 'Track-associated rows are track leads; Partner rows are attendees. Membership does not grant staff login.',
  count: rows.length,
  warnings
}, null, 2) + '\n');
for (const warning of warnings) console.warn(`REVIEW: ${warning}`);
console.log(`Generated ${rows.length} staff Persons and matching CSV in seed. No attendance was recorded.`);
