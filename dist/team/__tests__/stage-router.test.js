import { describe, it, expect } from 'vitest';
import { resolveRoleAssignment, buildResolvedRoutingSnapshot } from '../stage-router.js';
import { CANONICAL_TEAM_ROLES } from '../../shared/types.js';
import { COPILOT_FAMILY_DEFAULTS, BUILTIN_EXTERNAL_MODEL_DEFAULTS } from '../../config/models.js';
const EMPTY = {};
const EXPECTED_DEFAULTS = {
    orchestrator: { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'omcp' },
    planner: { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'planner' },
    analyst: { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'analyst' },
    architect: { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'architect' },
    executor: { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'executor' },
    debugger: { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'debugger' },
    critic: { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'critic' },
    'code-reviewer': { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'codeReviewer' },
    'security-reviewer': { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'securityReviewer' },
    'test-engineer': { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'testEngineer' },
    designer: { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'designer' },
    writer: { model: COPILOT_FAMILY_DEFAULTS.HAIKU, agent: 'writer' },
    'code-simplifier': { model: COPILOT_FAMILY_DEFAULTS.OPUS, agent: 'codeSimplifier' },
    explore: { model: COPILOT_FAMILY_DEFAULTS.HAIKU, agent: 'explore' },
    'document-specialist': { model: COPILOT_FAMILY_DEFAULTS.SONNET, agent: 'documentSpecialist' },
};
describe('stage-router resolveRoleAssignment', () => {
    describe('defaults (no team.roleRouting)', () => {
        for (const role of CANONICAL_TEAM_ROLES) {
            it(`resolves ${role} → claude + tier-default model + canonical agent`, () => {
                const out = resolveRoleAssignment(role, EMPTY);
                expect(out.provider).toBe('claude');
                expect(out.agent).toBe(EXPECTED_DEFAULTS[role].agent);
                expect(out.model).toBe(EXPECTED_DEFAULTS[role].model);
            });
        }
    });
    describe('explicit overrides', () => {
        it('respects provider=codex with explicit model passthrough', () => {
            const cfg = {
                team: { roleRouting: { critic: { provider: 'codex', model: 'gpt-5.3-codex' } } },
            };
            const out = resolveRoleAssignment('critic', cfg);
            expect(out.provider).toBe('codex');
            expect(out.model).toBe('gpt-5.3-codex');
            expect(out.agent).toBe('critic');
        });
        it('respects provider=gemini and resolves model from builtin defaults when omitted', () => {
            const cfg = {
                team: { roleRouting: { 'code-reviewer': { provider: 'gemini' } } },
            };
            const out = resolveRoleAssignment('code-reviewer', cfg);
            expect(out.provider).toBe('gemini');
            expect(out.model).toBe(BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel);
            expect(out.agent).toBe('codeReviewer');
        });
        it('resolves tier name (HIGH) into Claude opus model for claude provider', () => {
            const cfg = {
                team: { roleRouting: { executor: { provider: 'claude', model: 'HIGH' } } },
            };
            const out = resolveRoleAssignment('executor', cfg);
            expect(out.provider).toBe('claude');
            expect(out.model).toBe(COPILOT_FAMILY_DEFAULTS.OPUS);
        });
        it('tier name on external provider falls back to provider builtin (tiers are claude-centric)', () => {
            const cfg = {
                team: { roleRouting: { executor: { provider: 'codex', model: 'HIGH' } } },
            };
            const out = resolveRoleAssignment('executor', cfg);
            expect(out.provider).toBe('codex');
            expect(out.model).toBe(BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel);
        });
        it('respects explicit agent override', () => {
            const cfg = {
                team: { roleRouting: { executor: { agent: 'debugger' } } },
            };
            const out = resolveRoleAssignment('executor', cfg);
            expect(out.agent).toBe('debugger');
        });
        it('respects routing.tierModels overrides for claude tier resolution', () => {
            const cfg = {
                routing: { tierModels: { HIGH: 'claude-opus-custom-id' } },
                team: { roleRouting: { critic: { provider: 'claude', model: 'HIGH' } } },
            };
            const out = resolveRoleAssignment('critic', cfg);
            expect(out.model).toBe('claude-opus-custom-id');
        });
    });
    describe('orchestrator pinning', () => {
        it('orchestrator provider always pinned to claude even when user specifies codex', () => {
            const cfg = {
                team: { roleRouting: { orchestrator: { model: 'HIGH' } } },
            };
            const out = resolveRoleAssignment('orchestrator', cfg);
            expect(out.provider).toBe('claude');
            expect(out.agent).toBe('omcp');
        });
    });
    describe('alias normalization', () => {
        it('"reviewer" alias normalizes to code-reviewer (resolved as code-reviewer)', () => {
            const cfg = {
                team: { roleRouting: { reviewer: { provider: 'codex' } } },
            };
            const out = resolveRoleAssignment('reviewer', cfg);
            expect(out.provider).toBe('codex');
            expect(out.agent).toBe('codeReviewer');
        });
        it('canonical role lookup honors alias-keyed roleRouting entries', () => {
            const cfg = {
                team: { roleRouting: { reviewer: { provider: 'gemini' } } },
            };
            const out = resolveRoleAssignment('code-reviewer', cfg);
            expect(out.provider).toBe('gemini');
            expect(out.agent).toBe('codeReviewer');
        });
        it('resolved snapshot uses alias-keyed routing entries for canonical stage roles', () => {
            const cfg = {
                team: { roleRouting: { reviewer: { provider: 'codex' } } },
            };
            const snap = buildResolvedRoutingSnapshot(cfg);
            expect(snap['code-reviewer'].primary.provider).toBe('codex');
        });
    });
});
//# sourceMappingURL=stage-router.test.js.map