import { describe, expect, it } from 'vitest';

import type { Exec } from '../../../ship/exec.js';
import { ghPrMergeability, githubReviews } from '../reviews.js';

const HEAD = 'a'.repeat(40);

function gh(body: unknown, status = 0): { exec: Exec; argv: string[][] } {
  const argv: string[][] = [];
  const exec: Exec = (_cmd, args) => {
    argv.push(args);
    return { status, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: status ? 'HTTP 502' : '' };
  };
  return { exec, argv };
}

describe('ghPrMergeability', () => {
  it('reads headRefOid,mergeable,mergeStateStatus and names a conflict only for CONFLICTING or DIRTY', () => {
    const { exec, argv } = gh({ headRefOid: HEAD, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(ghPrMergeability(exec, 545, '.')).toEqual({ state: 'conflicting', headRefOid: HEAD });
    expect(argv).toEqual([['pr', 'view', '545', '--json', 'headRefOid,mergeable,mergeStateStatus']]);
    expect(ghPrMergeability(gh({ headRefOid: HEAD, mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }).exec, 1, '.').state).toBe('conflicting');
    expect(ghPrMergeability(gh({ headRefOid: HEAD, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }).exec, 1, '.')).toEqual({ state: 'mergeable', headRefOid: HEAD });
  });

  it('UNKNOWN (GitHub computes it lazily) and anything unexpected are unknown; a malformed head is left out', () => {
    expect(ghPrMergeability(gh({ headRefOid: HEAD, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }).exec, 1, '.')).toEqual({ state: 'unknown', headRefOid: HEAD });
    expect(ghPrMergeability(gh({ mergeable: 'CONFLICTING', headRefOid: 'nope' }).exec, 1, '.')).toEqual({ state: 'conflicting' });
    expect(ghPrMergeability(gh({ mergeable: 42 }).exec, 1, '.')).toEqual({ state: 'unknown' });
  });

  it('a failed read or no JSON throws (the engine treats it as unknown)', () => {
    expect(() => ghPrMergeability(gh('', 1).exec, 1, '.')).toThrow();
    expect(() => ghPrMergeability(gh('not json').exec, 1, '.')).toThrow(/no JSON/);
  });

  it('is the GitHub forge reviews\' mergeability', () => {
    const { exec } = gh({ headRefOid: HEAD, mergeable: 'CONFLICTING' });
    expect(githubReviews(exec, '.').mergeability!(7)).toEqual({ state: 'conflicting', headRefOid: HEAD });
  });
});
