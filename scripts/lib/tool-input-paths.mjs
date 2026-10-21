/**
 * File paths named by a file tool's input (fork-owned, oh-my-copilot).
 *
 * Claude Code's Read/Write/Edit/MultiEdit and Copilot CLI's view/create/edit
 * pass an object with `file_path` (Claude) or `path` (Copilot). Copilot's
 * apply_patch, which its PascalCase hooks see as `Edit`, passes the patch text
 * itself: its `*** Add File:`, `*** Update File:`, `*** Delete File:` and
 * `*** Move to:` lines name the files (Copilot CLI 1.0.91, observed by
 * `omg smoke copilot --tier 2 --scenario filetools`).
 */

const PATCH_FILE_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm;

const MAX_PATHS = 20;

/** Distinct paths, in input order, at most MAX_PATHS; [] when the input names none. */
export function toolInputPaths(toolInput) {
  if (typeof toolInput === 'string') {
    return [...new Set([...toolInput.matchAll(PATCH_FILE_LINE)].map((match) => match[1]))].slice(0, MAX_PATHS);
  }
  if (!toolInput || typeof toolInput !== 'object') return [];
  const path = toolInput.file_path || toolInput.path;
  return typeof path === 'string' && path ? [path] : [];
}
