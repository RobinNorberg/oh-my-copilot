/**
 * omcp ralphthon CLI subcommand
 *
 * Autonomous hackathon lifecycle:
 *   omcp ralphthon "task"                  Start new ralphthon session
 *   omcp ralphthon --resume                Resume existing session
 *   omcp ralphthon --skip-interview "task" Skip deep-interview, use task directly
 *   omcp ralphthon --max-waves 5           Set max hardening waves
 *   omcp ralphthon --poll-interval 60      Set poll interval in seconds
 */
import type { RalphthonCliOptions, RalphthonPlanningContext, RalphthonStory } from '../../ralphthon/types.js';
/**
 * Parse ralphthon CLI arguments
 */
export declare function parseRalphthonArgs(args: string[]): RalphthonCliOptions;
export declare function buildRalphthonPlanningContext(task: string): RalphthonPlanningContext;
export declare function buildRalphthonInterviewPrompt(task: string, options: RalphthonCliOptions): string;
export declare function buildDefaultSkipInterviewStories(task: string): RalphthonStory[];
export declare function buildDefaultSkipInterviewPrdParams(task: string): {
    project: string;
    branchName: string;
    description: string;
    stories: RalphthonStory[];
    planningContext: RalphthonPlanningContext;
};
/**
 * Execute the ralphthon CLI command
 */
export declare function ralphthonCommand(args: string[]): Promise<void>;
//# sourceMappingURL=ralphthon.d.ts.map