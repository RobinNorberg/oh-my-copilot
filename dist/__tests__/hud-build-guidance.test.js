import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');
describe('HUD build/load guidance', () => {
    it('session-start checks legacy hud script name and build guidance', () => {
        const content = readFileSync(join(root, 'scripts', 'session-start.mjs'), 'utf-8');
        // Emission is omg-only; detection must still match the names 4.13.x wrote
        // into this config dir, or an unrefreshed install reads as "HUD missing".
        expect(content).toContain("const HUD_SCRIPT_NAMES = ['omg-hud.mjs', 'omcp-hud.mjs', 'omcp-hud.js'];");
        expect(content).toContain("const HUD_COMMAND_MARKERS = ['omg-hud', 'omcp-hud'];");
        expect(content).toContain('HUD plugin cache is not built. Run: cd');
        expect(content).toContain('npm install && npm run build');
    });
    it('shared HUD wrapper template resolves marketplace installs before fallback guidance', () => {
        // Both install paths now read from this single source of truth
        // (plan: binary-weaving-mountain).
        const content = readFileSync(join(root, 'scripts', 'lib', 'hud-wrapper-template.txt'), 'utf-8');
        expect(content).toContain('join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js")');
        expect(content).toContain('pathToFileURL(marketplaceHudPath).href');
        expect(content).toContain('"oh-my-copilot/dist/hud/index.js"');
        expect(content).toContain('"oh-my-copilot/dist/hud/index.js"');
        expect(content).toContain('Plugin installed but not built');
        expect(content).toContain('Plugin HUD load failed');
    });
    it('shared HUD wrapper template keeps latest-installed fallback context and marketplace resolution', () => {
        const content = readFileSync(join(root, 'scripts', 'lib', 'hud-wrapper-template.txt'), 'utf-8');
        expect(content).toContain('const latestInstalledVersion = sortedVersions[0];');
        expect(content).toContain('join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js")');
        expect(content).toContain('pathToFileURL(marketplaceHudPath).href');
        expect(content).toContain('"oh-my-copilot/dist/hud/index.js"');
        expect(content).toContain('"oh-my-copilot/dist/hud/index.js"');
        expect(content).toContain('Plugin HUD load failed');
    });
});
//# sourceMappingURL=hud-build-guidance.test.js.map