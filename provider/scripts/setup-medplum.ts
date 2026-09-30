// Sets up a Medplum project for the guided demo in one command.
//
//   npm --prefix provider run setup -- --dry-run
//   npm --prefix provider run setup -- --email you+tester@example.com
//
// Uses the Medplum CLI login (`npx --prefix provider medplum login`); no client secret is
// needed. Every step reads the server first and only creates or changes what is missing, so
// running it again is safe. Nothing is ever deleted. --dry-run prints the plan and writes
// nothing.

import type { MedplumClient, PatchOperation, WithId } from '@medplum/core';
import { MedplumClient as Client } from '@medplum/core';
import type { AccessPolicy, Bot, Project, ProjectMembership, ProjectSetting } from '@medplum/fhirtypes';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configureProvider, REPO_ROOT } from './configure-provider.ts';
import { readEnv, setEnvKeys } from './env-file.ts';

export const BOT_NAME = 'healthcare-consistency';
export const BACKEND = 'typesafe';
const PROVIDER = join(REPO_ROOT, 'provider');
const ENV_FILE = join(REPO_ROOT, '.env');
const POLICY_FILE = join(REPO_ROOT, 'demo', 'access-policy.json');
const BOT_CONFIG_FILE = join(PROVIDER, 'medplum.config.json');
const BOT_CONFIG = { name: BOT_NAME, source: 'bots/consistency.ts', dist: 'bot-dist/consistency-bot.mjs' };

export class SetupError extends Error {}

/**
 * JSON with sorted object keys, so comparisons ignore key order.
 * @param value - Any JSON value.
 * @returns The canonical JSON text.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

export interface SetupOptions {
  medplum: MedplumClient;
  projectId: string;
  apply: boolean;
  log?: (line: string) => void;
  /** Returns the TypeSafe key; called only when the secret must be created. */
  typesafeKey?: () => Promise<string>;
  /** Builds, smoke-tests and deploys the Bot code. */
  deployBot?: () => void;
  botConfigFile?: string;
  policy?: AccessPolicy;
}

export class Setup {
  readonly medplum: MedplumClient;
  readonly projectId: string;
  readonly apply: boolean;
  readonly log: (line: string) => void;
  readonly options: SetupOptions;

  constructor(options: SetupOptions) {
    this.options = options;
    this.medplum = options.medplum;
    this.projectId = options.projectId;
    this.apply = options.apply;
    this.log = options.log ?? console.log;
  }

  ok(text: string): void {
    this.log(`  ok    ${text}`);
  }

  // Reports a change; returns whether to make it.
  change(text: string): boolean {
    this.log(`  ${this.apply ? 'do   ' : 'would'} ${text}`);
    return this.apply;
  }

  async checkProject(): Promise<WithId<Project>> {
    const project = await this.medplum.readResource('Project', this.projectId);
    if (!project.features?.includes('bots')) {
      throw new SetupError('Bots are not enabled for this project. Enable them in Medplum, then run again.');
    }
    this.ok(`project "${project.name}" has Bots enabled`);
    return project;
  }

  async ensureBot(): Promise<WithId<Bot> | undefined> {
    const bots = await this.medplum.searchResources('Bot', { name: BOT_NAME }, { cache: 'no-cache' });
    const named = bots.filter((b) => b.name === BOT_NAME);
    if (named.length > 1) {
      throw new SetupError(`${named.length} Bots are named ${BOT_NAME}; keep one and run again.`);
    }
    let bot: WithId<Bot> | undefined = named[0];
    if (bot) {
      this.ok(`Bot ${BOT_NAME} exists (${bot.id})`);
    } else if (this.change(`create Bot ${BOT_NAME}`)) {
      const created = await this.medplum.post(`admin/projects/${this.projectId}/bot`, {
        name: BOT_NAME,
        description: 'Guided demo consistency check',
      });
      bot = await this.medplum.readResource('Bot', created.id as string);
    } else {
      return undefined;
    }
    if (bot.runAsUser === true) {
      this.ok('Bot runs as the calling user');
    } else if (this.change('set runAsUser: true on the Bot')) {
      bot = await this.medplum.patchResource('Bot', bot.id, [{ op: 'add', path: '/runAsUser', value: true }]);
    }
    return bot;
  }

