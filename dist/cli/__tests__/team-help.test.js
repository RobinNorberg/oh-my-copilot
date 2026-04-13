import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
describe('team cli help text surfaces', () => {
    it('team.ts usage includes legacy and api surfaces', () => {
        const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
        expect(source).toContain('omcp team resume <team_name>');
        expect(source).toContain('omcp team shutdown <team_name>');
        expect(source).toContain('omcp team api <operation>');
        expect(source).toContain('omcp team [ralph] <N:agent-type[:role]>');
    });
    it('team.ts help text includes team api/resume/shutdown', () => {
        const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
        expect(source).toContain('omcp team resume <team_name>');
        expect(source).toContain('omcp team shutdown <team_name>');
        expect(source).toContain('omcp team api <operation>');
    });
});
//# sourceMappingURL=team-help.test.js.map