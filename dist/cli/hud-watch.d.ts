import { registerStandaloneShutdownHandlers } from '../mcp/standalone-shutdown.js';
export interface HudMainLike {
    (watchMode: boolean, skipInit?: boolean): Promise<void>;
}
export interface HudWatchLoopOptions {
    intervalMs: number;
    hudMain: HudMainLike;
    registerShutdownHandlers?: typeof registerStandaloneShutdownHandlers;
}
/**
 * Run the HUD in watch mode until an explicit shutdown signal or parent-exit
 * condition is observed.
 */
export declare function runHudWatchLoop(options: HudWatchLoopOptions): Promise<void>;
//# sourceMappingURL=hud-watch.d.ts.map