import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error The release helper is intentionally dependency-free ESM without declarations.
import { assertForbiddenArchivePaths } from '../../scripts/release-boundary.mjs';
const REPO_ROOT = resolve(process.cwd());
// tsc (rootDir src, outDir dist) emits these four files for every non-declaration source.
function distOutputs(sourcePath) {
    if (!/\.tsx?$/.test(sourcePath) || sourcePath.endsWith('.d.ts'))
        return [];
    const stem = `dist/${sourcePath.slice('src/'.length).replace(/\.tsx?$/, '')}`;
    return [`${stem}.js`, `${stem}.js.map`, `${stem}.d.ts`, `${stem}.d.ts.map`];
}
// Over-approximates `npm pack`: every tracked file under package.json `files`, plus the dist
// files the tracked sources compile to, so a new source name fails here before a tag does.
function shippedPaths(trackedFiles) {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const included = trackedFiles.filter((path) => packageJson.files.some((entry) => path === entry || path.startsWith(`${entry}/`)));
    const compiled = trackedFiles.filter((path) => path.startsWith('src/')).flatMap(distOutputs);
    return [...new Set([...included, ...compiled])];
}
function asEntries(paths) {
    return paths.map((path) => ({ path: `package/${path}`, type: 'file' }));
}
describe('release archive paths', () => {
    const trackedFiles = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    it('ships no path the release boundary forbids', () => {
        const paths = shippedPaths(trackedFiles);
        expect(paths).toContain('dist/factory/heal/heal-evidence.js');
        expect(() => assertForbiddenArchivePaths(asEntries(paths))).not.toThrow();
    });
    it('rejects a source whose dist output trips the boundary', () => {
        const paths = shippedPaths([...trackedFiles, 'src/factory/heal/evidence.ts']);
        expect(() => assertForbiddenArchivePaths(asEntries(paths))).toThrow('archive contains forbidden operational artifact: package/dist/factory/heal/evidence.js');
    });
});
//# sourceMappingURL=release-archive-paths.test.js.map