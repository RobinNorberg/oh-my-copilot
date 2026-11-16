import { describe, it, expect } from 'vitest';
import { createExaServer, createPlaywrightServer } from '../servers.js';
// Socket.dev finding: npx launched exa-mcp-server unpinned and
// @playwright/mcp@latest, so every launch could pull a new, unreviewed release.
describe('default MCP server package pinning', () => {
    it('launches exa and playwright at exact versions, never @latest', () => {
        for (const server of [createExaServer(), createPlaywrightServer()]) {
            const spec = server.args.find((arg) => !arg.startsWith('-'));
            expect(spec).toMatch(/^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/);
            expect(server.args.join(' ')).not.toContain('@latest');
        }
    });
});
//# sourceMappingURL=servers-pinning.test.js.map