  writeBotConfig(botId: string | undefined): void {
    const path = this.options.botConfigFile ?? BOT_CONFIG_FILE;
    const config = { bots: [{ ...BOT_CONFIG, id: botId ?? '<created on apply>' }] };
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current && canonical(JSON.parse(current)) === canonical(config)) {
      this.ok('provider/medplum.config.json points at the Bot');
    } else if (this.change('write provider/medplum.config.json (ignored by Git)')) {
      writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    }
  }

  deployBot(): void {
    if (this.change('build, smoke-test and deploy the Bot code (npm run deploy:bot)')) {
      (this.options.deployBot ?? runDeploy)();
      this.ok('Bot code deployed');
    }
  }

  async ensureSecrets(project: Project): Promise<void> {
    const secrets = project.secret ?? [];
    const names = secrets.map((s) => s.name);
    const wanted: ProjectSetting[] = [];
    if (names.includes('TYPESAFE_API_KEY')) {
      this.ok('project secret TYPESAFE_API_KEY exists (value not read)');
    } else {
      wanted.push({ name: 'TYPESAFE_API_KEY', valueString: '' });
    }
    const backend = secrets.find((s) => s.name === 'CONSISTENCY_BACKEND');
    if (backend) {
      this.ok(`project secret CONSISTENCY_BACKEND exists (${backend.valueString})`);
    } else {
      wanted.push({ name: 'CONSISTENCY_BACKEND', valueString: BACKEND });
    }
    if (wanted.length === 0 || !this.change(`add project secrets ${wanted.map((w) => w.name).join(', ')}`)) {
      return;
    }
    for (const setting of wanted) {
      if (setting.name === 'TYPESAFE_API_KEY') {
        setting.valueString = await (this.options.typesafeKey ?? readTypesafeKey)();
      }
    }
    // `test` makes the patch fail instead of appending if the list changed since it was read.
    const ops: PatchOperation[] = secrets.length
      ? [
          { op: 'test', path: '/secret', value: secrets },
          ...wanted.map((value): PatchOperation => ({ op: 'add', path: '/secret/-', value })),
        ]
      : [{ op: 'add', path: '/secret', value: wanted }];
    await this.medplum.patchResource('Project', this.projectId, ops);
  }

  async ensurePolicy(botId: string | undefined): Promise<WithId<AccessPolicy> | undefined> {
    const template = this.options.policy ?? (JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as AccessPolicy);
    const policy = JSON.parse(JSON.stringify(template).replaceAll('BOT_ID', botId ?? 'BOT_ID')) as AccessPolicy;
    const found = (
      await this.medplum.searchResources('AccessPolicy', { name: policy.name as string }, { cache: 'no-cache' })
    ).filter((p) => p.name === policy.name);
    if (found.length > 1) {
      throw new SetupError(`${found.length} AccessPolicies are named "${policy.name}"; keep one and run again.`);
    }
    const existing = found[0];
    if (existing && canonical(existing.resource) === canonical(policy.resource)) {
      this.ok(`AccessPolicy "${policy.name}" is current (${existing.id})`);
      return existing;
    }
    if (existing) {
      if (this.change(`update AccessPolicy ${existing.id} to match demo/access-policy.json`)) {
        return this.medplum.updateResource({ ...existing, resource: policy.resource });
      }
      return existing;
    }
    if (this.change(`create AccessPolicy "${policy.name}"`)) {
      return this.medplum.createResource(policy);
    }
    return undefined;
  }

  async ensurePractitioner(email: string, policy: WithId<AccessPolicy> | undefined): Promise<void> {
    const policyRef = policy ? `AccessPolicy/${policy.id}` : 'AccessPolicy/<created on apply>';
    // The invite stores the email on the User; the membership's user reference displays it.
    const memberships = (
      await this.medplum.searchResources('ProjectMembership', { _count: '1000' }, { cache: 'no-cache' })
    ).filter((m) => m.user?.display?.toLowerCase() === email.toLowerCase());
    const membership: WithId<ProjectMembership> | undefined = memberships[0];
    if (membership) {
      if (membership.access?.some((a) => a.policy?.reference === policyRef)) {
        this.ok(`${email} is a member with the demo policy`);
      } else if (this.change(`attach the demo policy to the existing membership of ${email}`)) {
        await this.medplum.patchResource('ProjectMembership', membership.id, [
          {
            op: 'add',
            path: '/access',
            value: [...(membership.access ?? []), { policy: { reference: policyRef } }],
          },
        ]);
      }
      return;
    }
    if (this.change(`invite ${email} as practitioner "Synthetic Rivera" with the demo policy (sends an email)`)) {
      await this.medplum.post(`admin/projects/${this.projectId}/invite`, {
        resourceType: 'Practitioner',
        firstName: 'Synthetic',
        lastName: 'Rivera',
        email,
        sendEmail: true,
        membership: { access: [{ policy: { reference: policyRef } }] },
      });
    }
  }
}

/**
 * Writes the public settings to root .env (other lines untouched), then provider/.env.local.
 * @param values - The settings to write.
 * @param values.baseUrl - The Medplum server.
 * @param values.projectId - The project.
 * @param values.botId - The consistency Bot, once created.
 * @param apply - False for a dry run.
 * @param log - Where to report each step.
 * @param root - The repository root.
 */
