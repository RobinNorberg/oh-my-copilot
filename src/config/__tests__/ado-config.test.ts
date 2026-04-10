import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { readOmpConfig, getAdoConfig } from '../ado-config.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('readOmpConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('uses cwd when no dir is provided', () => {
    mockExistsSync.mockReturnValue(false);

    readOmpConfig();

    const checkedPath = mockExistsSync.mock.calls[0][0] as string;
    expect(checkedPath).toContain('.omcp');
    expect(checkedPath).toContain('config.json');
  });
});

describe('getAdoConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
