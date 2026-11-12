/**
 * The `omg factory dashboard` page: one self-contained HTML document (inline
 * CSS and SVG, no script, no external font or request; a CSP forbids them),
 * light and dark through prefers-color-scheme. Every dynamic string goes
 * through esc(): issue titles, park text and bench rows are untrusted.
 */
export const esc = (v) => String(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
export function fmtDuration(msValue) {
    const s = Math.round(msValue / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
/** Horizontal bars as inline SVG: label, bar and value per row. */
function bars(rows, title) {
    if (rows.length === 0)
        return '<p class="muted">No data.</p>';
    const max = Math.max(...rows.map((r) => r.value), 1e-9);
    const rowH = 26;
    const h = rows.length * rowH + 4;
    const body = rows.map((r, i) => {
        const y = i * rowH + 2;
        const w = Math.max(r.value > 0 ? 2 : 0, Math.round((r.value / max) * 300));
        return `<text x="0" y="${y + 16}" class="lbl">${esc(r.label)}</text><rect x="150" y="${y + 3}" width="${w}" height="16" rx="3" class="bar"/><text x="${156 + w}" y="${y + 16}" class="val">${esc(r.text)}</text>`;
    }).join('');
    return `<svg role="img" aria-label="${esc(title)}" viewBox="0 0 560 ${h}" width="100%" height="${h}">${body}</svg>`;
}
const usageText = (u) => `${num(u.credits)} cr, ${u.premiumRequests} req`;
function table(head, rows) {
    if (rows.length === 0)
        return '<p class="muted">None.</p>';
    return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const CSS = `:root{--bg:#fafafa;--fg:#1b1f24;--muted:#5b6570;--card:#fff;--line:#d8dde3;--accent:#2b6cb0}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#98a2ad;--card:#1d2125;--line:#323940;--accent:#63a4e8}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}
.muted{color:var(--muted)}.tiles{display:flex;flex-wrap:wrap;gap:10px}.tile{flex:1 1 130px;border:1px solid var(--line);border-radius:6px;padding:8px 10px}
.tile b{display:block;font-size:20px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
svg{max-width:100%}.bar{fill:var(--accent)}.lbl,.val{fill:var(--fg);font-size:12px}.warn{color:#b7791f}`;
export function renderDashboardHtml(d) {
    const t = d.totals;
    const tiles = [
        ['Runs', String(t.runs)], ['Lanes', String(t.lanes)], ['AI credits', num(t.credits)], ['Premium requests', String(t.premiumRequests)], ['Engine time', fmtDuration(t.elapsedMs)],
    ].map(([k, v]) => `<div class="tile"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    const runs = table(['Run', 'Title', 'Status', 'PR', 'Lanes', 'Credits', 'Req', 'Time', 'Updated'], d.runs.map((r) => [r.key, r.title, r.gate ? `awaiting-human: ${r.gate.name} - ${r.gate.reason}` : r.phase, r.pr === null ? '' : `#${r.pr}`, String(r.lanes), num(r.credits), String(r.premiumRequests), fmtDuration(r.elapsedMs), r.updatedAt]));
    const bench = d.bench.length === 0 ? '<p class="muted">No bench-results/*.json found.</p>' : d.bench.map((b) => `
    <h3>${esc(b.file)} <span class="muted">schema ${esc(b.schemaVersion)}${b.mode ? `, ${esc(b.mode)}` : ''}${b.createdAt ? `, ${esc(b.createdAt)}` : ''}</span></h3>
    ${Object.keys(b.totals).length ? table(['Total', 'Value'], Object.entries(b.totals).map(([k, v]) => [k, String(v)])) : ''}
    ${b.issues.length ? table(['Issue', 'Expected', 'Outcome'], b.issues.map((i) => [i.id, i.expect ?? '', i.outcome])) : ''}`).join('');
    const warnings = d.warnings.length ? `<section><h2>Warnings</h2><ul>${d.warnings.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul></section>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="light dark"><title>Factory Dashboard</title><style>${CSS}</style></head>
<body><main>
<h1>Factory dashboard</h1>
<p class="muted">Generated ${esc(d.generatedAt)}${d.since ? `, since ${esc(d.since)}` : ''}. Local state only.</p>
<section><div class="tiles">${tiles}</div></section>
<section><h2>Runs</h2>${runs}</section>
<section><h2>Credits per role</h2>${bars(d.byRole.map((r) => ({ label: r.role, value: r.credits, text: usageText(r) })), 'Credits per role')}</section>
<section><h2>Credits per day</h2>${bars(d.byDay.map((r) => ({ label: r.day, value: r.credits, text: usageText(r) })), 'Credits per day')}</section>
<section><h2>Time in each phase</h2>${bars(d.phaseMs.map((p) => ({ label: p.phase, value: p.ms, text: fmtDuration(p.ms) })), 'Time per phase')}</section>
<section><h2>Run status</h2>${table(['Status', 'Runs'], d.statuses.map((s) => [s.phase, String(s.count)]))}</section>
<section><h2>Park reasons</h2>${bars(d.parkReasons.map((p) => ({ label: p.name, value: p.count, text: String(p.count) })), 'Park reasons')}</section>
<section><h2>Bench</h2>${bench}</section>
${warnings}
</main></body></html>
`;
}
//# sourceMappingURL=render.js.map