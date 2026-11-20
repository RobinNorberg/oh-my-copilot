#!/usr/bin/env node
// Prints the state root a hook would resolve for argv[2] ({"root": "..."}), with
// the same resolver pre-tool-enforcer.mjs uses. The factory engine runs it once
// per lane in the lane's own env (src/copilot-run/job.ts laneStateRootEnv), so
// the lane hooks can skip the lookup (docs/HOOKS.md "Lane PreToolUse fast path").
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const directory = process.argv[2];
if (!directory) process.exit(2);
process.stdout.write(`${JSON.stringify({ root: await resolveOmcStateRoot(directory) })}\n`);
