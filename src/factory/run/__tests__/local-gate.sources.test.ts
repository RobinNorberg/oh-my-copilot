import { describe, expect, it } from 'vitest';
import { gateDefinitionSources } from '../local-gate.js';

describe('gate definitions that the repository cannot pin park as unknown', () => {
  it('npx fetches registry code: unresolved, in any spelling', () => {
    for (const gate of [['npx', 'vitest'], ['npx.cmd', '-y', 'eslint', '.'], ['C:\\tools\\npx.exe', 'x'], ['/usr/bin/npx', 'x']]) {
      const out = gateDefinitionSources(gate);
      expect(out.sources, gate.join(' ')).toEqual([]);
      expect(out.unresolved, gate.join(' ')).toMatch(/runs npx, which fetches and runs registry code/);
    }
  });

  it('a bare binary is looked up on PATH, so no repository file defines it', () => {
    for (const gate of [['vitest'], ['cargo', 'test'], ['make', 'check'], ['pytest.exe', '-q']]) {
      const out = gateDefinitionSources(gate);
      expect(out.sources, gate.join(' ')).toEqual([]);
      expect(out.unresolved, gate.join(' ')).toMatch(/from PATH, and the repository holds no file that defines it/);
    }
  });

  it('a gate named by a path keeps its file as the definition, and node keeps its script', () => {
    expect(gateDefinitionSources(['./ci/gate.sh'])).toEqual({ sources: [{ path: 'ci/gate.sh' }] });
    expect(gateDefinitionSources(['node_modules/.bin/vitest', 'run'])).toEqual({ sources: [{ path: 'node_modules/.bin/vitest' }] });
    expect(gateDefinitionSources(['node', 'scripts/gate.mjs'])).toEqual({ sources: [{ path: 'scripts/gate.mjs' }] });
  });

  it('a program outside the repository is unresolved with or without arguments (make and pytest read repository files implicitly)', () => {
    for (const gate of [['/usr/bin/make'], ['/usr/local/bin/pytest'], ['C:/Python312/Scripts/pytest.exe'], ['/usr/local/bin/gate']]) {
      const out = gateDefinitionSources(gate);
      expect(out.sources, gate[0]).toEqual([]);
      expect(out.unresolved, gate[0]).toMatch(/a program outside the repository/);
    }
  });

  it('node options before the script park, except --run, which is npm run', () => {
    expect(gateDefinitionSources(['node', '--run', 'test'])).toEqual(gateDefinitionSources(['npm', 'run', 'test']));
    for (const gate of [
      ['node', '-e', "require('./scripts/gate.js')"],
      ['node', '-r', './hook.js', 'scripts/gate.mjs'],
      ['node', '--import', './x.mjs', 'scripts/gate.mjs'],
      ['node', '--test'],
    ]) {
      const out = gateDefinitionSources(gate);
      expect(out.sources, gate.join(' ')).toEqual([]);
      expect(out.unresolved, gate.join(' ')).toMatch(/option/);
    }
    expect(gateDefinitionSources(['node', '.yarn/releases/yarn-4.1.0.cjs', 'test'])).toEqual(gateDefinitionSources(['yarn', 'test']));
    expect(gateDefinitionSources(['node', 'scripts/gate.mjs'])).toEqual({ sources: [{ path: 'scripts/gate.mjs' }] });
  });

  it('npm-style gates are unchanged', () => {
    expect(gateDefinitionSources(['npm', 'test']).unresolved).toBeUndefined();
    expect(gateDefinitionSources(['pnpm', 'lint']).unresolved).toBeUndefined();
  });

  it('a program outside the repository that takes arguments parks, like its bare name', () => {
    for (const gate of [
      ['/bin/sh', 'scripts/ci.sh'],
      ['/usr/bin/env', 'npx', 'vitest'],
      ['/usr/bin/python3', 'tools/test.py'],
      ['/home/u/.cargo/bin/cargo', 'test'],
      ['C:\\Program Files\\Git\\bin\\sh.exe', 'scripts\\ci.sh'],
      ['C:/tools/cargo.exe', 'test'],
    ]) {
      const out = gateDefinitionSources(gate);
      expect(out.sources, gate.join(' ')).toEqual([]);
      expect(out.unresolved, gate.join(' ')).toMatch(/a program outside the repository/);
    }
  });

  it('npx-cli.js, pnpm.js and yarn.js run through node map to their bare forms', () => {
    for (const target of ['/usr/lib/node_modules/npm/bin/npx-cli.js', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js']) {
      expect(gateDefinitionSources(['node', target, 'vitest']).unresolved, target).toMatch(/runs npx/);
    }
    for (const [file, bare] of [['pnpm.cjs', 'pnpm'], ['pnpm.js', 'pnpm'], ['yarn.js', 'yarn']]) {
      const target = `C:\\Users\\u\\corepack\\${file}`;
      expect(gateDefinitionSources(['node', target, 'test']), file).toEqual(gateDefinitionSources([bare, 'test']));
      expect(gateDefinitionSources(['node', target, 'dlx', 'x']).unresolved, file).toMatch(/dlx/);
    }
  });
});
