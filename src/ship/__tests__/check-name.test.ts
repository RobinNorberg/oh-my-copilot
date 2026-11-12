import { describe, expect, it } from 'vitest';
import { checkName, checkText } from '../check-name.js';

describe('checkText / checkName', () => {
  it('review-528 L1: the cap never splits a surrogate pair', () => {
    const emoji = '\u{1F680}';
    expect(checkText(`a${emoji}b`, 2)).toBe(`a${emoji}`);
    expect(checkText(emoji.repeat(100), 80)).toBe(emoji.repeat(80));
    // No lone surrogate survives the cap.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(checkText(`${'x'.repeat(79)}${emoji}`, 80))).toBe(false);
    expect(checkName(`${'x'.repeat(79)}${emoji}tail`)).toBe(`\`${'x'.repeat(79)}${emoji}\``);
  });

  it('flattens newlines, mentions, backticks, table pipes and ANSI escapes', () => {
    expect(checkName('Build`\n@team | \u001b[31mred\u001b[0m')).toBe("`Build' ＠team ¦ [31mred [0m`");
    expect(checkText('', 10)).toBe('(unnamed)');
  });
});