export function updateEnv(
  values: { baseUrl: string; projectId: string; botId?: string },
  apply: boolean,
  log: (line: string) => void = console.log,
  root = REPO_ROOT
): void {
  const envFile = join(root, '.env');
  const current = readEnv(envFile);
  const wanted: Record<string, string> = {
    MEDPLUM_BASE_URL: values.baseUrl,
    MEDPLUM_PROJECT_ID: values.projectId,
    ...(values.botId ? { MEDPLUM_CONSISTENCY_BOT_ID: values.botId } : {}),
  };
  const same = (a: string | undefined, b: string): boolean => (a ?? '').replace(/\/$/, '') === b.replace(/\/$/, '');
  const changes = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => !same(current[k], v)));
  if (Object.keys(changes).length === 0) {
    log('  ok    root .env has the project and Bot settings');
  } else {
    log(`  ${apply ? 'do   ' : 'would'} set ${Object.keys(changes).join(', ')} in root .env (other lines untouched)`);
    if (apply) {
      setEnvKeys(envFile, changes);
    }
  }
  if (apply) {
    configureProvider(root, (line) => log(`  ok    ${line}`));
  }
}

function runCli(args: string[], profile?: string): string {
  try {
    return execFileSync('npx', ['medplum', ...args, ...(profile ? ['-p', profile] : [])], {
      cwd: PROVIDER,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new SetupError('The Medplum CLI failed. Log in first: npx --prefix provider medplum login');
  }
}

/**
 * Server, project and user of the CLI login.
 * @param output - The output of `medplum whoami`.
 * @returns The login details.
 */
export function parseWhoami(output: string): { baseUrl: string; projectId: string; user: string } {
  const server = /Server:\s*(\S+)/.exec(output);
  const project = /Project:.*\(Project\/([A-Za-z0-9-]+)\)/.exec(output);
  if (!server || !project) {
    throw new SetupError('Could not read the CLI login. Run: npx --prefix provider medplum login');
  }
  return {
    baseUrl: server[1].replace(/\/?$/, '/'),
    projectId: project[1],
    user: /Profile:\s*(.*)/.exec(output)?.[1].trim() ?? '',
  };
}

function runDeploy(): void {
  const result = spawnSync('npm', ['run', 'deploy:bot'], { cwd: PROVIDER, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.includes('Deploy result: All OK')) {
    console.log(result.stdout.slice(-2000));
    throw new SetupError('Bot deploy failed; see the output above.');
  }
}

async function readTypesafeKey(): Promise<string> {
  const fromEnv = (process.env.TYPESAFE_API_KEY ?? readEnv(ENV_FILE).TYPESAFE_API_KEY ?? '').trim();
  const key = fromEnv || (await promptHidden('TypeSafe API key (input hidden): '));
  if (!key) {
    throw new SetupError('A TypeSafe API key is required. Get one from TypeSafe, then run again.');
  }
  return key;
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve('');
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (char === '\u0003') {
          process.exit(130);
        }
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      email: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      profile: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (args.help) {
    console.log('Usage: npm --prefix provider run setup -- [--email tester@example.com] [--dry-run] [--profile name]');
    return;
  }
  const apply = !args['dry-run'];
  const session = parseWhoami(runCli(['whoami'], args.profile));
  const envProject = readEnv(ENV_FILE).MEDPLUM_PROJECT_ID;
  if (envProject && envProject !== session.projectId) {
    throw new SetupError(
      `root .env uses project ${envProject} but the CLI is logged in to ${session.projectId}. ` +
        'Switch with `npx --prefix provider medplum project switch <id>` or fix .env.'
    );
  }
  const token = runCli(['token'], args.profile).trim().split(/\s+/).at(-1) as string;
  const medplum = new Client({ baseUrl: session.baseUrl, fetch: globalThis.fetch });
  medplum.setAccessToken(token);

  console.log(
    `${apply ? 'Setting up' : 'Dry run for'} project ${session.projectId} on ${session.baseUrl} as ${session.user}`
  );
  const setup = new Setup({ medplum, projectId: session.projectId, apply });
  const project = await setup.checkProject();
  const bot = await setup.ensureBot();
  setup.writeBotConfig(bot?.id);
  setup.deployBot();
  await setup.ensureSecrets(project);
  const policy = await setup.ensurePolicy(bot?.id);
  if (args.email) {
    await setup.ensurePractitioner(args.email, policy);
  } else {
    console.log('  skip  no --email given: no practitioner invited (you can sign in as yourself)');
  }
  updateEnv({ baseUrl: session.baseUrl, projectId: session.projectId, botId: bot?.id }, apply);

  if (apply) {
    console.log(
      '\nDone. Next: npm --prefix provider run dev, open http://localhost:3001, sign in and choose Guided demo.'
    );
    if (args.email) {
      console.log(`The invite email to ${args.email} has the link to set that password.`);
    }
  } else {
    console.log('\nNothing was changed. Run again without --dry-run to apply.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Errors from Medplum carry OperationOutcome text, never request bodies or secret values.
    console.error(`Setup stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
