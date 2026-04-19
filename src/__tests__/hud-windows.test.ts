import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { getPluginCacheBase } from '../utils/paths.js';

/**
 * HUD Windows Compatibility Tests
 *
 * These tests verify Windows compatibility fixes for HUD:
 * - File naming (omcp-hud.mjs)
 * - Windows dynamic import() requires file:// URLs (pathToFileURL)
 * - Version sorting (numeric vs lexicographic)
 * - Cross-platform plugin cache path resolution (#670)
 *
 * Related: GitHub Issue #138, PR #139, PR #140, Issue #670
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..');

describe('HUD Windows Compatibility', () => {
  describe('File Naming', () => {
    it('session-start.mjs should reference omcp-hud.mjs', () => {
      const sessionStartPath = join(packageRoot, 'scripts', 'session-start.mjs');
      expect(existsSync(sessionStartPath)).toBe(true);

      const content = readFileSync(sessionStartPath, 'utf-8');
      expect(content).toContain('omcp-hud.mjs');
      // Note: May also contain 'omcp-hud.mjs' for backward compatibility (dual naming)
    });

    it('installer should create omcp-hud.mjs', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      expect(existsSync(installerPath)).toBe(true);

      const content = readFileSync(installerPath, 'utf-8');
      expect(content).toContain('omcp-hud.mjs');
      // Note: May also contain 'omcp-hud.mjs' for legacy support
    });
  });

  describe('pathToFileURL for Dynamic Import', () => {
    it('installer HUD script should import pathToFileURL', () => {
      const templatePath = join(packageRoot, 'scripts', 'lib', 'hud-wrapper-template.txt');
      const content = readFileSync(templatePath, 'utf-8');

      // Should have pathToFileURL import in the HUD wrapper template
      expect(content).toContain('pathToFileURL');
    });

    it('installer HUD script should use pathToFileURL for dev path import', () => {
      const templatePath = join(packageRoot, 'scripts', 'lib', 'hud-wrapper-template.txt');
      const content = readFileSync(templatePath, 'utf-8');

      // Should use pathToFileURL for resolved HUD path
      expect(content).toContain('pathToFileURL(resolvedHudPath).href');
    });

    it('installer HUD script should use pathToFileURL for plugin path import', () => {
      const templatePath = join(packageRoot, 'scripts', 'lib', 'hud-wrapper-template.txt');
      const content = readFileSync(templatePath, 'utf-8');

      // Should use pathToFileURL for resolved HUD path imports
      expect(content).toContain('pathToFileURL(resolvedHudPath).href');
    });

    it('pathToFileURL should correctly convert Unix paths', () => {
      const unixPath = '/home/user/test.js';
      expect(pathToFileURL(unixPath).href).toBe(
        process.platform === 'win32'
          ? 'file:///C:/home/user/test.js'
          : 'file:///home/user/test.js'
      );
    });

    it('pathToFileURL should encode spaces in paths', () => {
      const spacePath = '/path/with spaces/file.js';
      expect(pathToFileURL(spacePath).href).toBe(
        process.platform === 'win32'
          ? 'file:///C:/path/with%20spaces/file.js'
          : 'file:///path/with%20spaces/file.js'
      );
    });
  });

  describe('Numeric Version Sorting', () => {
    it('installer HUD script should use numeric version sorting', () => {
      const templatePath = join(packageRoot, 'scripts', 'lib', 'hud-wrapper-template.txt');
      const content = readFileSync(templatePath, 'utf-8');

      // Should use localeCompare with numeric option
      expect(content).toContain('localeCompare(String(ai), undefined, { numeric: true })');
    });

    it('numeric sort should correctly order versions', () => {
      const versions = ['3.5.0', '3.10.0', '3.9.0'];

      // Incorrect lexicographic sort
      const lexSorted = [...versions].sort().reverse();
      expect(lexSorted[0]).toBe('3.9.0'); // Wrong! 9 > 1 lexicographically

      // Correct numeric sort
      const numSorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(numSorted[0]).toBe('3.10.0'); // Correct! 10 > 9 > 5 numerically
    });

    it('should handle single-digit and double-digit versions', () => {
      const versions = ['1.0.0', '10.0.0', '2.0.0', '9.0.0'];
      const sorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(sorted).toEqual(['10.0.0', '9.0.0', '2.0.0', '1.0.0']);
    });

    it('should handle patch version comparison', () => {
      const versions = ['1.0.1', '1.0.10', '1.0.9', '1.0.2'];
      const sorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(sorted).toEqual(['1.0.10', '1.0.9', '1.0.2', '1.0.1']);
    });
  });

  describe('safeMode override (#346)', () => {
    it('safeMode logic: explicit false overrides platform detection', () => {
      // Simulate the logic from src/hud/index.ts
      const resolveSafeMode = (safeMode: boolean, isWin32: boolean) =>
        safeMode !== false && (safeMode || isWin32);

      // explicit false: disabled even on Windows
      expect(resolveSafeMode(false, true)).toBe(false);
      expect(resolveSafeMode(false, false)).toBe(false);
      // explicit true: always enabled
      expect(resolveSafeMode(true, false)).toBe(true);
      expect(resolveSafeMode(true, true)).toBe(true);
      // default true on Windows: enabled
      expect(resolveSafeMode(true, true)).toBe(true);
    });

    it('hud index.ts should use explicit-false override for safeMode', () => {
      const indexPath = join(packageRoot, 'src', 'hud', 'index.ts');
      const content = readFileSync(indexPath, 'utf-8');
      expect(content).toContain('config.elements.safeMode !== false');
    });
  });

  describe('Cross-Platform Plugin Cache Path (#670)', () => {
    it('getPluginCacheBase should return path with correct segments', () => {
      const cachePath = getPluginCacheBase();
      // Should contain the expected path segments regardless of separator
      const normalized = cachePath.replace(/\\/g, '/');
      expect(normalized).toContain('plugins/cache/omg/oh-my-copilot');
    });

    it('getPluginCacheBase should use platform-native separators', () => {
      const cachePath = getPluginCacheBase();
      // On Windows: backslashes, on Unix: forward slashes
      expect(cachePath).toContain(`plugins${sep}cache${sep}omg${sep}oh-my-copilot`);
    });

    it('getPluginCacheBase should be under copilot config dir', () => {
      const cachePath = getPluginCacheBase();
      const configDir = getCopilotConfigDir();
      expect(cachePath.startsWith(configDir)).toBe(true);
    });

    it('plugin-setup.mjs should use pathToFileURL for dynamic imports', () => {
      const setupPath = join(packageRoot, 'scripts', 'plugin-setup.mjs');
      const content = readFileSync(setupPath, 'utf-8');

      // Should import pathToFileURL
      expect(content).toContain('pathToFileURL } from "node:url"');
      // Should use pathToFileURL for the dynamic import
      expect(content).toContain('pathToFileURL(pluginPath).href');
    });

    it('shared HUD wrapper template uses shell:true only for Windows npm root discovery', () => {
      const templatePath = join(packageRoot, 'scripts', 'lib', 'hud-wrapper-template.txt');
      const content = readFileSync(templatePath, 'utf-8');
      expect(content).toContain('const isWin = process.platform === "win32";');
      expect(content).toContain('const npmCommand = isWin ? "npm.cmd" : "npm";');
      expect(content).toContain('shell: isWin');
      expect(content).not.toContain('shell: true');
    });

    it('plugin-setup.mjs should respect COPILOT_CONFIG_DIR for plugin cache base', () => {
      const setupPath = join(packageRoot, 'scripts', 'plugin-setup.mjs');
      const content = readFileSync(setupPath, 'utf-8');

      // Should use getCopilotConfigDir() which reads COPILOT_CONFIG_DIR internally (#897)
      expect(content).toContain('getCopilotConfigDir()');
      // Should use join() with configDir for path construction
      expect(content).toContain('join(configDir,');
    });

    it('omc-doctor skill should use cross-platform Node.js commands', () => {
      const doctorPath = join(packageRoot, 'skills', 'omc-doctor', 'SKILL.md');
      const content = readFileSync(doctorPath, 'utf-8');

      // Should NOT use ~ for plugin cache paths in bash commands
      expect(content).not.toMatch(/ls ~\/\.copilot\/plugins\/cache/);
      // Should use node -e for cross-platform compatibility
      expect(content).toContain("node -e");
      // Should use path.join for constructing paths
      expect(content).toContain("p.join(d,'plugins','cache','omg','oh-my-copilot')");
    });

    // hud skill test removed — skill deleted (Copilot doesn't support custom HUDs)

    it('usage-api should use path.join with separate segments', () => {
      const usageApiPath = join(packageRoot, 'src', 'hud', 'usage-api.ts');
      const content = readFileSync(usageApiPath, 'utf-8');

      // Should use join() with separate segments, not forward-slash literals
      expect(content).toContain("'plugins', 'oh-my-copilot', '.usage-cache.json'");
    });
  });
});
