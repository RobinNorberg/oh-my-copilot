import { describe, expect, it } from 'vitest';
import * as engine from '../engine.js';
import * as rules from '../plan-rules.js';

describe('plan rules are shared, not copied', () => {
  it('engine.ts re-exports the plan-rules functions themselves', () => {
    expect(engine.findPlanLink).toBe(rules.findPlanLink);
    expect(engine.issueAuthorTrusted).toBe(rules.issueAuthorTrusted);
    expect(engine.hasAcceptanceCriteria).toBe(rules.hasAcceptanceCriteria);
    expect(engine.TRUSTED_PLAN_AUTHORS).toBe(rules.TRUSTED_PLAN_AUTHORS);
  });

  it('PLAN_LINK and ACCEPTANCE keep their shapes', () => {
    expect(rules.PLAN_LINK.exec('intro\n  omg-plan: docs/plan.md  \nmore')?.[1]).toBe('docs/plan.md');
    expect(rules.ACCEPTANCE.test('### Acceptance Criteria')).toBe(true);
    expect(rules.ACCEPTANCE.test('Acceptance criteria')).toBe(false);
  });
});
