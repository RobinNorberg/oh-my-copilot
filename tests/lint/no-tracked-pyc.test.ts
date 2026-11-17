import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `git add -f bridge` after a build once committed a Python bytecode cache
// (bridge/__pycache__/*.pyc); .gitignore does not stop a forced add.
describe('Python bytecode stays untracked', () => {
  it('git tracks no .pyc files or __pycache__ directories', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((p) => /\.pyc$|(^|\/)__pycache__\//.test(p));
    expect(tracked).toEqual([]);
  });
});
