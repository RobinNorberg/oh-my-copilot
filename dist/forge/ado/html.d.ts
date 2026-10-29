/**
 * Azure DevOps rich-text fields (System.Description, AcceptanceCriteria,
 * comments) to plain text (factory forges design §5, §8.5). Headings become
 * `## …` and list items `- `, so the plan rules (ACCEPTANCE) and the check
 * rules read them like a GitHub issue body. Entities are decoded once and
 * every other tag is dropped: the result is text that goes into prompts
 * fenced as untrusted; it is never rendered and keeps no markup.
 */
/** One pass, so `&amp;lt;` stays `&lt;`. Unknown names are kept verbatim. */
export declare function decodeEntities(s: string): string;
export declare function adoHtmlToText(html: unknown): string;
//# sourceMappingURL=html.d.ts.map