import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/loader.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadJsoncFile: () => ({ agents: { executor: { model: 'opus' } } }),
}));
const { loadSetupCopilotCatalogue } = await import('../index.js');
const { setCopilotCatalogueSource } = await import('../../copilot-run/model-catalogue.js');
describe('loadSetupCopilotCatalogue', () => {
    const live = { catalogue: new Set(['mai-code-2']), source: 'live', detail: '' };
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    afterEach(() => {
        if (pluginRoot === undefined)
            delete process.env.CLAUDE_PLUGIN_ROOT;
        else
            process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
        setCopilotCatalogueSource(undefined);
    });
    it('reads the catalogue when the user config names a tier alias', async () => {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        const load = vi.fn(async () => live);
        setCopilotCatalogueSource({ load, readCached: () => live });
        expect(await loadSetupCopilotCatalogue()).toBe(live);
        expect(load).toHaveBeenCalledTimes(1);
    });
    it('reads nothing for a project-scoped plugin (install() syncs no overrides there)', async () => {
        process.env.CLAUDE_PLUGIN_ROOT = '/some/project/.claude/plugins/oh-my-copilot';
        const load = vi.fn(async () => live);
        setCopilotCatalogueSource({ load, readCached: () => live });
        expect(await loadSetupCopilotCatalogue()).toBeUndefined();
        expect(load).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=setup-copilot-catalogue.test.js.map