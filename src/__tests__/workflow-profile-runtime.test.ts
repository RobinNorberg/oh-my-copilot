/**
 * Focused unit test for scripts/lib/workflow-profile-runtime.mjs (and its
 * templates/hooks/lib copy): selectWorkflowProfile()'s project config file
 * resolution must prefer the canonical .copilot/omg.jsonc over the legacy
 * .copilot/omc.jsonc name (mirrors src/config/project-config-path.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'workflow-profile-runtime.mjs');

const WORKFLOW_NAME = 'config-naming-precedence-test';

function workflowConfig(stages: string[]): string {
  return JSON.stringify({ autopilot: { workflows: { [WORKFLOW_NAME]: { version: 1, stages } } } });
}

// Stage the template lib the way the standalone installer does: the
// templates/hooks/lib files, with config-dir and state-lock provisioned from
// scripts/lib (templates/hooks/lib/state-lock.mjs is an unprovisioned stub
// that throws until the installer copies the real one over it).
let templateModulePath: string;

beforeAll(() => {
  const stageRoot = mkdtempSync(join(tmpdir(), 'workflow-profile-runtime-template-'));
  const libDir = join(stageRoot, 'lib');
  mkdirSync(libDir, { recursive: true });
  const templateLibDir = join(REPO_ROOT, 'templates', 'hooks', 'lib');
  for (const file of readdirSync(templateLibDir)) {
    copyFileSync(join(templateLibDir, file), join(libDir, file));
  }
  for (const file of ['config-dir.mjs', 'state-lock.mjs']) {
    copyFileSync(join(REPO_ROOT, 'scripts', 'lib', file), join(libDir, file));
  }
  templateModulePath = join(libDir, 'workflow-profile-runtime.mjs');
});

describe.each([
  ['scripts/lib/workflow-profile-runtime.mjs', () => SCRIPT_MODULE_PATH],
  ['templates/hooks/lib/workflow-profile-runtime.mjs (installed layout)', () => templateModulePath],
])('%s selectWorkflowProfile project config precedence', (_name, modulePath) => {
  let project: string;
  let originalAppData: string | undefined;
  let originalXdg: string | undefined;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'workflow-profile-runtime-'));
    execFileSync('git', ['init', '-q'], { cwd: project });
    // Isolate from the real user-level config.jsonc on this machine.
    originalAppData = process.env.APPDATA;
    originalXdg = process.env.XDG_CONFIG_HOME;
    const emptyUserConfigHome = mkdtempSync(join(tmpdir(), 'workflow-profile-runtime-home-'));
    process.env.APPDATA = emptyUserConfigHome;
    process.env.XDG_CONFIG_HOME = emptyUserConfigHome;
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  async function select(): Promise<{ stages: string[] }> {
    const { selectWorkflowProfile } = await import(pathToFileURL(modulePath()).href);
    return selectWorkflowProfile(project, WORKFLOW_NAME);
  }

  it('prefers the canonical .copilot/omg.jsonc over a legacy .copilot/omc.jsonc', async () => {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(join(project, '.copilot', 'omg.jsonc'), workflowConfig(['ralplan', 'execution']));
    writeFileSync(join(project, '.copilot', 'omc.jsonc'), workflowConfig(['ralplan', 'execution', 'ralph']));
    const profile = await select();
    expect(profile.stages).toEqual(['ralplan', 'execution']);
  });

  it('falls back to the legacy .copilot/omc.jsonc when the canonical file is absent', async () => {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(join(project, '.copilot', 'omc.jsonc'), workflowConfig(['ralplan', 'execution', 'qa']));
    const profile = await select();
    expect(profile.stages).toEqual(['ralplan', 'execution', 'qa']);
  });
});
