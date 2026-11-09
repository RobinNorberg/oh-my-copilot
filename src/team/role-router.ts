// src/team/role-router.ts

/**
 * Intent-based role routing for team task assignment.
 *
 * Inspects task text to infer lane intent (what kind of work is needed),
 * then maps that intent to the most appropriate worker role.
 */

export type LaneIntent =
  | 'implementation'
  | 'verification'
  | 'review'
  | 'debug'
  | 'design'
  | 'docs'
  | 'build-fix'
  | 'cleanup'
  | 'unknown';

export interface RoleRouterResult {
  role: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** A committed path rule: files matching `glob` go to `role` (.copilot/team/routing.md, read by src/factory/team/routing.ts). */
export interface PathRoleRule {
  glob: string;
  role: string;
}

/** At most this many wildcards in one glob: the regex stays linear-ish and a hostile glob cannot blow up matching. */
const MAX_GLOB_WILDCARDS = 8;

/**
 * Whether `path` (repo-relative, `/` or `\` separated) matches `glob`:
 * `**` spans any number of segments (also none), `*` and `?` stay inside one
 * segment, everything else is literal. Case-sensitive. A glob that is empty,
 * absolute, has a `..` segment, or has more than 8 wildcards matches nothing.
 */
export function matchPathGlob(glob: string, path: string): boolean {
  if (!glob || glob.startsWith('/') || glob.split('/').includes('..')) return false;
  if ((glob.match(/\*+|\?/g) ?? []).length > MAX_GLOB_WILDCARDS) return false;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      while (glob[i + 1] === '*') i++;
      if (glob[i + 1] === '/') { source += '(?:.*/)?'; i++; } else source += '.*';
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** The role of the first rule matching any of `paths` (rule order, then path order), or undefined. */
export function routePathsToRole(paths: readonly string[], rules: readonly PathRoleRule[]): string | undefined {
  for (const rule of rules) if (paths.some((p) => matchPathGlob(rule.glob, p))) return rule.role;
  return undefined;
}

// ---------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------

/** Patterns that signal a specific lane intent */
const INTENT_PATTERNS: Array<{ intent: LaneIntent; patterns: RegExp[] }> = [
  {
    intent: 'build-fix',
    patterns: [
      /\bfix(?:ing)?\s+(?:the\s+)?(?:build|ci|lint|compile|tsc|type.?check)/i,
      /\bfailing\s+build\b/i,
      /\bbuild\s+(?:error|fail|broken|fix)/i,
      /\btsc\s+error/i,
      /\bcompile\s+error/i,
      /\bci\s+(?:fail|broken|fix)/i,
    ],
  },
  {
    intent: 'debug',
    patterns: [
      /\bdebug(?:ging)?\b/i,
      /\btroubleshoot(?:ing)?\b/i,
      /\binvestigate\b/i,
      /\broot.?cause\b/i,
      /\bwhy\s+(?:is|does|did|are)\b/i,
      /\bdiagnos(?:e|ing)\b/i,
      /\btrace\s+(?:the|an?)\s+(?:bug|issue|error|problem)/i,
    ],
  },
  {
    intent: 'docs',
    patterns: [
      /\bdocument(?:ation|ing|ation)?\b/i,
      /\bwrite\s+(?:docs|readme|changelog|comments|jsdoc|tsdoc)/i,
      /\bupdate\s+(?:docs|readme|changelog)/i,
      /\badd\s+(?:docs|comments|jsdoc|tsdoc)\b/i,
      /\breadme\b/i,
      /\bchangelog\b/i,
    ],
  },
  {
    intent: 'design',
    patterns: [
      /\bdesign\b/i,
      /\barchitect(?:ure|ing)?\b/i,
      /\bui\s+(?:design|layout|component)/i,
      /\bux\b/i,
      /\bwireframe\b/i,
      /\bmockup\b/i,
      /\bprototype\b/i,
      /\bsystem\s+design\b/i,
      /\bapi\s+design\b/i,
    ],
  },
  {
    intent: 'cleanup',
    patterns: [
      /\bclean\s*up\b/i,
      /\brefactor(?:ing)?\b/i,
      /\bsimplif(?:y|ying)\b/i,
      /\bdead\s+code\b/i,
      /\bunused\s+(?:code|import|variable|function)\b/i,
      /\bremove\s+(?:dead|unused|legacy)\b/i,
      /\bdebt\b/i,
    ],
  },
  {
    intent: 'review',
    patterns: [
      /\breview\b/i,
      /\baudit\b/i,
      /\bpr\s+review\b/i,
      /\bcode\s+review\b/i,
      /\bcheck\s+(?:the\s+)?(?:code|pr|pull.?request)\b/i,
    ],
  },
  {
    intent: 'verification',
    patterns: [
      /\btest(?:ing|s)?\b/i,
      /\bverif(?:y|ication)\b/i,
      /\bvalidat(?:e|ion)\b/i,
      /\bunit\s+test\b/i,
      /\bintegration\s+test\b/i,
      /\be2e\b/i,
      /\bspec\b/i,
      /\bcoverage\b/i,
      /\bassert(?:ion)?\b/i,
    ],
  },
  {
    intent: 'implementation',
    patterns: [
      /\bimplement(?:ing|ation)?\b/i,
      /\badd\s+(?:the\s+)?(?:feature|function|method|class|endpoint|route)\b/i,
      /\bbuild\s+(?:the\s+)?(?:feature|component|module|service|api)\b/i,
      /\bcreate\s+(?:the\s+)?(?:feature|component|module|service|api|function)\b/i,
      /\bwrite\s+(?:the\s+)?(?:code|function|class|method|module)\b/i,
    ],
  },
];

/** Security domain detection */
const SECURITY_DOMAIN_RE =
  /\b(?:auth(?:entication|orization)?|cve|injection|owasp|security|vulnerability|vuln|xss|csrf|sqli|rce|privilege.?escalat)\b/i;

/** Role-to-keyword mapping for keyword-count scoring fallback */
export const ROLE_KEYWORDS: Record<string, RegExp[]> = {
  'build-fixer': [/\bbuild\b/i, /\bci\b/i, /\bcompile\b/i, /\btsc\b/i, /\blint\b/i],
  debugger: [/\bdebug\b/i, /\btroubleshoot\b/i, /\binvestigate\b/i, /\bdiagnos/i],
  writer: [/\bdoc(?:ument)?/i, /\breadme\b/i, /\bchangelog\b/i, /\bcomment/i],
  designer: [/\bdesign\b/i, /\barchitect/i, /\bui\b/i, /\bux\b/i, /\bwireframe\b/i],
  'code-simplifier': [/\brefactor/i, /\bclean/i, /\bsimplif/i, /\bdebt\b/i, /\bunused\b/i],
  'security-reviewer': [/\bsecurity\b/i, /\bvulnerabilit/i, /\bcve\b/i, /\bowasp\b/i, /\bxss\b/i],
  'quality-reviewer': [/\breview\b/i, /\baudit\b/i, /\bcheck\b/i],
  'test-engineer': [/\btest/i, /\bverif/i, /\bvalidat/i, /\bspec\b/i, /\bcoverage\b/i],
  executor: [/\bimplement/i, /\bbuild\b/i, /\bcreate\b/i, /\badd\b/i, /\bwrite\b/i],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infer the lane intent from free-form task text.
 * Returns 'unknown' when no clear signal is found.
 */
export function inferLaneIntent(text: string): LaneIntent {
  if (!text || text.trim().length === 0) return 'unknown';

  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return intent;
      }
    }
  }

