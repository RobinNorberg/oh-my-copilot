import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendFileNoFollow } from '../append-no-follow.js';

// The POSIX branch needs O_NOFOLLOW, which Windows lacks; the lstat branch runs everywhere.
const branches: NodeJS.Platform[] = process.platform === 'win32' ? ['win32'] : [process.platform, 'win32'];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-nofollow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.each(branches)('appendFileNoFollow (%s branch)', (platform) => {
  it('creates the file, then appends to it', () => {
    const log = join(dir, 'debug.log');
    expect(appendFileNoFollow(log, 'one\n', platform)).toBe(true);
    expect(appendFileNoFollow(log, 'two\n', platform)).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a symlink (or, where file symlinks need privileges, a junction) planted at the path', () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep\n');
    const log = join(dir, 'recovery-debug.log');
    try {
      symlinkSync(victim, log, 'file');
    } catch {
      // Windows without symlink rights: a junction is the link a lane can always make.
      mkdirSync(join(dir, 'target'));
      symlinkSync(join(dir, 'target'), log, 'junction');
    }
    expect(appendFileNoFollow(log, 'pwned\n', platform)).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  it('refuses a hard link to another file', () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep\n');
    const log = join(dir, 'comment-checker-debug.log');
    linkSync(victim, log);
    expect(appendFileNoFollow(log, 'pwned\n', platform)).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });
});
