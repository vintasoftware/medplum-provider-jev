import type { WithId } from '@medplum/core';
import type { AccessPolicy, Bot, Project, ProjectMembership } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { configureProvider } from './configure-provider';
import { setEnvKeys } from './env-file';
import { BOT_NAME, parseWhoami, Setup, updateEnv } from './setup-medplum';

const POLICY: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Guided demo practitioner (synthetic project)',
  resource: [{ resourceType: 'Bot', criteria: 'Bot?_id=BOT_ID', readonly: true }],
};

function tempRoot(env = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-medplum-'));
  mkdirSync(join(root, 'provider'));
  writeFileSync(join(root, '.env'), env);
  return root;
}

let medplum: MockClient;
let project: WithId<Project>;
let lines: string[];
let deployBot: ReturnType<typeof vi.fn<() => void>>;
let configFile: string;
let adminPost: ReturnType<typeof vi.fn<(url: string, body: any) => Promise<unknown>>>;

function setup(apply: boolean, typesafeKey = vi.fn(async () => 'ts-secret')): Setup {
  return new Setup({
    medplum,
    projectId: project.id,
    apply,
    log: (line) => lines.push(line),
    typesafeKey,
    deployBot,
    botConfigFile: configFile,
    policy: POLICY,
  });
}

async function runAll(s: Setup, email?: string): Promise<void> {
  const current = await s.checkProject();
  const bot = await s.ensureBot();
  s.writeBotConfig(bot?.id);
  s.deployBot();
  await s.ensureSecrets(current);
  const policy = await s.ensurePolicy(bot?.id);
  if (email) {
    await s.ensurePractitioner(email, policy);
  }
}

beforeEach(async () => {
  medplum = new MockClient();
  project = await medplum.createResource<Project>({
    resourceType: 'Project',
    name: 'Demo',
    features: ['bots'],
    secret: [{ name: 'OTHER_APP_SECRET', valueString: 'keep-me' }],
  });
  lines = [];
  deployBot = vi.fn<() => void>();
  configFile = join(tempRoot(), 'provider', 'medplum.config.json');
  // MockClient has no admin routes; emulate Bot creation and the invite.
  const post = medplum.post.bind(medplum);
  adminPost = vi.fn(async (url: string, body: any): Promise<unknown> => {
    if (url.endsWith('/bot')) {
      return medplum.createResource<Bot>({ resourceType: 'Bot', name: body.name, description: body.description });
    }
    return { resourceType: 'ProjectMembership', id: 'invited' };
  });
  vi.spyOn(medplum, 'post').mockImplementation((async (url: URL | string, body: any, ...rest: any[]) =>
    String(url).startsWith('admin/') ? adminPost(String(url), body) : post(url, body, ...rest)) as typeof medplum.post);
});

