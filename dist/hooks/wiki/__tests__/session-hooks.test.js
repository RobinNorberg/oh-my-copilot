/**
 * Tests for Wiki Session Hooks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureWikiDir } from '../storage.js';
import { onSessionEnd } from '../session-hooks.js';
describe('Wiki Session Hooks', () => {
    let tempDir;
    let configDir;
    let originalClaudeConfigDir;
    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-session-hooks-'));
        configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-session-config-'));
        originalClaudeConfigDir = process.env.COPILOT_CONFIG_DIR;
        process.env.COPILOT_CONFIG_DIR = configDir;
    });
    afterEach(async () => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.COPILOT_CONFIG_DIR;
        }
        else {
            process.env.COPILOT_CONFIG_DIR = originalClaudeConfigDir;
        }
        await fsp.rm(tempDir, { recursive: true, force: true });
        await fsp.rm(configDir, { recursive: true, force: true });
    });
    it('respects autoCapture=false from the active COPILOT_CONFIG_DIR', () => {
        fs.writeFileSync(path.join(configDir, '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: false } }));
        const wikiDir = ensureWikiDir(tempDir);
        expect(onSessionEnd({ cwd: tempDir, session_id: 'session-12345678' })).toEqual({ continue: true });
        const wikiEntries = fs.readdirSync(wikiDir);
        expect(wikiEntries.filter(entry => entry.startsWith('session-log-'))).toHaveLength(0);
        expect(fs.existsSync(path.join(wikiDir, 'log.md'))).toBe(false);
    });
});
//# sourceMappingURL=session-hooks.test.js.map