/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */

import { RESET } from '../colors.js';

const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';

/** Copilot CLI's in-session plugin update; the shell form is `copilot plugin update ...`. */
const COPILOT_PLUGIN_UPDATE = '/plugin update oh-my-copilot@omc';
const NPM_UPDATE = '! npm i -g oh-my-copilot@latest';

export interface UpdateHintInput {
  /** Latest OMC version when an update is available, else null */
  omcUpdateAvailable: string | null;
  /**
   * Update channel the OMC update belongs to: 'marketplace' is a Claude Code
   * plugin install, 'copilot-plugin' a Copilot CLI plugin install.
   */
  omcUpdateSource: 'npm' | 'marketplace' | 'copilot-plugin' | null;
  /** Latest Claude Code version when an update is available, else null */
  claudeCodeUpdateAvailable: string | null;
  /** Host CLI; under Copilot no Claude Code line is ever rendered */
  host?: 'claude' | 'copilot';
}

/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: plugin installs cannot be updated through npm.
 */
export function renderUpdateHints(input: UpdateHintInput): string[] {
  const lines: string[] = [];
  const copilot = input.host === 'copilot';

  if (input.omcUpdateAvailable) {
    let command = NPM_UPDATE;
    if (input.omcUpdateSource === 'copilot-plugin' || (copilot && input.omcUpdateSource === 'marketplace')) {
      command = COPILOT_PLUGIN_UPDATE;
    } else if (input.omcUpdateSource === 'marketplace') {
      command = '! claude plugin marketplace update omc && claude plugin update oh-my-copilot@omc';
    }
    lines.push(`${YELLOW}${BOLD}[!] omg ${input.omcUpdateAvailable} - paste: ${command}${RESET}`);
  }

  if (!copilot && input.claudeCodeUpdateAvailable) {
    lines.push(
      `${YELLOW}${BOLD}[!] claude ${input.claudeCodeUpdateAvailable} - paste: ! claude update${RESET}`,
    );
  }

  return lines;
}
