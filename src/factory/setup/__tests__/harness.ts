/**
 * Fakes for the setup wizard tests: one Exec that answers git, gh and az
 * (ADO `devops invoke` calls from the fixtures in ./fixtures/ado, in the
 * src/forge/ado/__tests__/fixtures format), and a scripted Prompter.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { adoFixtureExec, loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import type { Forge, ForgeItem } from '../../../forge/types.js';
import type { ExecResult } from '../../../ship/exec.js';
import type { FactorySetupDeps } from '../../../cli/commands/factory-setup.js';
import { listOnlyPreview, type Prompter } from '../intake-pick.js';

export const SETUP_ADO_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ado');
export const GITHUB_ORIGIN = 'https://github.com/acme/widgets.git';
export const ADO_ORIGIN = 'https://dev.azure.com/contoso/Web/_git/web-app';
export const QUERY_ID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';

export interface FakeWorld {
  root: string;
  origin: string;
  /** gh / az (non-invoke) answers keyed by `cmd args…`; missing = exit 1. */
  answers: Record<string, Partial<ExecResult>>;
  labels: string[];
  calls: Array<{ cmd: string; args: string[] }>;
}

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omg-setup-'));
}

export function githubWorld(root = tempRoot()): FakeWorld {
  return {
    root,
    origin: GITHUB_ORIGIN,
    labels: ['bug', 'factory:queued'],
    answers: {
      // gh prints the token line masked; the wizard must not echo any of it.
      'gh auth status --hostname github.com': { status: 0, stdout: 'github.com\n  ✓ Logged in to github.com account acme\n  - Token: gho_************************************' },
      'gh api --hostname github.com --method GET repos/acme/widgets/milestones?state=open&per_page=100': { status: 0, stdout: JSON.stringify([{ title: 'v5.18' }, { title: 'v6.0' }]) },
    },
    calls: [],
  };
}

export function adoWorld(root = tempRoot()): FakeWorld {
  return {
    root,
    origin: ADO_ORIGIN,
    labels: [],
    answers: {
      'az extension show --name azure-devops --output json': { status: 0, stdout: '{"name":"azure-devops","version":"1.0.1"}' },
      'az account show --output json': { status: 0, stdout: '{"user":{"name":"owner@example.com"},"tenantId":"t"}' },
    },
    calls: [],
  };
}

export function fakeExec(world: FakeWorld): FactorySetupDeps['exec'] {
  const ado = adoFixtureExec(loadAdoFixtures(SETUP_ADO_FIXTURES));
  return (cmd, args) => {
    world.calls.push({ cmd, args: [...args] });
    const line = `${cmd} ${args.join(' ')}`;
    if (cmd === 'git' && line === 'git rev-parse --show-toplevel') return { status: 0, stdout: `${world.root}\n`, stderr: '' };
    if (cmd === 'git' && line === 'git remote get-url origin') return { status: 0, stdout: `${world.origin}\n`, stderr: '' };
    if (line === 'gh label list --json name --limit 1000') return { status: 0, stdout: JSON.stringify(world.labels.map((name) => ({ name }))), stderr: '' };
    if (cmd === 'gh' && args[0] === 'label' && args[1] === 'create') {
      world.labels.push(args[2]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'az' && args[0] === 'devops' && args[1] === 'invoke') return ado(cmd, args);
    const a = world.answers[line];
    return { status: a?.status ?? 1, stdout: a?.stdout ?? '', stderr: a?.stderr ?? `no fake for ${line}` };
  };
}

export function fakeForge(items: Array<Pick<ForgeItem, 'id' | 'title' | 'url'>>, seen: { exec?: unknown; queried?: unknown[] } = {}): FactorySetupDeps['createForge'] {
  return (exec, _cwd, config) => {
    seen.exec = exec;
    return {
      kind: config.kind,
      tracker: {
        queryItems: (source: unknown, limit: number) => {
          (seen.queried ??= []).push({ source, limit });
          return items.map((i) => i.id);
        },
        viewItem: (id: number) => ({ ...items.find((i) => i.id === id)!, body: '', open: true, rawState: 'OPEN', authorTrusted: true, comments: [], labels: [], dependsOn: [], children: [], repoUrl: '' }),
      },
    } as unknown as Forge;
  };
}

export function scriptedPrompter(answers: Array<string | boolean>): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    if (answers.length === 0) throw new Error(`unscripted question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    select: async (q, choices) => {
      const a = next(q);
      if (typeof a !== 'string' || !choices.includes(a)) throw new Error(`${q}: ${String(a)} is not one of ${choices.join(', ')}`);
      return a;
    },
    input: async (q) => String(next(q)),
    confirm: async (q) => Boolean(next(q)),
  };
}

export function setupDeps(world: FakeWorld, over: Partial<FactorySetupDeps> = {}): FactorySetupDeps {
  return {
    exec: fakeExec(world),
    env: {},
    isTTY: () => false,
    resolveAz: () => ({ command: 'az', prefix: [], env: {} }),
    createForge: fakeForge([{ id: 7, title: 'Add the export button', url: 'https://example.test/7' }]),
    previewCheck: listOnlyPreview,
    userConfigPath: () => join(world.root, 'user-home', 'config.jsonc'),
    ...over,
  };
}
