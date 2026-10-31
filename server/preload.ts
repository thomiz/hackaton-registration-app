import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LISTS } from '../shared/domain.js';
import { repositoryRoot } from './config.js';
import { importRoster, parseRoster } from './imports.js';
import { refs } from './model.js';
import type { RegistrationService } from './registration.js';

export async function preloadStaff(service: RegistrationService, file = resolve(repositoryRoot, 'seed', 'staff.csv')): Promise<number> {
  const list = await service.list(LISTS.staff);
  if (refs(list).length) return 0;
  const rows = parseRoster(await readFile(file, 'utf8'));
  return importRoster(service, 'staff', rows);
}
