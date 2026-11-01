// The default probe spawns `copilot skill list --json`. Tests never reach the
// real CLI: an empty registry falls back to the bare slash, and tests that cover
// the probe install their own fake through setSkillListProbe. Imported in a
// hook, not at the top: a top-level import would load the module graph before
// a test file's vi.mock('fs') and pin the real fs into it.
import { beforeAll } from 'vitest';
beforeAll(async () => {
    const { setSkillListProbe } = await import('../../utils/skill-registry.js');
    setSkillListProbe(() => []);
});
//# sourceMappingURL=stub-skill-list-probe.js.map