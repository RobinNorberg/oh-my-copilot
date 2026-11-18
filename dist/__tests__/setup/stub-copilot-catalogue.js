// The default catalogue source reads ~/.omg/state/copilot-models-cache.json and
// may start the Copilot runtime for listModels(). Tests never reach either: an
// unknown catalogue keeps the first confirmed model of each tier (none for fable).
// Tests that cover the catalogue install their own source through
// setCopilotCatalogueSource.
import { beforeAll } from 'vitest';
beforeAll(async () => {
    const { setCopilotCatalogueSource } = await import('../../copilot-run/model-catalogue.js');
    const unknown = { catalogue: null, source: 'none', detail: 'no Copilot model catalogue in tests' };
    setCopilotCatalogueSource({ load: async () => unknown, readCached: () => unknown });
});
//# sourceMappingURL=stub-copilot-catalogue.js.map