import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../scripts/configure-provider.ts';
import { readEnv } from '../scripts/env-file.ts';
import { parseWhoami } from '../scripts/setup-medplum.ts';

// Signs the tests in with the Medplum CLI login. The access token stays in this process's
// environment, which Playwright passes to its workers; it is never written to disk.
export default function globalSetup(): void {
  const profile = process.env.E2E_MEDPLUM_PROFILE;
  const cli = (args: string[]): string =>
    execFileSync('npx', ['medplum', ...args, ...(profile ? ['-p', profile] : [])], {
      cwd: join(REPO_ROOT, 'provider'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let whoami: string;
  let token: string;
  try {
    whoami = cli(['whoami']);
    token = cli(['token']).trim().split(/\s+/).at(-1) as string;
  } catch {
    throw new Error('The Medplum CLI session is missing or expired. Log in: npx --prefix provider medplum login');
  }
  const session = parseWhoami(whoami);
  const envProject = readEnv(join(REPO_ROOT, '.env')).MEDPLUM_PROJECT_ID;
  if (envProject !== session.projectId) {
    throw new Error(
      `The CLI is logged in to ${session.projectId} but .env uses ${envProject}. Run npm --prefix provider run setup.`
    );
  }
  const profileRef = /\((Practitioner\/[A-Za-z0-9-]+)\)/.exec(session.user)?.[1];
  if (!profileRef) {
    throw new Error('The CLI login must be a Practitioner to run the guided demo');
  }
  process.env.E2E_MEDPLUM_BASE_URL = session.baseUrl;
  process.env.E2E_MEDPLUM_PROJECT = `Project/${session.projectId}`;
  process.env.E2E_MEDPLUM_PROFILE_REF = profileRef;
  process.env.E2E_MEDPLUM_TOKEN = token;
}
