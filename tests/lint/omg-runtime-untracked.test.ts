import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// .omg/ is runtime state (see .gitignore); only .omg/skills/ is committable.
// A tracked runtime file such as .omg/projection-manifest.json, whose
// generatedAt changes on every `npm run build`, enters the inventory graph's
// sourceSha256, so any build before the tests fails inventory verify (v5.19.0).
describe('.omg/ runtime state stays untracked', () => {
  it('git tracks nothing under .omg/ except .omg/skills/', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', '.omg'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((p) => !p.startsWith('.omg/skills/'));
    expect(tracked).toEqual([]);
  });
});
