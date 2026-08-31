---
name: omc-new-agent-skill-checklist
description: Complete checklist for adding a new agent or skill to OMC — all files and test assertions that must be updated
triggers:
  - "add new agent"
  - "add new skill"
  - "agent count"
  - "skill count"
  - "test count mismatch"
  - "expected 18 but got 19"
  - "expected 51 but got 52"
---

# OMC New Agent/Skill Addition Checklist

## The Insight
Adding an agent or skill to OMC isn't just creating the file — there's a multi-file contract enforced by tests. CI will fail if any piece is missed. The test suite has hardcoded counts and export checks that must be updated atomically with the new files.

## Why This Matters
In this session, adding a `devils-advocate` agent and `critique` skill caused 4 distinct CI failures:
1. Skill count assertion (51→52) in `skills.test.ts` at 3 locations
2. Agent count assertion (18→19) in `agent-registry.test.ts` at 2 locations and `cleanup-validation.test.ts` at 1 location
3. Missing re-export from `src/agents/index.ts` — test imports from index and checks all registry agents are exported
4. Agent prompt containing the literal word "FIXME" — test flags any prompt with TODO/FIXME markers

## Recognition Pattern
- You're adding a new `.agent.md` file or a new `skills/*/SKILL.md` directory
- CI fails with "expected N to be M" where M = N+1
- CI fails with "Missing export for agent: name"

## The Approach

### Adding a New Agent (8 touchpoints)
1. `agents/<name>.agent.md` — Create the agent prompt (avoid literal FIXME/TODO in text)
2. `src/agents/definitions.ts` — Add `export const` agent definition with `loadAgentPrompt()`
3. `src/agents/definitions.ts` — Add to `AGENT_CONFIG_KEY_MAP`
4. `src/agents/definitions.ts` — Add to `agents` record in `getAgentDefinitions()`
5. `src/agents/definitions.ts` — Update agent count in `omcSystemPrompt` and add to agent listing
6. `src/agents/index.ts` — Add re-export (e.g., `export { devilsAdvocateAgent } from './definitions.js'`)
7. `src/shared/types.ts` — Add to `PluginConfig.agents` interface
8. **Tests**: Update counts in `agent-registry.test.ts` (×2) and `cleanup-validation.test.ts` (×1)

### Adding a New Skill (4 touchpoints)
1. `skills/<name>/SKILL.md` — Create the skill definition with frontmatter
2. `src/__tests__/skills.test.ts` — Add to `expectedSkills` array
3. `src/__tests__/skills.test.ts` — Bump `createBuiltinSkills()` count
4. `src/__tests__/skills.test.ts` — Bump `listBuiltinSkillNames()` counts (canonical + with-aliases)

### Don't Forget
- `npm run build` to regenerate `dist/` and `bridge/` (git-distributed plugin)
- Agent prompts must not contain literal "FIXME" — the test `agent-registry.test.ts` checks for this
- The agent naming convention: camelCase export (`devilsAdvocateAgent`), kebab-case registry key (`devils-advocate`)
