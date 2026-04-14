import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('omc-doctor skill (issue #2254)', () => {
  it('documents copilot-instructions.md OMC version drift check against cached plugin version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('copilot-instructions.md OMC version:');
    expect(content).toContain('OMC version source:');
    expect(content).toContain('Latest cached plugin version:');
    expect(content).toContain('VERSION DRIFT: copilot-instructions.md and plugin versions differ');
    expect(content).toContain('VERSION CHECK SKIPPED: missing OMC marker or plugin cache');
    expect(content).toContain('VERSION MATCH: copilot-instructions.md and plugin cache are aligned');
    expect(content).toContain('copilot-*.md');
    expect(content).toContain('deterministic companion');
    expect(content).toContain('scanned deterministic copilot-instructions sources');
    expect(content).not.toContain('!==');
    expect(content).toContain('If `copilot-instructions.md OMC version` != `Latest cached plugin version`: WARN - version drift detected');
  });
});
