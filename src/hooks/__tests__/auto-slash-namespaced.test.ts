import { describe, expect, it } from 'vitest';

import {
  detectSlashCommand,
  parseSlashCommand,
} from '../auto-slash-command/detector.js';

describe('auto-slash-command namespaced commands', () => {
  it('keeps the plugin namespace in the parsed command name', () => {
    expect(parseSlashCommand('/oh-my-copilot:verify check it')).toMatchObject({
      command: 'oh-my-copilot:verify',
      args: 'check it',
    });
  });

  it('honors the namespaced entries in the exclusion list', () => {
    expect(detectSlashCommand('/oh-my-copilot:execute build it')).toBeNull();
    expect(detectSlashCommand('/oh-my-copilot:plan')).toBeNull();
  });

  it('still parses plain commands and their arguments', () => {
    expect(detectSlashCommand('/review-pr 12')).toMatchObject({
      command: 'review-pr',
      args: '12',
    });
  });
});
