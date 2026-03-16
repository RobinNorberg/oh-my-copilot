import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { BitbucketProvider } from '../../providers/bitbucket.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('BitbucketProvider', () => {
  let provider: BitbucketProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    provider = new BitbucketProvider();
    vi.clearAllMocks();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('static properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('bitbucket');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('Bitbucket');
    });

    it('uses PR terminology', () => {
      expect(provider.prTerminology).toBe('PR');
    });

    it('has null prRefspec', () => {
      expect(provider.prRefspec).toBeNull();
    });

    it('requires no CLI', () => {
      expect(provider.getRequiredCLI()).toBeNull();
    });
  });

  describe('detectFromRemote', () => {
    it('returns true for bitbucket.org HTTPS URLs', () => {
      expect(provider.detectFromRemote('https://bitbucket.org/user/repo')).toBe(true);
    });

    it('returns true for bitbucket.org SSH URLs', () => {
      expect(provider.detectFromRemote('git@bitbucket.org:user/repo.git')).toBe(true);
    });

    it('returns false for non-Bitbucket URLs', () => {
      expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(false);
    });

    it('returns false for GitLab URLs', () => {
      expect(provider.detectFromRemote('https://gitlab.com/user/repo')).toBe(false);
    });
  });

  describe('viewPR', () => {
    it('fetches PR via curl and parses response', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      const mockResponse = JSON.stringify({
        title: 'Add feature',
        source: { branch: { name: 'feature/new' } },
        destination: { branch: { name: 'main' } },
        links: { html: { href: 'https://bitbucket.org/user/repo/pull-requests/5' } },
        description: 'Adds a new feature',
        author: { display_name: 'Test User' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewPR(5, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'curl',
        ['-sS', '-H', 'Authorization: Bearer test-token', 'https://api.bitbucket.org/2.0/repositories/user/repo/pullrequests/5'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      );
      expect(result).toEqual({
        title: 'Add feature',
        headBranch: 'feature/new',
        baseBranch: 'main',
        url: 'https://bitbucket.org/user/repo/pull-requests/5',
        body: 'Adds a new feature',
        author: 'Test User',
      });
    });

    it('uses Basic auth when username and app password are set', () => {
      delete process.env.BITBUCKET_TOKEN;
      process.env.BITBUCKET_USERNAME = 'myuser';
      process.env.BITBUCKET_APP_PASSWORD = 'mypass';
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'PR',
        source: { branch: { name: 'feat' } },
        destination: { branch: { name: 'main' } },
        links: { html: { href: '' } },
        description: '',
        author: { display_name: 'u' },
      }));

      provider.viewPR(1, 'owner', 'repo');

      const expectedAuth = `Basic ${Buffer.from('myuser:mypass').toString('base64')}`;
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'curl',
        ['-sS', '-H', `Authorization: ${expectedAuth}`, expect.stringContaining('pullrequests/1')],
        expect.any(Object),
      );
    });

    it('returns null when owner or repo is missing', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      expect(provider.viewPR(1)).toBeNull();
      expect(provider.viewPR(1, 'owner')).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns null when no auth is configured', () => {
      delete process.env.BITBUCKET_TOKEN;
      delete process.env.BITBUCKET_USERNAME;
      delete process.env.BITBUCKET_APP_PASSWORD;

      expect(provider.viewPR(1, 'owner', 'repo')).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns null when curl throws', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      mockExecFileSync.mockImplementation(() => {
        throw new Error('curl failed');
      });

      expect(provider.viewPR(1, 'owner', 'repo')).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewPR(-1, 'owner', 'repo')).toBeNull();
      expect(provider.viewPR(0, 'owner', 'repo')).toBeNull();
      expect(provider.viewPR(1.5, 'owner', 'repo')).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('viewIssue', () => {
    it('fetches issue via curl and parses response', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      const mockResponse = JSON.stringify({
        title: 'Bug report',
        content: { raw: 'Something is broken' },
        links: { html: { href: 'https://bitbucket.org/user/repo/issues/3' } },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewIssue(3, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'curl',
        ['-sS', '-H', 'Authorization: Bearer test-token', 'https://api.bitbucket.org/2.0/repositories/user/repo/issues/3'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Bug report',
        body: 'Something is broken',
        url: 'https://bitbucket.org/user/repo/issues/3',
      });
    });

    it('returns null when owner or repo is missing', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      expect(provider.viewIssue(1)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns null when curl throws', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      mockExecFileSync.mockImplementation(() => {
        throw new Error('curl failed');
      });

      expect(provider.viewIssue(1, 'owner', 'repo')).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewIssue(-1, 'owner', 'repo')).toBeNull();
      expect(provider.viewIssue(0, 'owner', 'repo')).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('returns true when BITBUCKET_TOKEN is set', () => {
      process.env.BITBUCKET_TOKEN = 'test-token';
      expect(provider.checkAuth()).toBe(true);
    });

    it('returns true when BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD are set', () => {
      delete process.env.BITBUCKET_TOKEN;
      process.env.BITBUCKET_USERNAME = 'user';
      process.env.BITBUCKET_APP_PASSWORD = 'pass';
      expect(provider.checkAuth()).toBe(true);
    });

    it('returns false when no auth is configured', () => {
      delete process.env.BITBUCKET_TOKEN;
      delete process.env.BITBUCKET_USERNAME;
      delete process.env.BITBUCKET_APP_PASSWORD;
      expect(provider.checkAuth()).toBe(false);
    });
  });
});
