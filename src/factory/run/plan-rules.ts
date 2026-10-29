/**
 * Where a factory run's plan comes from (design §3, forges §5): a trusted
 * `omg-plan:` line, else an `Acceptance criteria` heading in the issue body.
 * Shared by the engine and `omg factory check` so the two cannot drift;
 * engine.ts re-exports these names.
 */

/** Comment authors whose `omg-plan:` line is read (GitHub authorAssociation). */
export const TRUSTED_PLAN_AUTHORS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export const PLAN_LINK = /^[^\S\r\n]*omg-plan:[^\S\r\n]*(\S+)[^\S\r\n]*$/im;
export const ACCEPTANCE = /^[^\S\r\n]*#{1,6}[^\S\r\n]*acceptance criteria\b/im;

export interface IssueComment {
  body?: unknown;
  authorAssociation?: unknown;
  author?: unknown;
  /**
   * Set by a forge adapter (ForgeComment.trusted, e.g. ADO createdBy.uniqueName
   * in trustedAuthors): `true` counts as a trusted association. Only the
   * boolean true does; raw `gh --json` comments have no such field.
   */
  trusted?: unknown;
}

/** A trusted association (GitHub OWNER/MEMBER/COLLABORATOR) or an adapter-vouched comment. */
export const commentTrusted = (c: IssueComment): boolean => c.trusted === true || trustedAssociation(c.authorAssociation);

const loginOf = (author: unknown): string => {
  const login = (author as { login?: unknown } | null | undefined)?.login;
  return typeof login === 'string' ? login.toLowerCase() : '';
};
const trustedAssociation = (a: unknown): boolean => typeof a === 'string' && TRUSTED_PLAN_AUTHORS.includes(a);

/**
 * Whether the issue's author is an OWNER, MEMBER or COLLABORATOR. `gh issue
 * view --json` has no authorAssociation for the issue itself, so: the author
 * owns the repository (the issue URL's owner), or a comment by the same login
 * carries a trusted association (it is per user and repository). Unknown is
 * untrusted.
 */
export function issueAuthorTrusted(v: { author?: unknown; url?: unknown; comments?: unknown }): boolean {
  const login = loginOf(v.author);
  if (!login) return false;
  const owner = typeof v.url === 'string' ? /^https:\/\/[^/\s]+\/([^/\s]+)\//.exec(v.url)?.[1] : undefined;
  if (owner && owner.toLowerCase() === login) return true;
  const comments = Array.isArray(v.comments) ? (v.comments as IssueComment[]) : [];
  return comments.some((c) => loginOf(c?.author) === login && trustedAssociation(c.authorAssociation));
}

/**
 * The issue body's `omg-plan:` line when its author is trusted
 * (issueAuthorTrusted), then the newest comment carrying one by an OWNER,
 * MEMBER or COLLABORATOR, or marked `trusted: true` by a forge adapter
 * (anyone else could redirect the plan).
 */
export function findPlanLink(body: string, comments: ReadonlyArray<IssueComment> = [], bodyAuthorTrusted = false): string | undefined {
  const inBody = bodyAuthorTrusted ? PLAN_LINK.exec(body)?.[1] : undefined;
  if (inBody) return inBody;
  for (const c of [...comments].reverse()) {
    if (!commentTrusted(c)) continue;
    const m = typeof c.body === 'string' ? PLAN_LINK.exec(c.body)?.[1] : undefined;
    if (m) return m;
  }
  return undefined;
}

export function hasAcceptanceCriteria(body: string): boolean {
  return ACCEPTANCE.test(body);
}
