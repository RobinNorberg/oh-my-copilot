import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
// Merge stays human (design §8.4): nothing under src/factory may reach
// AzureDevOpsProvider.mergePullRequest, by name or by importing the provider.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FACTORY = join(SRC, 'factory');
function sources(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory())
            return sources(path);
        return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name) ? [path] : [];
    });
}
const PROVIDER_IMPORT = /\b(?:from|import)\s*\(?\s*['"][^'"]*providers\/(?:azure-devops|index)(?:\.js)?['"]/;
describe('src/factory never merges on Azure DevOps', () => {
    const files = sources(FACTORY);
    it('has factory sources to check', () => {
        expect(files.length).toBeGreaterThan(20);
    });
    it('no file under src/factory names mergePullRequest or imports the ADO provider', () => {
        const offenders = files
            .filter((f) => {
            const text = readFileSync(f, 'utf8');
            return /\bmergePullRequest\b/.test(text) || PROVIDER_IMPORT.test(text);
        })
            .map((f) => relative(SRC, f).replace(/\\/g, '/'));
        expect(offenders).toEqual([]);
    });
    it('the pattern catches the provider import forms', () => {
        for (const form of ["import { AzureDevOpsProvider } from '../../providers/azure-devops.js';", "const p = await import('../providers/index.js');"]) {
            expect(PROVIDER_IMPORT.test(form), form).toBe(true);
        }
    });
});
//# sourceMappingURL=merge-static.test.js.map