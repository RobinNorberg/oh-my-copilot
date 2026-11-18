import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOGUE_FAILURE_TTL_MS, CATALOGUE_TTL_MS, catalogueFromListModels, loadCopilotCatalogue, loadCopilotCatalogueWith, readCatalogueCache, readCopilotCatalogueCacheOnly, setCopilotCatalogueSource, teamCopilotCatalogue, } from '../model-catalogue.js';
const T0 = Date.parse('2026-11-18T12:00:00Z');
const dirs = [];
const cacheFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-catalogue-'));
    dirs.push(dir);
    return join(dir, 'state', 'copilot-models-cache.json');
};
afterEach(() => {
    for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});
describe('catalogueFromListModels', () => {
    it('keeps string ids and drops policy-disabled models', () => {
        expect(catalogueFromListModels([
            { id: 'mai-code-2', policy: { state: 'enabled' } },
            { id: 'claude-opus-5.5', policy: { state: 'disabled' } },
            { id: 'gpt-6-luna' },
            { id: 7 },
            null,
        ])).toEqual(['mai-code-2', 'gpt-6-luna']);
        expect(catalogueFromListModels('nope')).toEqual([]);
    });
});
describe('the catalogue cache', () => {
    it('reads fresh within the TTL, stale after, and nothing from a corrupt file', async () => {
        const file = cacheFile();
        expect(readCatalogueCache(file, T0)).toEqual({ fresh: null, stale: null });
        await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['mai-code-2'] }) });
        expect(readCatalogueCache(file, T0 + 1000).fresh).toEqual(['mai-code-2']);
        expect(readCatalogueCache(file, T0 + CATALOGUE_TTL_MS + 1)).toMatchObject({ fresh: null, stale: ['mai-code-2'] });
        writeFileSync(file, '{ not json');
        expect(readCatalogueCache(file, T0)).toEqual({ fresh: null, stale: null });
    });
    it('a fresh cache answers without a live read', async () => {
        const file = cacheFile();
        await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['a', 'b'] }) });
        const fetch = vi.fn(async () => ({ models: ['c'] }));
        const result = await loadCopilotCatalogueWith({ file, now: () => T0 + 60_000, fetch });
        expect(fetch).not.toHaveBeenCalled();
        expect(result.source).toBe('cache');
        expect([...result.catalogue]).toEqual(['a', 'b']);
    });
    it('a live read is cached with its time', async () => {
        const file = cacheFile();
        const result = await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['mai-code-2'] }) });
        expect(result).toMatchObject({ source: 'live' });
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fetchedAt: new Date(T0).toISOString(), models: ['mai-code-2'] });
    });
    it('an expired cache is refreshed', async () => {
        const file = cacheFile();
        await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['old'] }) });
        const result = await loadCopilotCatalogueWith({ file, now: () => T0 + CATALOGUE_TTL_MS + 1, fetch: async () => ({ models: ['new'] }) });
        expect(result.source).toBe('live');
        expect([...result.catalogue]).toEqual(['new']);
    });
    it('a failed read with no cache is unknown, is remembered, and is retried after the failure TTL', async () => {
        const file = cacheFile();
        const failing = vi.fn(async () => ({ error: 'offline' }));
        const first = await loadCopilotCatalogueWith({ file, now: () => T0, fetch: failing });
        expect(first).toEqual({ catalogue: null, source: 'none', detail: 'the Copilot model catalogue could not be read (offline)' });
        const second = await loadCopilotCatalogueWith({ file, now: () => T0 + 1000, fetch: failing });
        expect(failing).toHaveBeenCalledTimes(1);
        expect(second.catalogue).toBeNull();
        expect(second.detail).toMatch(/recently \(offline\)/);
        const third = await loadCopilotCatalogueWith({ file, now: () => T0 + CATALOGUE_FAILURE_TTL_MS + 1, fetch: async () => ({ models: ['x'] }) });
        expect(third.source).toBe('live');
    });
    it('a failed refresh falls back to the stale cache and keeps it on disk', async () => {
        const file = cacheFile();
        await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['mai-code-2'] }) });
        const later = T0 + CATALOGUE_TTL_MS + 1;
        const result = await loadCopilotCatalogueWith({ file, now: () => later, fetch: async () => { throw new Error('timed out'); } });
        expect(result.source).toBe('stale-cache');
        expect([...result.catalogue]).toEqual(['mai-code-2']);
        expect(readCatalogueCache(file, later)).toMatchObject({ stale: ['mai-code-2'], recentFailure: 'timed out' });
    });
    it('an empty listModels answer counts as a failure', async () => {
        const result = await loadCopilotCatalogueWith({ file: cacheFile(), now: () => T0, fetch: async () => ({ models: [] }) });
        expect(result.catalogue).toBeNull();
    });
    it('the cache-only read never fetches', async () => {
        const file = cacheFile();
        expect(readCopilotCatalogueCacheOnly(file, T0).catalogue).toBeNull();
        await loadCopilotCatalogueWith({ file, now: () => T0, fetch: async () => ({ models: ['m'] }) });
        expect(readCopilotCatalogueCacheOnly(file, T0).source).toBe('cache');
        expect(readCopilotCatalogueCacheOnly(file, T0 + CATALOGUE_TTL_MS + 1).source).toBe('stale-cache');
    });
});
describe('the process-wide catalogue', () => {
    const unknown = { catalogue: null, source: 'none', detail: 'no Copilot model catalogue in tests' };
    afterEach(() => {
        setCopilotCatalogueSource({ load: async () => unknown, readCached: () => unknown });
    });
    it('is read once per process', async () => {
        const load = vi.fn(async () => ({ catalogue: new Set(['m']), source: 'live', detail: '' }));
        setCopilotCatalogueSource({ load, readCached: () => unknown });
        await loadCopilotCatalogue();
        await loadCopilotCatalogue();
        expect(load).toHaveBeenCalledTimes(1);
    });
    it('team startup says once that an unreadable catalogue keeps first ids', async () => {
        setCopilotCatalogueSource({ load: async () => ({ ...unknown, detail: 'SDK missing' }), readCached: () => unknown });
        const lines = [];
        expect(await teamCopilotCatalogue((l) => lines.push(l))).toBeNull();
        expect(await teamCopilotCatalogue((l) => lines.push(l))).toBeNull();
        expect(lines).toEqual(["[omg] SDK missing; Copilot tier aliases use each tier's first model"]);
    });
});
//# sourceMappingURL=model-catalogue.test.js.map