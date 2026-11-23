/**
 * The `omg factory dashboard` page (schemaVersion 2 data): a pure
 * `render(JSON) -> HTML` step. One self-contained document: inline CSS and
 * SVG, NO script, no external font or request (a CSP forbids them), no
 * buttons or forms (the dashboard takes no action; commands are copyable
 * text). Light and dark through prefers-color-scheme; tables stack into
 * cards under 700 px. Every dynamic string goes through esc(): titles,
 * reasons, lane ids and bench rows are untrusted, also inside attributes
 * and SVG text.
 */
import { ATTENTION_GROUPS, commandText, GROUP_TITLES } from '../attention/actions.js';
import { BENCH_UNSEALED_NOTE } from './collect-v2.js';
export const esc = (v) => String(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
export function fmtDuration(msValue) {
    const s = Math.round(msValue / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 48)
        return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const dur = (v) => (v === null || v === undefined ? '' : fmtDuration(v));
const num = (n) => (n === null || n === undefined ? '' : Number.isInteger(n) ? String(n) : n.toFixed(2));
const usageText = (u) => `${num(u.credits)} cr, ${u.premiumRequests} req`;
/** At most this many runs open in the Runs table; the rest sit behind one <details>. */
export const RUNS_OPEN = 50;
/** A table that stacks into labelled cards on narrow screens (data-label feeds the CSS). Cells are HTML already escaped by the caller. */
function table(caption, head, rows, empty) {
    if (rows.length === 0)
        return `<p class="muted">${esc(empty)}</p>`;
    return `<table class="stack"><caption class="sr">${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row" data-label="${esc(head[i])}">${c}</th>` : `<td data-label="${esc(head[i])}">${c}</td>`)).join('')}</tr>`).join('')}</tbody></table>`;
}
/** Horizontal bars as inline SVG with a text alternative (the same rows as a list for screen readers). */
function bars(rows, title, empty) {
    if (rows.length === 0)
        return `<p class="muted">${esc(empty)}</p>`;
    const max = Math.max(...rows.map((r) => r.value), 1e-9);
    const rowH = 26;
    const h = rows.length * rowH + 4;
    const body = rows.map((r, i) => {
        const y = i * rowH + 2;
        const w = Math.max(r.value > 0 ? 2 : 0, Math.round((r.value / max) * 300));
        return `<text x="0" y="${y + 16}" class="lbl">${esc(r.label.slice(0, 22))}</text><rect x="150" y="${y + 3}" width="${w}" height="16" rx="3" class="eng"/><text x="${156 + w}" y="${y + 16}" class="lbl">${esc(r.text)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 560 ${h}" width="100%" height="${h}" aria-hidden="true" focusable="false">${body}</svg><ul class="sr" aria-label="${esc(title)}">${rows.map((r) => `<li>${esc(r.label)}: ${esc(r.text)}</li>`).join('')}</ul>`;
}
/** One run's timeline: engine time and waiting-on-human time in two colours per phase, scaled to the run (each segment titled; timelineText is the text alternative). */
function timelineSvg(steps) {
    const total = steps.reduce((a, s) => a + s.engineMs + s.waitingMs, 0);
    if (total <= 0)
        return '';
    const W = 240;
    let x = 0;
    const parts = [];
    for (const s of steps) {
        for (const [ms, cls] of [[s.engineMs, 'eng'], [s.waitingMs, 'wait']]) {
            if (ms <= 0)
                continue;
            const w = Math.max(1, (ms / total) * W);
            parts.push(`<rect x="${x.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="12" class="${cls}"><title>${esc(`${s.phase}: ${cls === 'eng' ? 'engine' : 'waiting on you'} ${fmtDuration(ms)}`)}</title></rect>`);
            x += w;
        }
    }
    return `<svg class="tl" viewBox="0 0 ${Math.ceil(x)} 16" width="${W}" height="16" preserveAspectRatio="none" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}
function timelineText(steps) {
    return steps.filter((s) => s.engineMs > 0 || s.waitingMs > 0 || s.gates.length > 0)
        .map((s) => `${s.phase} ${fmtDuration(s.engineMs)}${s.waitingMs > 0 ? ` + waiting ${fmtDuration(s.waitingMs)}${s.gates.length ? ` (${[...new Set(s.gates)].join(', ')})` : ''}` : ''}`).join('; ');
}
function trustMark(trust) {
    return `<span class="bad">not verified (${esc(trust)})</span>`;
}
function statusOf(r) {
    if (!r.verified)
        return `${trustMark(r.trust)}${r.phase ? ` ${esc(r.phase)}` : ''}${r.gate ? ` awaiting-human: ${esc(r.gate.name)}` : ''}`;
    if (r.gate)
        return `awaiting-human: <b>${esc(r.gate.name)}</b>${r.waitingSince ? ` <span class="muted">since ${esc(r.waitingSince)}</span>` : ''}`;
    return esc(r.outcome === 'in-progress' ? r.phase ?? '' : r.outcome);
}
function runRow(r) {
    const tl = r.timeline.length ? `${timelineSvg(r.timeline)}<span class="tltext">${esc(timelineText(r.timeline))}</span>` : '';
    return [
        esc(r.key), esc(r.title), statusOf(r), r.pr === null ? '' : `#${esc(r.pr)}`, esc(num(r.credits)),
        esc(dur(r.engineMs)), esc(dur(r.waitingMs)), tl, esc(r.updatedAt ?? ''),
    ];
}
function commandsHtml(next) {
    if (next.length === 0)
        return '';
    return `<ul class="cmds">${next.map((n) => {
        const c = commandText(n.argv);
        return `<li>${c.inRoot ? '<span class="muted">in the repository root:</span> ' : ''}<code>${esc(c.line)}</code> <span class="muted">${esc(n.label)}${n.billed ? ' (billed)' : ''}</span></li>`;
    }).join('')}</ul>`;
}
function attentionHtml(d) {
    const items = d.attention.items;
    if (items.length === 0)
        return '<p class="ok">Nothing needs you.</p>';
    const out = [];
    for (const g of ATTENTION_GROUPS) {
        const group = items.filter((i) => i.group === g);
        if (group.length === 0)
            continue;
        out.push(`<h3 id="attention-${esc(g)}">${esc(GROUP_TITLES[g])} <span class="muted">(${group.length})</span></h3><ul class="items">`);
        for (const i of group) {
            const facts = [i.gate ? `awaiting-human: ${i.gate}` : '', i.phase ? `phase ${i.phase}` : '', i.ageMs === null ? '' : `waiting ${fmtDuration(i.ageMs)}`,
                i.credits === null ? '' : `${num(i.credits)}${i.cap === null ? '' : ` of ${i.cap}`} cr`, i.pr === null ? '' : `PR ${i.pr}`].filter(Boolean).join(' · ');
            out.push(`<li><p><b>${esc(i.key)}</b> ${esc(i.title)}${i.trust !== 'ok' ? ` ${trustMark(i.trust)}` : ''}</p><p class="muted">${esc(facts)}</p><p>${esc(i.why)}</p>${i.notes.map((n) => `<p class="warn">note: ${esc(n)}</p>`).join('')}${commandsHtml(i.next)}${i.log ? `<p class="muted">log: <code>${esc(i.log)}</code></p>` : ''}</li>`);
        }
        out.push('</ul>');
    }
    return out.join('');
}
export const CSS = `:root{--bg:#fafafa;--fg:#1b1f24;--muted:#4f5964;--card:#fff;--line:#d0d6dd;--eng:#2b6cb0;--wait:#b7791f;--warn:#8a5a00;--bad:#b42318;--ok:#1e6b3a;--code:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#a3adb8;--card:#1d2125;--line:#363d45;--eng:#63a4e8;--wait:#e0a84f;--warn:#f0b860;--bad:#ff8a80;--ok:#7bd88f;--code:#262b31}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
a{color:var(--eng)}main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}h3{font-size:15px;margin:12px 0 6px}
.skip{position:absolute;left:-9999px;top:0;background:var(--card);color:var(--fg);padding:8px;border:2px solid var(--eng)}.skip:focus{left:8px;top:8px;z-index:1}
nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 14px;padding:0;margin:8px 0}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}
.muted{color:var(--muted)}.warn{color:var(--warn)}.bad{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:0;padding:0;list-style:none}.tiles li{flex:1 1 140px;border:1px solid var(--line);border-radius:6px;padding:8px 10px}.tiles b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}thead th{color:var(--muted);font-weight:600}tbody th{font-weight:600}
code{font:13px/1.4 ui-monospace,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:3px;white-space:pre-wrap;word-break:break-all}
.items{list-style:none;padding:0;margin:0}.items>li{border-top:1px solid var(--line);padding:6px 0}.items p{margin:2px 0}.cmds{margin:4px 0;padding-left:18px}
svg{max-width:100%;height:auto}.eng{fill:var(--eng)}.wait{fill:var(--wait)}.lbl{fill:var(--fg);font-size:12px}.tl{display:block;margin:2px 0}.tltext{display:block;font-size:12px;color:var(--muted)}
.legend span{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;margin:0 4px 0 10px}.legend .e{background:var(--eng)}.legend .w{background:var(--wait)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}details summary{cursor:pointer;margin:8px 0}
@media (max-width:700px){body{padding:8px}table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}table.stack,table.stack tbody,table.stack tr,table.stack th,table.stack td{display:block;width:100%}
table.stack tr{border:1px solid var(--line);border-radius:6px;margin:0 0 8px;padding:4px 0}table.stack th,table.stack td{border:0;padding:2px 8px}
table.stack tbody th::before,table.stack td::before{content:attr(data-label);display:block;font-size:12px;color:var(--muted);font-weight:600}}`;
const SECTIONS = [['attention', 'Attention'], ['live', 'Live now'], ['runs', 'Runs'], ['tasks', 'Tasks'], ['cost', 'Cost'], ['throughput', 'Throughput'], ['bench', 'Bench']];
export function renderDashboardHtml(d, o = {}) {
    const needs = d.attention.items.length;
    const verified = d.runs.filter((r) => r.verified);
    const unverified = d.runs.length - verified.length;
    const tiles = [
        ['Needs you', String(needs)], ['Engines running', String(d.live.engines)], ['Runs', String(d.runs.length)],
        ['AI credits (verified runs)', num(d.cost.totals.credits)], ['Premium requests', String(d.cost.totals.premiumRequests)],
        ...(unverified ? [['Not verified', String(unverified)]] : []),
    ].map(([k, v]) => `<li><span class="muted">${esc(k)}</span><b>${esc(v)}</b></li>`).join('');
    const live = table('Engines running now', ['Run', 'Phase', 'Running lane', 'Last progress', 'Credits so far', 'In flight (cap)'], d.live.runs.map((r) => [esc(r.key), r.verified ? esc(r.phase ?? '') : trustMark('state'), r.lane ? `${esc(r.lane.id)} <span class="muted">${esc(r.lane.kind)}, since ${esc(r.lane.startedAt)}</span>` : '<span class="muted">none</span>',
        r.heartbeatAgeMs === null ? '<span class="muted">no progress log</span>' : `${esc(fmtDuration(r.heartbeatAgeMs))} ago <span class="muted">(a hint only)</span>`, esc(num(r.credits)), esc(num(r.inFlightCredits))]), d.live.slots > 0 ? `No run is held by a live engine (${d.live.slots} parallel slot(s) held).` : 'No engine is running.');
    const runHead = ['Run', 'Title', 'Status', 'PR', 'Credits', 'Engine', 'Waiting on you', 'Timeline', 'Updated'];
    const open = d.runs.slice(0, RUNS_OPEN).map(runRow);
    const older = d.runs.slice(RUNS_OPEN).map(runRow);
    const runs = d.runs.length === 0 ? '<p class="muted">No runs yet.</p>'
        : `<p class="legend muted" aria-hidden="true">Timeline:<span class="e"></span>engine<span class="w"></span>waiting on you</p>${table('Runs, newest first', runHead, open, '')}${older.length ? `<details><summary>${older.length} older run(s)</summary>${table('Older runs', runHead, older, '')}</details>` : ''}`;
    const forgeCols = d.forge.read;
    const tasks = table('Tasks: tracker item, run, PR and cost', ['Run', 'Title', 'Outcome', 'Phase / gate', 'PR', 'Credits', 'Wall time', ...(forgeCols ? ['Bucket', 'Tracker stage'] : [])], d.tasks.map((t) => [esc(t.key), esc(t.title), t.verified || t.outcome === 'no run' ? esc(t.outcome) : trustMark('state'), esc([t.phase, t.gate ? `awaiting-human: ${t.gate}` : ''].filter(Boolean).join(' / ')),
        t.pr === null ? '' : `#${esc(t.pr)}`, esc(num(t.credits)), esc(dur(t.wallMs)), ...(forgeCols ? [esc(t.tracker?.bucket ?? ''), esc([t.tracker?.stage, t.tracker?.liveText].filter(Boolean).join(': '))] : [])]), 'No runs yet.');
    const c = d.cost;
    const caps = c.caps.source === 'config'
        ? `Caps: ${esc(num(c.caps.laneMaxCredits))} credits per lane${c.caps.maxRunCredits === null ? ', no run cap' : `, ${esc(num(c.caps.maxRunCredits))} per run`}. <span class="muted">${esc(c.caps.note)}</span>`
        : `<span class="muted">${esc(c.caps.note)}</span>`;
    // An unverified state's own numbers are never shown (as attention withholds its free text): only how many runs are left out.
    const excluded = c.excluded.runs ? `<p class="warn">${esc(c.excluded.runs)} run(s) not verified, excluded from these totals${c.excluded.missing ? ` (${esc(c.excluded.missing)} of them with the state file missing)` : ''}.</p>` : '';
    const byRun = table('Credits per run', ['Run', 'Credits', 'Requests', 'Cap', 'Of cap'], c.byRun.map((r) => [esc(r.key), esc(num(r.credits)), esc(r.premiumRequests), esc(num(r.cap)), r.cap ? esc(`${Math.round((r.credits / r.cap) * 100)}%`) : '']), 'No runs yet.');
    const cost = `<p>${caps}</p><p>Total: ${esc(usageText(c.totals))}, ${esc(c.totals.lanes)} lanes.</p>${excluded}
<h3>Per role</h3>${bars(c.byRole.map((r) => ({ label: r.role, value: r.credits, text: usageText(r) })), 'Credits per role', 'No lanes yet.')}
<h3>Per day</h3>${bars(c.byDay.map((r) => ({ label: r.day, value: r.credits, text: usageText(r) })), 'Credits per day', 'No lanes yet.')}
<h3>Per run</h3>${c.byRun.length > 20 ? `<details><summary>${c.byRun.length} runs</summary>${byRun}</details>` : byRun}`;
    const t = d.throughput;
    const throughput = `<ul class="tiles"><li><span class="muted">Engine time to merge-ready, median</span><b>${esc(dur(t.engineToMergeReady.medianMs) || '-')}</b><span class="muted">p90 ${esc(dur(t.engineToMergeReady.p90Ms) || '-')}, ${t.engineToMergeReady.runs} run(s); waiting excluded</span></li><li><span class="muted">Waiting at the merge park, median</span><b>${esc(dur(t.waitingAtMerge.medianMs) || '-')}</b><span class="muted">${t.waitingAtMerge.runs} run(s)</span></li></ul>
${t.since ? `<p class="muted">Medians and per-day counts since ${esc(t.since)}.</p>` : ''}${t.excludedRuns ? `<p class="warn">${esc(t.excludedRuns)} run(s) left out of the medians: their history timestamps were out of order or later than now (see Warnings).</p>` : ''}
${table('Runs per day', ['Day', 'Started', 'Reached the merge park'], t.byDay.map((r) => [esc(r.day), esc(r.started), esc(r.mergeReady)]), 'No runs yet.')}`;
    // Bench files are unsealed and lane-writable: the collector keeps only plain words and finite numbers >= 0; a bad number reads "invalid".
    const bad = (b, f) => Array.isArray(b.invalid) && b.invalid.includes(f);
    const bnum = (b, f) => (bad(b, f) ? 'invalid' : num(b[f]));
    const bench = `<p class="warn">${esc(BENCH_UNSEALED_NOTE)}</p>` + table('Bench results, oldest first', ['File', 'Source', 'Started', 'Mode', 'Model', 'Passed', 'Requests', 'Credits', 'Wall time'], d.bench.map((b) => [esc(b.file), esc(b.source), esc(b.startedAt ?? ''), esc(b.mode ?? ''), esc(b.model ?? ''),
        esc(bad(b, 'passed') || bad(b, 'issues') ? 'invalid' : b.passed === null ? '' : `${b.passed}${b.issues === null ? '' : ` / ${b.issues}`}`),
        esc(bnum(b, 'premiumRequests')), esc(bnum(b, 'credits')), esc(bad(b, 'wallMs') ? 'invalid' : dur(b.wallMs))]), 'No bench results (bench-results/*.json, or pass --bench-dir).');
    const warnings = d.warnings.length ? `<section aria-labelledby="h-warnings"><h2 id="h-warnings">Warnings</h2><ul>${d.warnings.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul></section>` : '';
    const body = { attention: attentionHtml(d), live, runs, tasks, cost, throughput, bench };
    // The CLI validates --watch to 2..86400 s; anything else here (1e21, a fraction) is no refresh at all.
    const refresh = o.refreshSeconds !== undefined && Number.isSafeInteger(o.refreshSeconds) && o.refreshSeconds > 0 && o.refreshSeconds <= 86_400 ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">${refresh}
<meta name="color-scheme" content="light dark"><title>Factory Dashboard</title><style>${CSS}</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<header><h1>Factory dashboard</h1>
${d.warnings.length ? `<p class="warn"><a href="#h-warnings">${esc(d.warnings.length)} warning(s)</a></p>` : ''}<p class="muted">Generated ${esc(d.generatedAt)}${d.since ? `, since ${esc(d.since)} (Attention and Live now always show the present)` : ''}. ${d.forge.read ? `Local state, and the tracker as read at ${esc(d.forge.at ?? '')} (--forge).` : 'Local state only: no forge read.'}${refresh ? ` Reloads every ${o.refreshSeconds} s.` : ''}</p>
<nav aria-label="Sections"><ul>${SECTIONS.map(([id, title]) => `<li><a href="#${id}">${esc(title)}</a></li>`).join('')}</ul></nav></header>
<main id="main" tabindex="-1">
<section aria-label="Summary"><ul class="tiles">${tiles}</ul></section>
${SECTIONS.map(([id, title]) => `<section id="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${esc(title)}</h2>${body[id]}</section>${id === 'attention' ? warnings : ''}`).join('\n')}
</main></body></html>
`;
}
//# sourceMappingURL=render.js.map