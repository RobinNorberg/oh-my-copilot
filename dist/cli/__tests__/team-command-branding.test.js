import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
describe('team command branding', () => {
    it('uses omcp team wording in command surfaces', () => {
        const teamCommandSource = readFileSync(join(__dirname, '..', 'commands', 'team.ts'), 'utf-8');
        const cliIndexSource = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');
        expect(teamCommandSource).toContain('omcp team');
        expect(teamCommandSource).not.toContain('omx team');
        expect(cliIndexSource).toContain('omcp team api');
        expect(cliIndexSource).not.toContain('omx team api');
    });
});
//# sourceMappingURL=team-command-branding.test.js.map