import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const waitMocks = vi.hoisted(() => ({
    waitCommand: vi.fn(),
    waitStatusCommand: vi.fn(),
    waitDaemonCommand: vi.fn(),
    waitDetectCommand: vi.fn(),
}));
const teleportMocks = vi.hoisted(() => ({
    teleportCommand: vi.fn(),
    teleportListCommand: vi.fn(),
    teleportRemoveCommand: vi.fn(),
}));
vi.mock('../commands/wait.js', () => waitMocks);
vi.mock('../commands/teleport.js', () => teleportMocks);
const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';
async function parse(args) {
    vi.resetModules();
    const { buildProgram } = await import('../index.js');
    await buildProgram().parseAsync(['node', 'omc', ...args]);
}
describe('wait/teleport subcommand --json Commander integration (regression: parent-level --json shadowed the subcommand\'s own flag)', () => {
    let exitSpy;
    beforeEach(() => {
        Object.values(waitMocks).forEach((mockFn) => mockFn.mockReset());
        Object.values(teleportMocks).forEach((mockFn) => mockFn.mockReset());
        teleportMocks.teleportRemoveCommand.mockResolvedValue(0);
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { }));
    });
    afterEach(() => {
        exitSpy.mockRestore();
    });
    afterAll(() => {
        if (originalSkipParse === undefined)
            delete process.env.OMC_CLI_SKIP_PARSE;
        else
            process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
    });
    it('dispatches wait status --json with json:true', async () => {
        await parse(['wait', 'status', '--json']);
        expect(waitMocks.waitStatusCommand).toHaveBeenCalledWith({ json: true });
    });
    it('dispatches wait status without --json as json:false', async () => {
        await parse(['wait', 'status']);
        expect(waitMocks.waitStatusCommand).toHaveBeenCalledWith({ json: false });
    });
    it('dispatches wait detect --json with json:true', async () => {
        await parse(['wait', 'detect', '--json']);
        expect(waitMocks.waitDetectCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
    });
    it('dispatches teleport list --json with json:true', async () => {
        await parse(['teleport', 'list', '--json']);
        expect(teleportMocks.teleportListCommand).toHaveBeenCalledWith({ json: true });
    });
    it('dispatches teleport list without --json as json:false', async () => {
        await parse(['teleport', 'list']);
        expect(teleportMocks.teleportListCommand).toHaveBeenCalledWith({ json: false });
    });
    it('dispatches teleport remove <path> --json with json:true', async () => {
        await parse(['teleport', 'remove', './some-worktree', '--json']);
        expect(teleportMocks.teleportRemoveCommand).toHaveBeenCalledWith('./some-worktree', expect.objectContaining({ json: true }));
    });
});
//# sourceMappingURL=wait-teleport-json.test.js.map