import { describe, expect, it } from 'vitest';
import { detectForgeRepo, ForgeConfigError, isTrustedAdoAuthor, resolveForgeConfig } from '../config.js';

const GH = 'https://github.com/acme/widgets.git';
const ADO = 'https://contoso@dev.azure.com/contoso/Web%20Apps/_git/web-app';
const f = (factory: Record<string, unknown>) => ({ factory });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ForgeConfigError ? error.code : `not a ForgeConfigError: ${String(error)}`;
  }
  return undefined;
}

describe('detectForgeRepo', () => {
  it.each([
    [GH, { kind: 'github', host: 'github.com', owner: 'acme', name: 'widgets', url: 'https://github.com/acme/widgets' }],
    ['git@github.com:acme/widgets.git', { kind: 'github', host: 'github.com', owner: 'acme', name: 'widgets', url: 'https://github.com/acme/widgets' }],
    ['https://ghe.corp.example/acme/widgets', { kind: 'github', host: 'ghe.corp.example', owner: 'acme', name: 'widgets', url: 'https://ghe.corp.example/acme/widgets' }],
    [ADO, { kind: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Web Apps', name: 'web-app', url: 'https://dev.azure.com/contoso/Web%20Apps/_git/web-app' }],
    ['git@ssh.dev.azure.com:v3/contoso/Web/web-app', { kind: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Web', name: 'web-app', url: 'https://dev.azure.com/contoso/Web/_git/web-app' }],
    ['https://contoso.visualstudio.com/Web/_git/web-app', { kind: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Web', name: 'web-app', url: 'https://dev.azure.com/contoso/Web/_git/web-app' }],
  ])('%s', (url, want) => {
    expect(detectForgeRepo(url)).toEqual(want);
  });

  it.each([
    'https://contoso.visualstudio.com/DefaultCollection/Web/_git/web-app',
    'https://user@contoso.visualstudio.com/Web/_git/web-app',
    'contoso@vs-ssh.visualstudio.com:v3/contoso/Web/web-app',
  ])('maps the legacy form %s to the dev.azure.com repository (as repoIdentity does)', (url) => {
    expect(detectForgeRepo(url)).toEqual({ kind: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Web', name: 'web-app', url: 'https://dev.azure.com/contoso/Web/_git/web-app' });
  });

  it('refuses an escaped / in a segment and an ambiguous authority', () => {
    expect(code(() => detectForgeRepo('https://dev.azure.com/a%2Fb/c/_git/r'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('https://dev.azure.com/a/b%2Fc/_git/r'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('https://dev.azure.com/a/b/_git/r%5Cx'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('https://attacker.example#@dev.azure.com/victim/proj/_git/repo'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('https://attacker.example#@github.com/o/r'))).toBe('forge-unsupported');
  });

  it('refuses an scp origin whose host is not a plain host name (it feeds gh --hostname)', () => {
    expect(code(() => detectForgeRepo('git@evil.com#@github.com:o/r'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('git@evil.com?x:o/r'))).toBe('forge-unsupported');
    expect(detectForgeRepo('git@ghe.corp.example:acme/widgets').host).toBe('ghe.corp.example');
  });

  it('refuses a remote that is neither GitHub nor Azure DevOps', () => {
    expect(code(() => detectForgeRepo('https://gitlab.com/acme/widgets'))).toBe('forge-unsupported');
    expect(code(() => detectForgeRepo('not a url'))).toBe('forge-unsupported');
  });
});

describe('resolveForgeConfig: defaults', () => {
  it('detects GitHub from origin with no config (today\'s behaviour)', () => {
    const { config, warnings } = resolveForgeConfig(undefined, undefined, undefined, GH);
    expect(warnings).toEqual([]);
    expect(config.kind).toBe('github');
    expect(config.repo.url).toBe('https://github.com/acme/widgets');
    expect(config.azureDevOps).toBeUndefined();
    expect(config.intake).toEqual({ itemTypes: ['User Story', 'Bug', 'Product Backlog Item'], limit: 50, marker: 'factory-ready' });
    expect(config.check).toEqual({ maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20000 });
    // Progress sync is opt-in: no factory.progress section, no tracker writes.
    expect(config.progress.enabled).toBe(false);
    expect(config.progress.stages.building).toEqual({ label: 'factory:building' });
    expect(config.progress.stages.cancelled).toBeUndefined();
  });

  it('progress is on only when a trusted layer has a factory.progress section', () => {
    const on = (u: unknown, b: unknown, p?: unknown) => resolveForgeConfig(u, b, p, GH).config.progress.enabled;
    expect(on(undefined, undefined)).toBe(false);
    expect(on(f({ intake: { limit: 5 } }), f({ check: { maxSize: 3 } }))).toBe(false);
    expect(on(undefined, f({ progress: {} }))).toBe(true);
    expect(on(f({ progress: { stages: { building: { label: 'factory:wip' } } } }), undefined)).toBe(true);
    expect(on(undefined, f({ progress: { enabled: true } }))).toBe(true);
    expect(on(f({ progress: { enabled: false } }), f({ progress: { enabled: true } }))).toBe(false);
    // The working tree cannot turn it on.
    expect(on(undefined, undefined, f({ progress: { enabled: true } }))).toBe(false);
  });

  it('detects Azure DevOps and fills the identity from origin', () => {
    const { config } = resolveForgeConfig(undefined, undefined, undefined, ADO);
    expect(config.kind).toBe('azure-devops');
    expect(config.azureDevOps).toEqual({ org: 'contoso', project: 'Web Apps', repo: 'web-app', workItemProject: 'Web Apps', apiVersion: '7.1', trustedAuthors: [] });
    expect(config.progress.stages).toEqual({});
  });
});

describe('resolveForgeConfig: trust layering (design §3)', () => {
  // [keys, layer, value, expected effect]
  it('forge.* identity: user config pins it', () => {
    const { config } = resolveForgeConfig(f({ forge: { kind: 'azure-devops', azureDevOps: { org: 'CONTOSO', project: 'web apps', team: 'Web Team' } } }), undefined, undefined, ADO);
    expect(config.azureDevOps?.team).toBe('Web Team');
  });

  it('forge.* identity: the base branch pins it when the user config does not', () => {
    const { config, warnings } = resolveForgeConfig(undefined, f({ forge: { azureDevOps: { team: 'Base Team' } } }), undefined, ADO);
    expect(config.azureDevOps?.team).toBe('Base Team');
    expect(warnings).toEqual([]);
  });

  it('forge.* identity: the user config wins over the base branch', () => {
    const { config } = resolveForgeConfig(
      f({ forge: { azureDevOps: { team: 'User Team' } } }),
      f({ forge: { azureDevOps: { team: 'Base Team', workItemProject: 'web%20apps' } } }),
      undefined,
      ADO,
    );
    expect(config.azureDevOps).toMatchObject({ team: 'User Team', workItemProject: 'Web Apps' });
  });

  it('forge.* identity: a workItemProject other than the repo project is refused (not supported yet)', () => {
    for (const layers of [[f({ forge: { azureDevOps: { workItemProject: 'Tracker' } } }), undefined], [undefined, f({ forge: { azureDevOps: { workItemProject: 'Tracker' } } })]]) {
      expect(code(() => resolveForgeConfig(layers[0], layers[1], undefined, ADO))).toBe('forge-unsupported');
    }
  });

  it('forge.* identity: key order alone never warns', () => {
    const base = f({ forge: { kind: 'azure-devops', azureDevOps: { team: 'T', org: 'contoso' } } });
    const tree = f({ forge: { azureDevOps: { org: 'contoso', team: 'T' }, kind: 'azure-devops' } });
    expect(resolveForgeConfig(undefined, base, tree, ADO).warnings).toEqual([]);
  });

  it('forge.* identity: the working tree is ignored with a warning when it differs from base', () => {
    const { config, warnings } = resolveForgeConfig(undefined, f({ forge: { azureDevOps: { team: 'Base Team' } } }), f({ forge: { azureDevOps: { team: 'Lane Team' } } }), ADO);
    expect(config.azureDevOps?.team).toBe('Base Team');
    expect(warnings).toEqual([expect.stringContaining('ignoring factory.forge from the working-tree project config')]);
  });

  it('forge.* identity: a working-tree copy equal to base is silent', () => {
    const block = f({ forge: { azureDevOps: { team: 'Base Team' } } });
    expect(resolveForgeConfig(undefined, block, block, ADO).warnings).toEqual([]);
  });

  it('forge.* identity: a working-tree kind cannot switch the forge', () => {
    const { config, warnings } = resolveForgeConfig(undefined, undefined, f({ forge: { kind: 'azure-devops' } }), GH);
    expect(config.kind).toBe('github');
    expect(warnings).toHaveLength(1);
  });

  it('trustedAuthors: user config only, lowercased', () => {
    const { config, warnings } = resolveForgeConfig(f({ forge: { azureDevOps: { trustedAuthors: ['Owner@Example.com', 'owner@example.com'] } } }), undefined, undefined, ADO);
    expect(config.azureDevOps?.trustedAuthors).toEqual(['owner@example.com']);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['base', (b: unknown) => [undefined, b, undefined]],
    ['project', (b: unknown) => [undefined, undefined, b]],
  ] as const)('trustedAuthors: ignored with a warning from %s', (_layer, place) => {
    const [u, b, p] = place(f({ forge: { azureDevOps: { trustedAuthors: ['lane@example.com'] } } }));
    const { config, warnings } = resolveForgeConfig(u, b, p, ADO);
    expect(config.azureDevOps?.trustedAuthors).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('trustedAuthors')]);
  });

  it('progress.*: user over base; the working tree is ignored with a warning', () => {
    const { config, warnings } = resolveForgeConfig(
      f({ progress: { stages: { building: { label: 'wip' } } } }),
      f({ progress: { enabled: false } }),
      f({ progress: { enabled: true, stages: { done: { label: 'lane-done' } } } }),
      GH,
    );
    expect(config.progress.enabled).toBe(false);
    expect(config.progress.stages.building).toEqual({ label: 'wip' });
    expect(config.progress.stages.done).toEqual({ label: 'factory:done' });
    expect(warnings).toEqual([expect.stringContaining('ignoring factory.progress from the working-tree project config')]);
  });

  it('intake.* and check.*: working tree > user > base > defaults', () => {
    const { config, warnings } = resolveForgeConfig(
      f({ intake: { limit: 20, marker: 'user-ready' }, check: { maxSize: 5 } }),
      f({ intake: { limit: 10, marker: 'base-ready', source: { type: 'label', label: 'factory' } }, check: { maxSize: 3, maxBodyChars: 9000 } }),
      f({ intake: { limit: 30 }, check: { maxAcceptanceItems: 6 } }),
      GH,
    );
    expect(config.intake).toMatchObject({ limit: 30, marker: 'user-ready', source: { type: 'label', label: 'factory' } });
    expect(config.check).toEqual({ maxAcceptanceItems: 6, maxSize: 5, maxBodyChars: 9000 });
    expect(warnings).toEqual([]);
  });
});

describe('resolveForgeConfig: config can pin, never redirect', () => {
  it.each([
    ['kind', f({ forge: { kind: 'azure-devops' } }), GH],
    ['kind', f({ forge: { kind: 'github' } }), ADO],
    ['github.repo', f({ forge: { github: { repo: 'evil/widgets' } } }), GH],
    ['github.host', f({ forge: { github: { host: 'ghe.example' } } }), GH],
    ['azureDevOps.org', f({ forge: { azureDevOps: { org: 'fabrikam' } } }), ADO],
    ['azureDevOps.project', f({ forge: { azureDevOps: { project: 'Other' } } }), ADO],
    ['azureDevOps.repo', f({ forge: { azureDevOps: { repo: 'other' } } }), ADO],
  ])('refuses a %s that disagrees with origin (user config)', (_key, user, remote) => {
    expect(code(() => resolveForgeConfig(user, undefined, undefined, remote))).toBe('forge-mismatch');
  });

  it('refuses a mismatch from the base branch too', () => {
    expect(code(() => resolveForgeConfig(undefined, f({ forge: { azureDevOps: { repo: 'other' } } }), undefined, ADO))).toBe('forge-mismatch');
  });

  it('accepts a matching pin, case-insensitively and with %20 decoded', () => {
    const user = f({ forge: { kind: 'azure-devops', azureDevOps: { org: 'Contoso', project: 'Web%20Apps', repo: 'WEB-APP' } } });
    expect(resolveForgeConfig(user, undefined, undefined, ADO).config.azureDevOps?.repo).toBe('web-app');
    expect(resolveForgeConfig(f({ forge: { github: { repo: 'ACME/Widgets', host: 'github.com' } } }), undefined, undefined, GH).config.kind).toBe('github');
  });
});

describe('resolveForgeConfig: validation', () => {
  it.each([
    ['a non-object factory', { factory: [] }, GH],
    ['an unknown kind', f({ forge: { kind: 'gitlab' } }), GH],
    ['an apiVersion other than 7.1', f({ forge: { azureDevOps: { apiVersion: '7.2' } } }), ADO],
    ['trustedAuthors not an array', f({ forge: { azureDevOps: { trustedAuthors: 'me' } } }), ADO],
    ['an ADO intake source on GitHub', f({ intake: { source: { type: 'wiql-query', queryId: '0b6c1a2e-1111-2222-3333-444455556666' } } }), GH],
    ['a GitHub intake source on ADO', f({ intake: { source: { type: 'label', label: 'factory' } } }), ADO],
    ['a project-column source (cut, §A.11)', f({ intake: { source: { type: 'project-column', owner: 'acme', project: 7, field: 'Status', column: 'Ready' } } }), GH],
    ['a saved-query id that is not a GUID', f({ intake: { source: { type: 'wiql-query', queryId: "x' OR 1=1" } } }), ADO],
    ['a limit above 200', f({ intake: { limit: 500 } }), GH],
    ['a marker with a comma', f({ intake: { marker: 'a,b' } }), GH],
    ['a zero check limit', f({ check: { maxSize: 0 } }), GH],
    ['an unknown stage', f({ progress: { stages: { shipping: { label: 'x' } } } }), GH],
    ['a column mapping on GitHub', f({ progress: { stages: { building: { column: 'Doing' } } } }), GH],
    ['a label mapping on ADO', f({ progress: { stages: { building: { label: 'x' } } } }), ADO],
    ['a state change on blocked', f({ progress: { stages: { blocked: { state: 'Removed' } } } }), ADO],
  ])('refuses %s', (_what, user, remote) => {
    expect(code(() => resolveForgeConfig(user, undefined, undefined, remote))).toBe('invalid');
  });

  it('accepts every ADO intake source shape', () => {
    for (const source of [
      { type: 'wiql-query', queryId: '0B6C1A2E-1111-2222-3333-444455556666' },
      { type: 'board-column', team: 'Web Team', board: 'Stories', column: 'Ready' },
      { type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' },
    ]) {
      expect(resolveForgeConfig(undefined, undefined, f({ intake: { source } }), ADO).config.intake.source?.type).toBe(source.type);
    }
  });
});

describe('isTrustedAdoAuthor (§A.10)', () => {
  const trusted = ['owner@example.com'];
  it('matches createdBy.uniqueName case-insensitively', () => {
    expect(isTrustedAdoAuthor({ uniqueName: 'Owner@Example.com', displayName: 'x' }, trusted)).toBe(true);
  });
  it('never matches on the display name', () => {
    expect(isTrustedAdoAuthor({ displayName: 'owner@example.com' }, trusted)).toBe(false);
    expect(isTrustedAdoAuthor({ displayName: 'owner@example.com', uniqueName: 'lane@example.com' }, trusted)).toBe(false);
  });
  it('is false for a missing identity or an empty list', () => {
    expect(isTrustedAdoAuthor(undefined, trusted)).toBe(false);
    expect(isTrustedAdoAuthor({ uniqueName: '' }, trusted)).toBe(false);
    expect(isTrustedAdoAuthor({ uniqueName: 'owner@example.com' }, [])).toBe(false);
  });
});
