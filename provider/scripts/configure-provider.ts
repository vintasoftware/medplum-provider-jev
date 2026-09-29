// Copies only explicitly public app settings from the root .env to provider/.env.local.
//
//   npm --prefix provider run configure

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnv } from './env-file.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_KEYS = [
  'MEDPLUM_BASE_URL',
  'MEDPLUM_PROJECT_ID',
  'MEDPLUM_CLIENT_ID',
  'MEDPLUM_CONSISTENCY_BOT_ID',
];
// Server-side secrets live in Medplum project Secrets. Vite would bundle them into public JS.
export const NEVER_COPY = [
  'TYPESAFE_API_KEY',
  'CONSISTENCY_MODAL_KEY',
  'CONSISTENCY_MODAL_SECRET',
  'MEDPLUM_CLIENT_SECRET',
];

export function configureProvider(root = REPO_ROOT, log: (line: string) => void = console.log): Record<string, string> {
  const source = readEnv(join(root, '.env'));
  const values: Record<string, string> = {};
  for (const key of PUBLIC_KEYS) {
    if (source[key]) {
      values[key] = source[key];
    }
  }
  if (!values.MEDPLUM_BASE_URL || !values.MEDPLUM_PROJECT_ID) {
    throw new Error('Set MEDPLUM_BASE_URL and MEDPLUM_PROJECT_ID in root .env (the setup command writes them)');
  }
  if (Object.values(values).some((v) => /[\n\r"$\\]/.test(v))) {
    throw new Error('Unexpected character in public configuration');
  }
  writeFileSync(
    join(root, 'provider', '.env.local'),
    Object.entries(values)
      .map(([k, v]) => `${k}="${v}"\n`)
      .join('')
  );
  const skipped = NEVER_COPY.filter((key) => source[key]);
  log(
    'Wrote public configuration to ignored provider/.env.local; no secrets were copied.' +
      (skipped.length ? ` Left ${skipped.join(', ')} out; the Bot reads it from Medplum project Secrets.` : '')
  );
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    configureProvider();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
