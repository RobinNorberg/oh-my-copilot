import { registerStandaloneShutdownHandlers } from '../mcp/standalone-shutdown.js';
/**
 * Run the HUD in watch mode until an explicit shutdown signal or parent-exit
 * condition is observed.
 */
export async function runHudWatchLoop(options) {
    const registerShutdownHandlers = options.registerShutdownHandlers ?? registerStandaloneShutdownHandlers;
    let skipInit = false;
    let shouldStop = false;
    let wakeSleep = null;
    registerShutdownHandlers({
        onShutdown: async () => {
            shouldStop = true;
            wakeSleep?.();
        },
    });
    while (!shouldStop) {
        await options.hudMain(true, skipInit);
        skipInit = true;
        if (shouldStop) {
            break;
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                wakeSleep = null;
                resolve();
            }, options.intervalMs);
            wakeSleep = () => {
                clearTimeout(timer);
                wakeSleep = null;
                resolve();
            };
            timer.unref?.();
        });
    }
}
//# sourceMappingURL=hud-watch.js.map