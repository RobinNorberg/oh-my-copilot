import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCopilotConfigDir = process.env.COPILOT_CONFIG_DIR;
const originalPluginRoot = process.env.PLUGIN_ROOT;
const originalHome = process.env.HOME;

let tempRoot: string;
let testCopilotDir: string;
let testHomeDir: string;

// In vitest __dirname resolves to src/installer, so getPackageDir() returns
// src/ — but docs/copilot-instructions.md lives at the repo root.  Create a
// symlink (or copy) so the installer can find it during tests.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __test_dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
// __test_dirname = src/installer/__tests__  →  ../.. = src/  (matches getPackageDir() in vitest)
const packageDir = join(__test_dirname, '..', '..');
const docsDir = join(packageDir, 'docs');
const docsSource = join(packageDir, '..', 'docs', 'copilot-instructions.md');

async function loadInstaller() {
  // Ensure src/docs/copilot-instructions.md exists so loadClaudeMdContent() succeeds
  if (!existsSync(join(docsDir, 'copilot-instructions.md')) && existsSync(docsSource)) {
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, 'copilot-instructions.md'),
      readFileSync(docsSource, 'utf-8'),
    );
  }
  vi.resetModules();
  return import('../index.js');
}

describe('install() copilot-instructions.md target resolution', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-copilot-target-'));
    testCopilotDir = join(tempRoot, 'global-copilot');
    testHomeDir = join(tempRoot, 'home');

    mkdirSync(testCopilotDir, { recursive: true });
    mkdirSync(testHomeDir, { recursive: true });

    process.env.COPILOT_CONFIG_DIR = testCopilotDir;
    process.env.HOME = testHomeDir;
    delete process.env.PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    // Clean up src/docs/ created by loadInstaller()
    rmSync(docsDir, { recursive: true, force: true });

    if (originalCopilotConfigDir !== undefined) {
      process.env.COPILOT_CONFIG_DIR = originalCopilotConfigDir;
    } else {
      delete process.env.COPILOT_CONFIG_DIR;
    }

    if (originalPluginRoot !== undefined) {
      process.env.PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.PLUGIN_ROOT;
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }

    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('updates ~/.copilot/copilot-instructions.md even when ~/copilot-instructions.md exists', async () => {
    const configInstructionsPath = join(testCopilotDir, 'copilot-instructions.md');
    const homeInstructionsPath = join(testHomeDir, 'copilot-instructions.md');

    writeFileSync(homeInstructionsPath, '# Home copilot-instructions\nkeep me\n');
    writeFileSync(
      configInstructionsPath,
      '<!-- OMG:START -->\n<!-- OMC:VERSION:0.0.1 -->\n# Old OMC\nstale installer content\n<!-- OMG:END -->\n',
    );

    const { install, VERSION } = await loadInstaller();
    const result = install({
      force: true,
      skipCopilotCheck: true,
      skipHud: true,
    });

    const updatedConfig = readFileSync(configInstructionsPath, 'utf-8');

    expect(result.success).toBe(true);
    expect(updatedConfig).toContain(`<!-- OMC:VERSION:${VERSION} -->`);
    expect(updatedConfig).not.toContain('stale installer content');
    expect(readFileSync(homeInstructionsPath, 'utf-8')).toBe('# Home copilot-instructions\nkeep me\n');

    const backups = readdirSync(testCopilotDir).filter(name => name.startsWith('copilot-instructions.md.backup.'));
    expect(backups).toHaveLength(1);
  });

  it('preserves project-scoped behavior by skipping global copilot-instructions.md writes', async () => {
    process.env.PLUGIN_ROOT = join(tempRoot, 'project', '.copilot', 'plugins', 'oh-my-copilot');
    writeFileSync(join(testHomeDir, 'copilot-instructions.md'), '# Home copilot-instructions\nkeep me\n');

    const { install } = await loadInstaller();
    const result = install({
      force: true,
      skipCopilotCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(testCopilotDir, 'copilot-instructions.md'))).toBe(false);
  });
});