  return 'unknown';
}

/**
 * Route a task to the most appropriate role based on intent and domain.
 *
 * Priority:
 * 1. build-fix → 'build-fixer' (high)
 * 2. debug → 'debugger' (high)
 * 3. docs → 'writer' (high)
 * 4. design → 'designer' (high)
 * 5. cleanup → 'code-simplifier' (high)
 * 6. review + security domain → 'security-reviewer' (high), else 'quality-reviewer' (high)
 * 7. verification → 'test-engineer' (high)
 * 8. implementation + security domain → fallbackRole (stays put)
 * 9. Keyword-count scoring for ambiguous intents
 * 10. Unknown → fallbackRole (low)
 */
export function routeTaskToRole(
  taskSubject: string,
  taskDescription: string,
  fallbackRole: string,
  /** Committed path rules (.copilot/team/routing.md): a rule matching one of `paths` wins before any keyword. */
  pathRoutes?: { paths: readonly string[]; rules: readonly PathRoleRule[] }
): RoleRouterResult {
  const byPath = pathRoutes ? routePathsToRole(pathRoutes.paths, pathRoutes.rules) : undefined;
  if (byPath) return { role: byPath, confidence: 'high', reason: 'path rule matched (.copilot/team/routing.md)' };
  const combined = `${taskSubject} ${taskDescription}`.trim();
  const intent = inferLaneIntent(combined);
  const isSecurityDomain = SECURITY_DOMAIN_RE.test(combined);

  switch (intent) {
    case 'build-fix':
      return { role: 'build-fixer', confidence: 'high', reason: 'build-fix intent detected' };

    case 'debug':
      return { role: 'debugger', confidence: 'high', reason: 'debug intent detected' };

    case 'docs':
      return { role: 'writer', confidence: 'high', reason: 'docs intent detected' };

    case 'design':
      return { role: 'designer', confidence: 'high', reason: 'design intent detected' };

    case 'cleanup':
      return { role: 'code-simplifier', confidence: 'high', reason: 'cleanup intent detected' };

    case 'review':
      if (isSecurityDomain) {
        return { role: 'security-reviewer', confidence: 'high', reason: 'review intent with security domain detected' };
      }
      return { role: 'quality-reviewer', confidence: 'high', reason: 'review intent detected' };

    case 'verification':
      return { role: 'test-engineer', confidence: 'high', reason: 'verification intent detected' };

    case 'implementation':
      // Security implementation stays on fallback role — not routed to security-reviewer
      return {
        role: fallbackRole,
        confidence: 'medium',
        reason: isSecurityDomain
          ? 'implementation intent with security domain — stays on fallback role'
          : 'implementation intent — using fallback role',
      };

    case 'unknown':
    default: {
      // Keyword-count scoring fallback
      const best = scoreByKeywords(combined);
      if (best) {
        return {
          role: best.role,
          confidence: 'medium',
          reason: `keyword match (${best.count} hits) for role '${best.role}'`,
        };
      }
      return {
        role: fallbackRole,
        confidence: 'low',
        reason: 'no clear intent signal — using fallback role',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scoreByKeywords(text: string): { role: string; count: number } | null {
  let bestRole: string | null = null;
  let bestCount = 0;

  for (const [role, patterns] of Object.entries(ROLE_KEYWORDS)) {
    const count = patterns.filter(p => p.test(text)).length;
    if (count > bestCount) {
      bestCount = count;
      bestRole = role;
    }
  }

  return bestRole && bestCount > 0 ? { role: bestRole, count: bestCount } : null;
}
