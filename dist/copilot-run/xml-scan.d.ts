/**
 * A tolerant single-pass XML tag scanner for the textual reads of a
 * repository's NuGet and MSBuild files (dotnet-sandbox.ts nugetConfigVerdict,
 * factory/run/dotnet-package-refs.ts). It never backtracks: every step moves
 * forward, and each `indexOf` either finds its end and jumps past it or ends
 * the scan, so a crafted file costs linear time (a backtracking regex over
 * `<!--` or an unclosed quote repeated took seconds at 256 KB).
 *
 * Not an XML parser. It reports the tags in order (comments skipped, a
 * quoted attribute value may hold `>`), and in `odd` every shape a reader
 * that relies on it should not trust: CDATA, a DOCTYPE, a processing
 * instruction other than a leading `<?xml ...?>` declaration, an entity
 * reference other than the five predefined ones, an unquoted attribute, an
 * unterminated comment, tag or value (the scan ends there), a stray `<`, a
 * close tag that does not match, an unclosed element, or a second root.
 */
export interface XmlTag {
    /** The tag name as written. */
    name: string;
    /** `</name>`. */
    close: boolean;
    /** `<name ... />`. */
    selfClose: boolean;
    /** [name, value] as written (entities not decoded). */
    attrs: Array<[string, string]>;
    /** The name of the element directly around this tag ('' at the top; for a close tag: around the element it closes). */
    parent: string;
    /** The offset of the tag's `<` and the one just past its `>`: the text between an open tag's `end` and its close tag's `start` is the element's content. */
    start: number;
    end: number;
}
export interface XmlScan {
    tags: XmlTag[];
    /** The text outside comments, tags and markup declarations (entities not decoded), joined by spaces. */
    text: string;
    /** Why the scan is not to be trusted (see the module comment); empty when nothing odd was seen. */
    odd: string[];
}
/** True when every `&` of `s` starts one of the five predefined entity references (no numeric or named other). */
export declare function onlyPredefinedEntities(s: string): boolean;
/** Scan `xml` (see the module comment). */
export declare function scanXml(xml: string): XmlScan;
//# sourceMappingURL=xml-scan.d.ts.map