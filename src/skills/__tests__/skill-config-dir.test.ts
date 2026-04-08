/**
 * Regression test: skill markdown files must use COPILOT_CONFIG_DIR
 *
 * Ensures that bash code blocks in skill files never hardcode $HOME/.copilot
 * without a ${COPILOT_CONFIG_DIR:-...} fallback. This prevents skills from
 * ignoring the user's custom config directory.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Extract content from fenced bash code blocks in a markdown file.
 * Returns an array of { startLine, content } for each ```bash ... ``` block.
 */
function extractBashBlocks(filePath: string): { startLine: number; content: string }[] {
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const blocks: { startLine: number; content: string }[] = [];

  let inBlock = false;
  let blockStart = 0;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^```bash\b/.test(line.trim())) {
      inBlock = true;
      blockStart = i + 2; // 1-indexed, next line
      blockLines = [];
    } else if (inBlock && line.trim() === '```') {
      inBlock = false;
      blocks.push({ startLine: blockStart, content: blockLines.join('\n') });
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  return blocks;
}

/**
 * Find lines in bash blocks that use $HOME/.copilot without the
 * ${COPILOT_CONFIG_DIR:-$HOME/.copilot} pattern.
 */
function findHardcodedHomeCopilot(filePath: string): { line: number; text: string }[] {
  const blocks = extractBashBlocks(filePath);
  const violations: { line: number; text: string }[] = [];

  for (const block of blocks) {
    const lines = block.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match $HOME/.copilot that is NOT inside ${COPILOT_CONFIG_DIR:-$HOME/.copilot}
      if (/\$HOME\/\.copilot/.test(line) && !/\$\{COPILOT_CONFIG_DIR:-\$HOME\/\.copilot\}/.test(line)) {
        violations.push({
          line: block.startLine + i,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

const SKILLS_ROOT = join(__dirname, '..', '..', '..', 'skills');

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const ALL_FILES = findMarkdownFiles(SKILLS_ROOT);

describe('skill markdown bash blocks must respect COPILOT_CONFIG_DIR', () => {
  it.each(ALL_FILES.map((f) => [f.replace(/.*skills\//, 'skills/'), f]))(
    '%s has no hardcoded $HOME/.copilot in bash blocks',
    (_label, filePath) => {
      const violations = findHardcodedHomeCopilot(filePath);
      if (violations.length > 0) {
        const details = violations
          .map((v) => `  line ${v.line}: ${v.text}`)
          .join('\n');
        expect.fail(
          `Found $HOME/.copilot without COPILOT_CONFIG_DIR fallback:\n${details}\n` +
          `Replace with: \${COPILOT_CONFIG_DIR:-$HOME/.copilot}`
        );
      }
    },
  );
});