describe('setup-medplum', () => {
  test('a dry run reads the project and writes nothing', async () => {
    const writes = [
      vi.spyOn(medplum, 'createResource'),
      vi.spyOn(medplum, 'updateResource'),
      vi.spyOn(medplum, 'patchResource'),
      vi.spyOn(medplum, 'deleteResource'),
    ];
    const key = vi.fn(async () => 'ts-secret');
    await runAll(setup(false, key), 'tester@example.com');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(adminPost).not.toHaveBeenCalled();
    expect(deployBot).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    expect(() => readFileSync(configFile)).toThrow();
    expect(lines.filter((l) => l.includes('would'))).toHaveLength(6);
  });

  test('applying creates what is missing, keeps other secrets, and a second run changes nothing', async () => {
    await runAll(setup(true), 'tester@example.com');

    const [bot] = await medplum.searchResources('Bot', { name: BOT_NAME });
    expect(bot.runAsUser).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).bots[0]).toMatchObject({ name: BOT_NAME, id: bot.id });
    expect(deployBot).toHaveBeenCalledTimes(1);

    const updated = await medplum.readResource('Project', project.id);
    expect(updated.secret).toEqual([
      { name: 'OTHER_APP_SECRET', valueString: 'keep-me' },
      { name: 'TYPESAFE_API_KEY', valueString: 'ts-secret' },
      { name: 'CONSISTENCY_BACKEND', valueString: 'typesafe' },
    ]);
    const [policy] = await medplum.searchResources('AccessPolicy', { name: POLICY.name as string });
    expect(policy.resource).toEqual([{ resourceType: 'Bot', criteria: `Bot?_id=${bot.id}`, readonly: true }]);
    expect(adminPost).toHaveBeenCalledWith(
      `admin/projects/${project.id}/invite`,
      expect.objectContaining({
        email: 'tester@example.com',
        membership: { access: [{ policy: { reference: `AccessPolicy/${policy.id}` } }] },
      })
    );
    expect(lines.join('\n')).not.toContain('ts-secret');

    // Second run: the invited member now exists.
    await medplum.createResource<ProjectMembership>({
      resourceType: 'ProjectMembership',
      project: { reference: `Project/${project.id}` },
      user: { reference: 'User/tester', display: 'tester@example.com' },
      profile: { reference: 'Practitioner/tester' },
      access: [{ policy: { reference: `AccessPolicy/${policy.id}` } }],
    });
    const writes = [vi.spyOn(medplum, 'createResource'), vi.spyOn(medplum, 'patchResource')];
    adminPost.mockClear();
    lines = [];
    const again = setup(true);
    await runAll(again, 'Tester@Example.com');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(adminPost).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.startsWith('  do'))).toEqual([
      '  do    build, smoke-test and deploy the Bot code (npm run deploy:bot)',
    ]);
  });

  test('attaches the policy to an existing member instead of inviting again', async () => {
    const policy = await medplum.createResource<AccessPolicy>(POLICY);
    const member = await medplum.createResource<ProjectMembership>({
      resourceType: 'ProjectMembership',
      project: { reference: `Project/${project.id}` },
      user: { reference: 'User/tester', display: 'tester@example.com' },
      profile: { reference: 'Practitioner/tester' },
    });
    await setup(true).ensurePractitioner('tester@example.com', policy);
    expect((await medplum.readResource('ProjectMembership', member.id)).access).toEqual([
      { policy: { reference: `AccessPolicy/${policy.id}` } },
    ]);
    expect(adminPost).not.toHaveBeenCalled();
  });

  test('stops when Bots are not enabled', async () => {
    await medplum.updateResource({ ...project, features: [] });
    await expect(setup(true).checkProject()).rejects.toThrow('Bots are not enabled');
  });

  test('stops on duplicate Bots instead of guessing', async () => {
    await medplum.createResource<Bot>({ resourceType: 'Bot', name: BOT_NAME });
    await medplum.createResource<Bot>({ resourceType: 'Bot', name: BOT_NAME });
    await expect(setup(true).ensureBot()).rejects.toThrow('2 Bots are named');
  });

  test('reads the CLI login', () => {
    expect(
      parseWhoami(
        'Server:  https://api.medplum.com\nProfile: Dr. A (Practitioner/1)\nProject: Demo (Project/7bfa-99)\n'
      )
    ).toEqual({ baseUrl: 'https://api.medplum.com/', projectId: '7bfa-99', user: 'Dr. A (Practitioner/1)' });
    expect(() => parseWhoami('Not logged in')).toThrow('medplum login');
  });
});

describe('env files', () => {
  test('setEnvKeys replaces keys in place and keeps other lines', () => {
    const root = tempRoot('# comment\nTYPESAFE_API_KEY=keep\nMEDPLUM_PROJECT_ID=old\n');
    setEnvKeys(join(root, '.env'), { MEDPLUM_PROJECT_ID: 'new', MEDPLUM_CONSISTENCY_BOT_ID: 'bot' });
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      '# comment\nTYPESAFE_API_KEY=keep\nMEDPLUM_PROJECT_ID=new\nMEDPLUM_CONSISTENCY_BOT_ID=bot\n'
    );
  });

  test('updateEnv writes public settings only and ignores a trailing slash difference', () => {
    const root = tempRoot('MEDPLUM_BASE_URL=https://api.medplum.com\nTYPESAFE_API_KEY=ts-secret\n');
    const log: string[] = [];
    updateEnv({ baseUrl: 'https://api.medplum.com/', projectId: 'p1', botId: 'b1' }, true, (l) => log.push(l), root);
    expect(log[0]).toContain('set MEDPLUM_PROJECT_ID, MEDPLUM_CONSISTENCY_BOT_ID');
    const local = readFileSync(join(root, 'provider', '.env.local'), 'utf8');
    expect(local).toContain('MEDPLUM_PROJECT_ID="p1"');
    expect(local).toContain('MEDPLUM_CONSISTENCY_BOT_ID="b1"');
    expect(local).not.toContain('ts-secret');
  });

  test('configureProvider never copies server secrets', () => {
    const root = tempRoot(
      'MEDPLUM_BASE_URL=https://api.medplum.com/\nMEDPLUM_PROJECT_ID=p1\nTYPESAFE_API_KEY=ts-secret\nMEDPLUM_DEMO_ONLY=true\n'
    );
    const log: string[] = [];
    configureProvider(root, (l) => log.push(l));
    const local = readFileSync(join(root, 'provider', '.env.local'), 'utf8');
    expect(local).toBe('MEDPLUM_BASE_URL="https://api.medplum.com/"\nMEDPLUM_PROJECT_ID="p1"\n');
    expect(log[0]).toContain('Left TYPESAFE_API_KEY out');
    expect(log[0]).not.toContain('ts-secret');
  });

  test('configureProvider requires the project settings', () => {
    expect(() => configureProvider(tempRoot('TYPESAFE_API_KEY=x\n'), () => undefined)).toThrow('MEDPLUM_PROJECT_ID');
  });
});
