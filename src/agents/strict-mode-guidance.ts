import { isStrictMode } from '../utils/strict-mode.js';

type GuidanceSurface = 'system' | 'agent';

const STRICT_MODE_GUIDANCE_HEADER: Record<GuidanceSurface, string> = {
  system: '## Strict Mode Execution Guidance',
  agent: '## Strict Mode Guidance',
};

const STRICT_MODE_GUIDANCE_LINES = [
  '- Default to writing no comments unless the why is genuinely non-obvious.',
  '- Before reporting completion, verify the result with tests, commands, or observable output whenever possible.',
  '- If the user is operating on a misconception, or you notice an adjacent bug worth flagging, say so directly.',
  '- Report outcomes faithfully: do not imply checks passed if you did not run them, and do not hide failing verification.',
];

export function renderStrictModeGuidance(surface: GuidanceSurface): string {
  if (!isStrictMode()) {
    return '';
  }

  return [STRICT_MODE_GUIDANCE_HEADER[surface], ...STRICT_MODE_GUIDANCE_LINES].join(
    '\n',
  );
}

export function appendStrictModeGuidance(
  basePrompt: string,
  surface: GuidanceSurface,
): string {
  const guidance = renderStrictModeGuidance(surface);
  if (!guidance) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${guidance}`;
}
