import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('HUD marketplace resolution', () => {
  it('omcp-hud.mjs converts absolute HUD paths to file URLs before dynamic imports', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'omcp-hud-wrapper-'));
    tempDirs.push(configDir);

    const fakeHome = join(configDir, 'home');
    mkdirSync(fakeHome, { recursive: true });

    execFileSync(process.execPath, [join(root, 'scripts', 'plugin-setup.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        COPILOT_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    const hudScriptPath = join(configDir, 'hud', 'omcp-hud.mjs');
    expect(existsSync(hudScriptPath)).toBe(true);
    expect(existsSync(join(configDir, 'hud', 'lib', 'config-dir.mjs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')) as {
      statusLine?: { command?: string };
    };
    expect(settings.statusLine?.command).toContain(`${join(configDir, 'hud', 'omcp-hud.mjs').replace(/\\/g, '/')}`);
    if (process.platform !== 'win32') {
      expect(settings.statusLine?.command).toContain('omcp-hud-cache.sh');
      expect(existsSync(join(configDir, 'hud', 'omcp-hud-cache.sh'))).toBe(true);
      expect(existsSync(join(configDir, 'hud', 'find-node.sh'))).toBe(true);
    }
    expect(existsSync(join(configDir, '.omcp-config.json'))).toBe(true);

    const content = readFileSync(hudScriptPath, 'utf-8');
    expect(content).toContain('import { fileURLToPath, pathToFileURL } from "node:url"');
    expect(content).toContain('const { getCopilotConfigDir } = await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs")).href);');
    expect(content).toContain('await import(pathToFileURL(pluginPath).href);');
    expect(content).toContain('await import(pathToFileURL(envHudPath).href);');
    expect(content).toContain('await import(pathToFileURL(marketplaceHudPath).href);');
    expect(content).not.toContain('await import(pluginPath);');
    expect(content).not.toContain('await import(marketplaceHudPath);');
  });

  it('omcp-hud.mjs loads a marketplace install when plugin cache is unavailable', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'omcp-hud-marketplace-'));
    tempDirs.push(configDir);

    const fakeHome = join(configDir, 'home');
    mkdirSync(fakeHome, { recursive: true });

    const sentinelPath = join(configDir, 'marketplace-loaded.txt');
    const marketplaceRoot = join(configDir, 'plugins', 'marketplaces', 'omg');
    const marketplaceHudDir = join(marketplaceRoot, 'dist', 'hud');
    mkdirSync(marketplaceHudDir, { recursive: true });
    writeFileSync(join(marketplaceRoot, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(marketplaceHudDir, 'index.js'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'marketplace-loaded');\n`
    );

    execFileSync(process.execPath, [join(root, 'scripts', 'plugin-setup.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        COPILOT_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    const hudScriptPath = join(configDir, 'hud', 'omcp-hud.mjs');
    expect(existsSync(hudScriptPath)).toBe(true);

    execFileSync(process.execPath, [hudScriptPath], {
      cwd: root,
      env: {
        ...process.env,
        COPILOT_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    expect(readFileSync(sentinelPath, 'utf-8')).toBe('marketplace-loaded');
  });
});
