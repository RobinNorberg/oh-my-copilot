/**
 * Regression test for #4217: Ensure contained-fs native module can be built and packaged
 *
 * This test verifies that:
 * - The build scripts exist and are configured correctly
 * - The package declares no npm install script (the darwin addon is built on demand)
 * - Required files are in the package.json files array
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contained-fs packaging (#4217)', () => {
  const packageJsonPath = resolve('package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

  it('build:contained-fs script exists', () => {
    expect(packageJson.scripts['build:contained-fs']).toBeDefined();
  });

  it('declares no npm install script', () => {
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(packageJson.scripts[hook], hook).toBeUndefined();
    }
  });

  it('native build script file exists', () => {
    expect(existsSync(resolve('scripts/build-contained-fs.mjs'))).toBe(true);
  });

  it('verify-graph-contained-fs script exists', () => {
    expect(existsSync(resolve('scripts/verify-graph-contained-fs.mjs'))).toBe(true);
  });

  it('native source file exists', () => {
    expect(existsSync(resolve('native/contained-fs.c'))).toBe(true);
  });

  it('required files are in package.json files array', () => {
    const files = packageJson.files;
    expect(files).toContain('scripts/build-contained-fs.mjs');
    expect(files).toContain('scripts/verify-graph-contained-fs.mjs');
    expect(files).toContain('native');
  });

  it('build script is explicit: no --optional skip mode (no install script calls it)', () => {
    const content = readFileSync(resolve('scripts/build-contained-fs.mjs'), 'utf-8');
    expect(content).not.toContain("'--optional'");
  });
});
