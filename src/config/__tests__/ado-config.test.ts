import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// The canonical resolver is stubbed so these stay unit tests of the parsing
// path; that it is consulted at all — with the caller's directory — is the
// contract the multirepo-paths gate cares about.
vi.mock('../../lib/worktree-paths.js', () => ({
  resolveOmcPath: vi.fn((relativePath: string, worktreeRoot?: string) =>
    `${worktreeRoot ?? '/detected/root'}/.omg/${relativePath}`),
}));

import { existsSync, readFileSync } from 'node:fs';
import { resolveOmcPath } from '../../lib/worktree-paths.js';
import { readOmpConfig, getAdoConfig } from '../ado-config.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockResolveOmcPath = vi.mocked(resolveOmcPath);

/** afterEach resets implementations, so restore the resolver before each test. */
function stubResolver(): void {
  mockResolveOmcPath.mockImplementation((relativePath: string, worktreeRoot?: string) =>
    `${worktreeRoot ?? '/detected/root'}/.omg/${relativePath}`);
}

describe('readOmpConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubResolver();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(readOmpConfig('/some/dir')).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('parses valid config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        platform: 'azure-devops',
        ado: {
          org: 'https://dev.azure.com/myorg',
          project: 'MyProject',
          defaultWorkItemType: 'User Story',
        },
      }),
    );

    const result = readOmpConfig('/some/dir');

    expect(result).toEqual({
      version: 1,
      platform: 'azure-devops',
      ado: {
        org: 'https://dev.azure.com/myorg',
        project: 'MyProject',
        defaultWorkItemType: 'User Story',
      },
    });
  });

  it('returns null when JSON is invalid', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    expect(readOmpConfig('/some/dir')).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(readOmpConfig('/some/dir')).toBeNull();
  });

  it('resolves the config path through the canonical state-root resolver', () => {
    mockExistsSync.mockReturnValue(false);

    readOmpConfig('/some/dir');

    expect(mockResolveOmcPath).toHaveBeenCalledWith('config.json', '/some/dir');
    expect(mockExistsSync).toHaveBeenCalledWith('/some/dir/.omg/config.json');
  });

  it('lets the resolver auto-detect the root when no dir is provided', () => {
    mockExistsSync.mockReturnValue(false);

    readOmpConfig();

    expect(mockResolveOmcPath).toHaveBeenCalledWith('config.json', undefined);
    const checkedPath = mockExistsSync.mock.calls[0][0] as string;
    expect(checkedPath).toContain('.omg');
    expect(checkedPath).toContain('config.json');
  });

  it('returns null when the resolver rejects the path', () => {
    mockResolveOmcPath.mockImplementation(() => {
      throw new Error('Path escapes omc boundary');
    });

    expect(readOmpConfig('/some/dir')).toBeNull();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });
});

describe('getAdoConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubResolver();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty object when no config file exists', () => {
    mockExistsSync.mockReturnValue(false);

    expect(getAdoConfig('/some/dir')).toEqual({});
  });

  it('returns ado section from config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        ado: {
          org: 'https://dev.azure.com/myorg',
          project: 'MyProject',
          areaPath: 'MyProject\\Team',
          iterationPath: 'MyProject\\Sprint 1',
          workItemOrg: 'https://dev.azure.com/otherwork',
          workItemProject: 'WorkItems',
        },
      }),
    );

    const result = getAdoConfig('/some/dir');

    expect(result).toEqual({
      org: 'https://dev.azure.com/myorg',
      project: 'MyProject',
      areaPath: 'MyProject\\Team',
      iterationPath: 'MyProject\\Sprint 1',
      workItemOrg: 'https://dev.azure.com/otherwork',
      workItemProject: 'WorkItems',
    });
  });

  it('returns empty object when config has no ado section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, platform: 'github' }));

    expect(getAdoConfig('/some/dir')).toEqual({});
  });
});
