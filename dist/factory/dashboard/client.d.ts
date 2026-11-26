/**
 * The `omg factory dashboard --serve` page: one HTML document with NO data
 * in it, plus a hand-written script (CLIENT_JS) that fetches the summary,
 * renders it, and re-renders in place on the server's `changed` event.
 *
 * XSS rule: the script inserts every value with createElement /
 * createTextNode / setAttribute on a fixed attribute allowlist (h() throws
 * on any other name). It never uses innerHTML or similar, never builds a URL,
 * handler or selector from data, and its only fetch URLs are fixed strings
 * plus a run key re-validated against the server's own key pattern. Commands
 * appear only in the command component (<code> + Copy button) and are copied,
 * never run. A row whose state is not trusted shows the marker, a fixed
 * sentence chosen here from its trust value, the run key and the status
 * command built here from that key: no text or number the server sent for it.
 *
 * The pure parts (formatting, row model, filter/sort/paginate, the DOM
 * builders against any `document`) live on the FactoryDashboard object so
 * tests can run this exact source in a VM without a browser.
 */
/**
 * The browser script. Plain ES5-style JavaScript in a string: no template
 * literal and no `${` inside, so this TypeScript literal holds it verbatim.
 */
export declare const CLIENT_JS: string;
/**
 * The page. It holds no data at all (the script fetches it), so nothing from
 * a state is ever in this HTML. `nonce` is the response's CSP nonce, the only
 * thing that varies (base64: no character that needs escaping here).
 * `allRepos` (--serve --all-repos) adds the Repositories section first; the
 * script then fetches the repository list and one repository by its id.
 */
export declare function dashboardPageHtml(nonce: string, o?: {
    allRepos?: boolean;
}): string;
//# sourceMappingURL=client.d.ts.map