import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { AzureDevOpsProvider } from '../../providers/azure-devops.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('AzureDevOpsProvider - extended', () => {
  let provider: AzureDevOpsProvider;

  beforeEach(() => {
    provider = new AzureDevOpsProvider();
    vi.clearAllMocks();
  });

  describe('escapeWiql', () => {
    it('doubles single quotes', () => {
      expect(provider.escapeWiql("O'Brien")).toBe("O''Brien");
    });

    it('handles string with no single quotes', () => {
      expect(provider.escapeWiql('Active')).toBe('Active');
    });

    it('handles empty string', () => {
      expect(provider.escapeWiql('')).toBe('');
    });

    it('handles multiple single quotes', () => {
      expect(provider.escapeWiql("it's a dog's life")).toBe("it''s a dog''s life");
    });
  });

  describe('listWorkItems - WIQL query construction', () => {
    const makeWorkItemResponse = (overrides: object = {}) =>
      JSON.stringify([
        {
          id: 1,
          fields: {
            'System.Title': 'Test item',
            'System.State': 'Active',
            'System.Tags': '',
            ...overrides,
          },
        },
      ]);

    it('queries with state filter', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ state: 'Active' });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("[System.State] = 'Active'");
    });

    it('queries with tag filter', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ tags: ['backend'] });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("[System.Tags] Contains 'backend'");
    });

    it('queries with multiple tag filters combined with AND', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ tags: ['backend', 'urgent'] });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("[System.Tags] Contains 'backend'");
      expect(wiql).toContain("[System.Tags] Contains 'urgent'");
      expect(wiql).toContain(' AND ');
    });

    it('queries with state and tag filters combined', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ state: 'Active', tags: ['sprint-1'] });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("[System.State] = 'Active'");
      expect(wiql).toContain("[System.Tags] Contains 'sprint-1'");
    });

    it('escapes single quotes in state value', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ state: "O'Brien's state" });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("O''Brien''s state");
    });

    it('escapes single quotes in tag values', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ tags: ["dev's tag"] });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain("dev''s tag");
    });

    it('includes ORDER BY clause', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({});

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const wiql = args[args.indexOf('--wiql') + 1];
      expect(wiql).toContain('ORDER BY [System.CreatedDate] DESC');
    });

    it('passes org flag when provided', () => {
      mockExecFileSync.mockReturnValue(makeWorkItemResponse());

      provider.listWorkItems({ org: 'https://dev.azure.com/myorg' });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args).toContain('--org');
      expect(args).toContain('https://dev.azure.com/myorg');
    });

    it('throws AdoError when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('az: not found');
      });

      expect(() => provider.listWorkItems({})).toThrow('az: not found');
    });

    it('applies pagination with top and skip', () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify([
          { id: 1, fields: { 'System.Title': 'Item 1', 'System.State': 'Active', 'System.Tags': '' } },
          { id: 2, fields: { 'System.Title': 'Item 2', 'System.State': 'Active', 'System.Tags': '' } },
          { id: 3, fields: { 'System.Title': 'Item 3', 'System.State': 'Active', 'System.Tags': '' } },
        ]),
      );

      const items = provider.listWorkItems({ top: 2, skip: 1 });

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe(2);
      expect(items[1].id).toBe(3);
    });

    it('normalizes tags from semicolon-separated string', () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify([
          {
            id: 5,
            fields: {
              'System.Title': 'Tagged item',
              'System.State': 'Active',
              'System.Tags': 'backend; urgent; sprint-1',
            },
          },
        ]),
      );

      const items = provider.listWorkItems({});

      expect(items[0].tags).toEqual(['backend', 'urgent', 'sprint-1']);
    });
  });

  describe('listPRsForReviewer', () => {
    const makePRListResponse = () =>
      JSON.stringify([
        {
          title: 'Fix auth bug',
          sourceRefName: 'refs/heads/fix/auth',
          targetRefName: 'refs/heads/main',
          url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
          description: 'Fixes login timeout',
          createdBy: { displayName: 'Alice' },
        },
      ]);

    it('passes --reviewer flag with email', () => {
      mockExecFileSync.mockReturnValue(makePRListResponse());

      provider.listPRsForReviewer('bob@example.com');

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args).toContain('--reviewer');
      expect(args).toContain('bob@example.com');
    });

    it('returns PRInfo array with stripped branch refs', () => {
      mockExecFileSync.mockReturnValue(makePRListResponse());

      const prs = provider.listPRsForReviewer('bob@example.com');

      expect(prs).toHaveLength(1);
      expect(prs[0].title).toBe('Fix auth bug');
      expect(prs[0].headBranch).toBe('fix/auth');
      expect(prs[0].baseBranch).toBe('main');
      expect(prs[0].author).toBe('Alice');
    });

    it('passes org, project, and repository options', () => {
      mockExecFileSync.mockReturnValue(makePRListResponse());

      provider.listPRsForReviewer('bob@example.com', {
        org: 'https://dev.azure.com/myorg',
        project: 'myproject',
        repository: 'myrepo',
      });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args).toContain('--org');
      expect(args).toContain('https://dev.azure.com/myorg');
      expect(args).toContain('--project');
      expect(args).toContain('myproject');
      expect(args).toContain('--repository');
      expect(args).toContain('myrepo');
    });

    it('throws AdoError when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('az: not found');
      });

      expect(() => provider.listPRsForReviewer('bob@example.com')).toThrow('az: not found');
    });
  });

  describe('getPRDiff', () => {
    const SRC = 'a'.repeat(40);
    const TGT = 'b'.repeat(40);
    const prJson = JSON.stringify({
      sourceRefName: 'refs/heads/feature/x',
      targetRefName: 'refs/heads/main',
      lastMergeSourceCommit: { commitId: SRC },
      lastMergeTargetCommit: { commitId: TGT },
    });

    function fakeExec(diff: string) {
      mockExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'az') return prJson;
        if (args[0] === 'fetch') return '';
        return diff;
      }) as unknown as typeof execFileSync);
    }

    it('reads the PR with az repos pr show, fetches both refs, then runs git diff', () => {
      fakeExec('diff --git a/file.ts b/file.ts\n');

      const result = provider.getPRDiff(42, 'https://dev.azure.com/myorg');

      expect(result).toBe('diff --git a/file.ts b/file.ts\n');
      const calls = mockExecFileSync.mock.calls.map((c) => [c[0], c[1] as string[]] as const);
      expect(calls[0][0]).toBe('az');
      expect(calls[0][1]).toEqual(['repos', 'pr', 'show', '--id', '42', '--output', 'json', '--org', 'https://dev.azure.com/myorg']);
      expect(calls[1]).toEqual(['git', ['fetch', '--no-tags', 'origin', 'refs/pull/42/merge']]);
      expect(calls[2]).toEqual(['git', ['diff', `${TGT}...${SRC}`]]);
    });

    it('falls back to the branch refs when the merge ref cannot be fetched', () => {
      const gitCalls: string[][] = [];
      mockExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'az') return prJson;
        gitCalls.push(args);
        if (args[0] === 'fetch' && args[3] === 'refs/pull/42/merge') throw new Error('no such ref');
        return args[0] === 'diff' ? 'D' : '';
      }) as unknown as typeof execFileSync);

      expect(provider.getPRDiff(42)).toBe('D');
      expect(gitCalls[1]).toEqual(['fetch', '--no-tags', 'origin', 'refs/heads/feature/x', 'refs/heads/main']);
    });

    it.each(['refs/heads/a:b', 'refs/heads/a b'])('refuses ref %s', (ref) => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        sourceRefName: ref,
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: SRC },
        lastMergeTargetCommit: { commitId: TGT },
      }));

      expect(() => provider.getPRDiff(42)).toThrow('missing source/target refs');
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('never calls an az diff subcommand', () => {
      fakeExec('');

      provider.getPRDiff(42);

      for (const [cmd, args] of mockExecFileSync.mock.calls) {
        expect(cmd === 'az' && (args as string[]).includes('diff')).toBe(false);
      }
    });

    it('returns empty string for invalid PR ID', () => {
      const result = provider.getPRDiff(-1);

      expect(result).toBe('');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('rejects a PR whose merge commits are missing or malformed', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        sourceRefName: 'refs/heads/f',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: '--upload-pack=x' },
        lastMergeTargetCommit: { commitId: TGT },
      }));

      expect(() => provider.getPRDiff(42)).toThrow('missing source/target refs');
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('throws AdoError when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('az: not found');
      });

      expect(() => provider.getPRDiff(42)).toThrow('az: not found');
    });
  });
});
