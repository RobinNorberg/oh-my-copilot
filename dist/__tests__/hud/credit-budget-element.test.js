import { describe, expect, it, vi } from 'vitest';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';
vi.mock('../../hud/elements/premium-budget.js', () => ({
    renderPremiumBudget: vi.fn(() => 'cr:1.5/5'),
}));
vi.mock('../../hud/elements/git.js', () => ({
    renderGitRepo: vi.fn(() => null),
    renderGitBranch: vi.fn(() => null),
}));
const context = {
    contextPercent: 50,
    modelName: 'claude-sonnet-4-5',
    ralph: null,
    ultrawork: null,
    prd: null,
    autopilot: null,
    activeAgents: [],
    todos: [],
    backgroundTasks: [],
    cwd: '/home/user/project',
    lastSkill: null,
    rateLimitsResult: null,
    customBuckets: null,
    pendingPermission: null,
    thinkingState: null,
    sessionHealth: null,
    omcVersion: '4.5.4',
    updateAvailable: null,
    toolCallCount: 0,
    agentCallCount: 0,
    skillCallCount: 0,
    promptTime: null,
    apiKeySource: null,
    profileName: null,
    sessionSummary: null,
};
const config = (elements, extra = {}) => ({
    ...DEFAULT_HUD_CONFIG,
    elements: { ...DEFAULT_HUD_CONFIG.elements, omcLabel: true, contextBar: true, ...elements },
    ...extra,
});
describe('HUD AI Credits budget element', () => {
    it('renders by default under the creditBudget name', async () => {
        expect(await render(context, config({}))).toContain('cr:1.5/5');
        expect(await render(context, config({}, { layout: { main: ['creditBudget'] } }))).toContain('cr:1.5/5');
    });
    it('honours creditBudget: false, and the deprecated premiumBudget toggle when creditBudget is unset', async () => {
        expect(await render(context, config({ creditBudget: false }))).not.toContain('cr:');
        expect(await render(context, config({ premiumBudget: false }))).not.toContain('cr:');
        expect(await render(context, config({ creditBudget: true, premiumBudget: false }))).toContain('cr:1.5/5');
    });
    it('accepts the deprecated premiumBudget name in layout.main and elementOrder', async () => {
        expect(await render(context, config({}, { layout: { main: ['premiumBudget'] } }))).toContain('cr:1.5/5');
        const ordered = await render(context, config({}, { elementOrder: ['premiumBudget', 'omcLabel'] }));
        const main = ordered.split('\n').find((l) => l.includes('[oh-my-copilot'));
        expect(main.indexOf('cr:')).toBeGreaterThanOrEqual(0);
        expect(main.indexOf('cr:')).toBeLessThan(main.indexOf('[oh-my-copilot'));
    });
});
//# sourceMappingURL=credit-budget-element.test.js.map