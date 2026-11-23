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

import { CSS } from './render.js';

const SERVE_CSS = `
button{font:inherit;color:inherit;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:2px 8px;cursor:pointer}
button:hover{border-color:var(--eng)}
:focus-visible{outline:3px solid var(--eng);outline-offset:2px}
th button{background:none;border:0;padding:0;font-weight:600;color:inherit;text-align:left}
.toolbar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 8px}
.toolbar input,.toolbar select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:3px 6px;max-width:100%}
.conn{display:inline-block;margin:4px 0;padding:1px 8px;border-radius:10px;border:1px solid var(--line);font-size:13px}
.conn.live{color:var(--ok)}.conn.reconnecting{color:var(--warn)}.conn.stale{color:var(--bad)}
.cmds li{margin:2px 0}.cmds code{margin-right:6px}
pre.detail{font:12px/1.4 ui-monospace,Consolas,monospace;background:var(--code);padding:8px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}
.pager{display:flex;gap:10px;align-items:center;margin:8px 0}
.detailrow td{background:var(--bg)}
@media (max-width:700px){.detailrow td::before{content:none}}`;

/**
 * The browser script. Plain ES5-style JavaScript in a string: no template
 * literal and no `${` inside, so this TypeScript literal holds it verbatim.
 */
export const CLIENT_JS = String.raw`(function () {
'use strict';
var FD = {};
var SVG_NS = 'http://www.w3.org/2000/svg';
FD.ATTRS = ['class', 'id', 'scope', 'role', 'tabindex', 'type', 'colspan', 'for', 'value', 'selected', 'disabled',
  'aria-sort', 'aria-expanded', 'aria-controls', 'aria-label', 'aria-hidden', 'aria-live', 'data-k', 'data-label',
  'x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'focusable'];
FD.GROUPS = [['inspect', 'Inspect'], ['broken', 'Broken engine'], ['decide', 'Decide'], ['merge', 'Merge'], ['fix', 'Fix by hand'], ['limits', 'Limits / retry']];
FD.PAGE_SIZE = 200;

function add(doc, el, kids) {
  if (kids === null || kids === undefined || kids === false) return;
  if (!Array.isArray(kids)) kids = [kids];
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k === null || k === undefined || k === false || k === '') continue;
    if (typeof k === 'string' || typeof k === 'number') el.appendChild(doc.createTextNode(String(k)));
    else if (Array.isArray(k)) add(doc, el, k);
    else el.appendChild(k);
  }
}
/** The only way this script makes an element: allowlisted attribute names, values as attribute text, children as text nodes. */
function h(doc, tag, attrs, kids) {
  var el = tag.indexOf('svg:') === 0 ? doc.createElementNS(SVG_NS, tag.slice(4)) : doc.createElement(tag);
  if (attrs) {
    for (var name in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
      var v = attrs[name];
      if (v === null || v === undefined || v === false) continue;
      if (FD.ATTRS.indexOf(name) < 0) throw new Error('attribute not allowed: ' + name);
      el.setAttribute(name, v === true ? '' : String(v));
    }
  }
  add(doc, el, kids);
  return el;
}
FD.h = h;

FD.num = function (n) { return n === null || n === undefined || !isFinite(n) ? '' : (n % 1 === 0 ? String(n) : n.toFixed(2)); };
FD.fmtDur = function (ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '';
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  var hr = Math.floor(m / 60);
  if (hr < 48) return hr + 'h ' + (m % 60) + 'm';
  return Math.floor(hr / 24) + 'd ' + (hr % 24) + 'h';
};
/** An age as of now: the server's age at generatedAt plus the time since then. */
FD.ageNow = function (ageMs, generatedMs, nowMs) {
  if (ageMs === null || ageMs === undefined || !isFinite(ageMs)) return null;
  var since = isFinite(generatedMs) && isFinite(nowMs) ? Math.max(0, nowMs - generatedMs) : 0;
  return ageMs + since;
};
FD.relAge = function (isoText, nowMs) {
  var t = Date.parse(isoText);
  if (!isFinite(t)) return '';
  return FD.fmtDur(Math.max(0, nowMs - t)) + ' ago';
};
/** The API form of a run label (#12 -> 12, heal-0123abcd as is); null for anything else, so no other text reaches a fetch URL. */
FD.apiKey = function (label) {
  var m = /^#([1-9][0-9]{0,8})$/.exec(String(label));
  if (m) return m[1];
  return /^heal-[0-9a-f]{8}$/.test(String(label)) ? String(label) : null;
};
FD.isStatusArgv = function (argv) {
  if (!Array.isArray(argv) || argv.length !== 5 || argv[0] !== 'omg' || argv[1] !== 'factory' || argv[3] !== 'status') return false;
  if (argv[2] === 'run') return /^[1-9][0-9]{0,8}$/.test(argv[4]);
  return argv[2] === 'heal' && /^[0-9a-f]{8}$/.test(argv[4]);
};
/**
 * A row whose state is not trusted shows only the marker, the fixed sentence
 * of its trust value (chosen here, never the server's text), the run key and
 * the status command rebuilt here from that key.
 */
FD.UNTRUSTED_WHY = {
  seal: 'This run state is not the engine\'s last write: its integrity seal fails. Nothing from it is shown; read it with the status command.',
  ledger: 'This run state is not the engine\'s last write: the engine ledger does not hold these bytes. Nothing from it is shown; read it with the status command.',
  unverified: 'This run state cannot be verified on this host: the engine ledger has no record of it. Nothing from it is shown; read it with the status command.',
  missing: 'This run\'s state file is missing; the engine ledger holds its last write. Nothing from it is shown; read it with the status command.',
  owner: 'An owner file the engine did not write holds this run. Nothing from it is shown; read it with the status command.',
  unreadable: 'This run state cannot be read. Nothing from it is shown; read it with the status command.'
};
FD.trustOf = function (t) { return typeof t === 'string' && t !== 'ok' && Object.prototype.hasOwnProperty.call(FD.UNTRUSTED_WHY, t) ? t : 'unverified'; };
/** The read-only status command of a run label, built here from the validated key; null for any other label. */
FD.statusCommand = function (label) {
  var api = FD.apiKey(label);
  if (api === null) return null;
  var argv = /^heal-/.test(api) ? ['omg', 'factory', 'heal', 'status', api.slice(5)] : ['omg', 'factory', 'run', 'status', api];
  return { label: 'read the run state', argv: argv, line: argv.join(' '), billed: false, inRoot: false };
};
/** What an attention row may offer: everything on a trusted row, the client-built status command on any other. */
/** The keys of the runs this summary does not trust (runs list): a row of another section with such a key is untrusted too, whatever it says. */
FD.untrustedKeys = function (data) {
  var bad = Object.create(null);
  (data && Array.isArray(data.runs) ? data.runs : []).forEach(function (r) { if (r.verified !== true || r.trust !== 'ok') bad[String(r.key)] = true; });
  return bad;
};
FD.visibleNext = function (item) {
  if (item.trust === 'ok') return Array.isArray(item.next) ? item.next : [];
  var s = FD.statusCommand(item.key);
  return s ? [s] : [];
};

function statusText(r) {
  if (r.verified !== true) return 'not verified (' + FD.trustOf(r.trust) + ')';
  if (r.gate) return 'awaiting-human: ' + r.gate.name;
  return r.outcome === 'in-progress' ? (r.phase || '') : r.outcome;
}
FD.runRows = function (data) {
  return (data && Array.isArray(data.runs) ? data.runs : []).map(function (r, i) {
    var n = /^#([0-9]+)$/.exec(r.key);
    var ok = r.verified === true && r.trust === 'ok';
    return {
      key: String(r.key), order: n ? Number(n[1]) : null, index: i, verified: ok, trust: ok ? 'ok' : FD.trustOf(r.trust),
      title: ok ? String(r.title || '') : '', phase: ok && r.phase ? String(r.phase) : '', gate: ok && r.gate ? String(r.gate.name) : '',
      status: ok ? statusText(r) : statusText({ verified: false, trust: r.trust }), pr: ok && typeof r.pr === 'number' ? r.pr : null, credits: ok ? r.credits : null,
      engineMs: ok ? r.engineMs : null, waitingMs: ok ? r.waitingMs : null, updatedAt: ok ? r.updatedAt || '' : '', updatedMs: ok ? Date.parse(r.updatedAt) || null : null,
      timeline: ok && Array.isArray(r.timeline) ? r.timeline : []
    };
  });
};
FD.phases = function (rows) {
  var seen = {};
  var out = [];
  rows.forEach(function (r) { if (r.phase && !seen[r.phase]) { seen[r.phase] = true; out.push(r.phase); } });
  return out.sort();
};
FD.filterRows = function (rows, text, phase) {
  var t = String(text || '').trim().toLowerCase();
  return rows.filter(function (r) {
    if (phase && r.phase !== phase) return false;
    if (!t) return true;
    return (r.key + ' ' + r.title + ' ' + r.status + ' ' + (r.pr === null ? '' : '#' + r.pr)).toLowerCase().indexOf(t) >= 0;
  });
};
FD.SORTABLE = ['key', 'title', 'status', 'pr', 'credits', 'engineMs', 'waitingMs', 'updatedMs'];
FD.sortRows = function (rows, col, dir) {
  if (FD.SORTABLE.indexOf(col) < 0) return rows.slice();
  var sign = dir === 'desc' ? -1 : 1;
  var val = function (r) { return col === 'key' ? (r.order === null ? null : r.order) : r[col]; };
  return rows.slice().sort(function (a, b) {
    var x = val(a), y = val(b);
    var xn = x === null || x === undefined || x === '', yn = y === null || y === undefined || y === '';
    if (xn || yn) return xn && yn ? a.index - b.index : (xn ? 1 : -1);
    var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    if (col === 'key' && c === 0) c = a.key.localeCompare(b.key);
    return c !== 0 ? sign * c : a.index - b.index;
  });
};
FD.paginate = function (rows, page, size) {
  size = size || FD.PAGE_SIZE;
  var pages = Math.max(1, Math.ceil(rows.length / size));
  var p = Math.min(Math.max(1, page | 0), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages: pages, total: rows.length };
};

// ---- DOM builders: (doc, data, ctx) -> element. ctx: { now, genMs, ui, focus: {}, ages: [], on: {...} } ----

function table(doc, caption, head, rows, empty) {
  if (rows.length === 0) return h(doc, 'p', { 'class': 'muted' }, empty);
  return h(doc, 'table', { 'class': 'stack' }, [
    h(doc, 'caption', { 'class': 'sr' }, caption),
    h(doc, 'thead', null, h(doc, 'tr', null, head.map(function (c) { return h(doc, 'th', { scope: 'col' }, c); }))),
    h(doc, 'tbody', null, rows.map(function (cells) {
      return h(doc, 'tr', null, cells.map(function (c, i) { return h(doc, i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row', 'data-label': head[i] } : { 'data-label': head[i] }, c); }));
    }))
  ]);
}
/** The marker: a known trust value in brackets, or none (a row that carries no trust value). */
function trustMark(doc, trust) { return h(doc, 'span', { 'class': 'bad' }, trust === undefined ? 'not verified' : 'not verified (' + FD.trustOf(trust) + ')'); }

/** A command line with a control, line-separator or bidi character is never shown or copied (it could hide what runs). */
FD.UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
FD.commandEl = function (doc, n, fk, ctx) {
  if (FD.UNSAFE_LINE.test(String(n.line))) return h(doc, 'li', { 'class': 'warn' }, 'command not shown: it holds a control character');
  var code = h(doc, 'code', null, String(n.line));
  var btn = h(doc, 'button', { type: 'button', 'data-k': fk }, 'Copy');
  var line = String(n.line);
  if (ctx.on && ctx.on.copy) btn.addEventListener('click', function () { ctx.on.copy(line, code, btn); });
  ctx.focus[fk] = btn;
  return h(doc, 'li', null, [n.inRoot ? h(doc, 'span', { 'class': 'muted' }, 'in the repository root: ') : null, code, btn,
    h(doc, 'span', { 'class': 'muted' }, ' ' + String(n.label) + (n.billed ? ' (billed)' : ''))]);
};

/** --all-repos: the line before a repository's commands (they are repository-relative); its root as text only. */
FD.whereEl = function (doc, repo) {
  if (!repo) return null;
  return h(doc, 'p', { 'class': 'muted' }, repo.rootWord === null || repo.rootWord === undefined
    ? 'Run these in that repository\'s root (its path cannot be shown safely in a command):'
    : ['in ', h(doc, 'code', null, String(repo.rootWord)), ':']);
};

/** scope (--all-repos): { repo } of the rows' repository; group headings then carry no id and copy keys carry the repository id. */
FD.buildAttention = function (doc, data, ctx, scope) {
  var items = data.attention && Array.isArray(data.attention.items) ? data.attention.items : [];
  if (items.length === 0) return h(doc, 'p', { 'class': 'ok' }, 'Nothing needs you.');
  var repo = scope ? scope.repo : ctx.repo;
  var kp = repo ? FD.repoId(repo.id) + ':' : '';
  var bad = FD.untrustedKeys(data);
  var out = h(doc, 'div', null);
  FD.GROUPS.forEach(function (g) {
    var group = items.filter(function (i) { return i.group === g[0]; });
    if (group.length === 0) return;
    out.appendChild(h(doc, scope ? 'h4' : 'h3', scope ? null : { id: 'attention-' + g[0] }, [g[1] + ' ', h(doc, 'span', { 'class': 'muted' }, '(' + group.length + ')')]));
    out.appendChild(h(doc, 'ul', { 'class': 'items' }, group.map(function (i) {
      var trusted = i.trust === 'ok' && !bad[String(i.key)];
      if (!trusted) {
        var cmd = FD.statusCommand(i.key);
        var label = FD.apiKey(i.key) === null ? 'a run' : String(i.key);
        return h(doc, 'li', null, [
          h(doc, 'p', null, [h(doc, 'b', null, label), ' ', trustMark(doc, i.trust)]),
          h(doc, 'p', null, FD.UNTRUSTED_WHY[FD.trustOf(i.trust)]),
          cmd && repo ? FD.whereEl(doc, repo) : null,
          cmd ? h(doc, 'ul', { 'class': 'cmds', 'aria-label': 'Next commands' }, [FD.commandEl(doc, cmd, 'copy:' + kp + label + ':0', ctx)]) : null
        ]);
      }
      var age = h(doc, 'span', null, '');
      ctx.ages.push({ el: age, ageMs: i.ageMs, prefix: 'waiting ' });
      var facts = [i.gate ? 'awaiting-human: ' + i.gate : '', i.phase ? 'phase ' + i.phase : '',
        i.credits === null || i.credits === undefined ? '' : FD.num(i.credits) + (i.cap === null || i.cap === undefined ? '' : ' of ' + i.cap) + ' cr',
        i.pr === null || i.pr === undefined ? '' : 'PR ' + i.pr].filter(Boolean).join(' · ');
      var next = FD.visibleNext(i);
      return h(doc, 'li', null, [
        h(doc, 'p', null, [h(doc, 'b', null, String(i.key)), i.title ? ' ' + String(i.title) : null]),
        h(doc, 'p', { 'class': 'muted' }, [facts, facts ? ' · ' : '', age]),
        h(doc, 'p', null, String(i.why)),
        (Array.isArray(i.notes) ? i.notes : []).map(function (n) { return h(doc, 'p', { 'class': 'warn' }, 'note: ' + String(n)); }),
        next.length && repo && next.some(function (n) { return Array.isArray(n.argv) && n.argv[0] === 'omg'; }) ? FD.whereEl(doc, repo) : null,
        next.length ? h(doc, 'ul', { 'class': 'cmds', 'aria-label': 'Next commands' }, next.map(function (n, k) { return FD.commandEl(doc, n, 'copy:' + kp + i.key + ':' + k, ctx); })) : null,
        i.log ? h(doc, 'p', { 'class': 'muted' }, ['log: ', h(doc, 'code', null, String(i.log))]) : null
      ]);
    })));
  });
  return out;
};

FD.buildLive = function (doc, data, ctx) {
  var l = data.live || { runs: [], slots: 0 };
  return table(doc, 'Engines running now', ['Run', 'Phase', 'Running lane', 'Last progress', 'Credits so far', 'In flight (cap)'], l.runs.map(function (r) {
    var hb = h(doc, 'span', null, '');
    if (r.heartbeatAgeMs !== null) ctx.ages.push({ el: hb, ageMs: r.heartbeatAgeMs, suffix: ' ago (a hint only)' });
    if (r.verified !== true) return [String(r.key), trustMark(doc), '', '', '', ''];
    return [String(r.key), String(r.phase || ''),
      r.lane ? String(r.lane.id) + ' (' + String(r.lane.kind) + ')' : h(doc, 'span', { 'class': 'muted' }, 'none'),
      r.heartbeatAgeMs === null ? h(doc, 'span', { 'class': 'muted' }, 'no progress log') : hb, FD.num(r.credits), FD.num(r.inFlightCredits)];
  }), l.slots > 0 ? 'No run is held by a live engine (' + l.slots + ' parallel slot(s) held).' : 'No engine is running.');
};

FD.timelineEl = function (doc, steps) {
  var total = 0;
  steps.forEach(function (s) { total += (s.engineMs || 0) + (s.waitingMs || 0); });
  if (!(total > 0)) return null;
  var W = 240, x = 0, rects = [];
  steps.forEach(function (s) {
    [[s.engineMs, 'eng', 'engine'], [s.waitingMs, 'wait', 'waiting on you']].forEach(function (p) {
      if (!(p[0] > 0)) return;
      var w = Math.max(1, (p[0] / total) * W);
      rects.push(h(doc, 'svg:rect', { x: x.toFixed(1), y: 2, width: w.toFixed(1), height: 12, 'class': p[1] }, h(doc, 'svg:title', null, String(s.phase) + ': ' + p[2] + ' ' + FD.fmtDur(p[0]))));
      x += w;
    });
  });
  var textAlt = steps.filter(function (s) { return s.engineMs > 0 || s.waitingMs > 0; }).map(function (s) {
    return String(s.phase) + ' ' + FD.fmtDur(s.engineMs) + (s.waitingMs > 0 ? ' + waiting ' + FD.fmtDur(s.waitingMs) + (s.gates && s.gates.length ? ' (' + s.gates.join(', ') + ')' : '') : '');
  }).join('; ');
  return h(doc, 'div', null, [h(doc, 'svg:svg', { 'class': 'tl', viewBox: '0 0 ' + Math.ceil(x) + ' 16', width: W, height: 16, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, rects),
    h(doc, 'span', { 'class': 'tltext' }, textAlt)]);
};

FD.RUN_COLS = [['key', 'Run'], ['title', 'Title'], ['status', 'Status'], ['pr', 'PR'], ['credits', 'Credits'], ['engineMs', 'Engine'], ['waitingMs', 'Waiting on you'], [null, 'Timeline'], ['updatedMs', 'Updated'], [null, 'Detail']];

FD.buildDetail = function (doc, det) {
  if (!det) return h(doc, 'p', { 'class': 'muted' }, 'Loading…');
  if (det.error) return h(doc, 'p', { 'class': 'warn' }, String(det.error));
  var parts = [];
  // A run that is not trusted: the marker and its fixed sentence, nothing the server sent besides.
  if (!det.run || det.run.verified !== true || det.run.trust !== 'ok') return h(doc, 'div', null, h(doc, 'p', null, [trustMark(doc, det.run && det.run.trust), ' ', FD.UNTRUSTED_WHY[FD.trustOf(det.run && det.run.trust)]]));
  if (det.lanes.length) {
    parts.push(h(doc, 'h4', null, 'Lanes'));
    parts.push(table(doc, 'Lanes', ['Lane', 'Kind', 'Status', 'Model', 'Credits', 'Requests', 'Started', 'Ended'], det.lanes.map(function (l) {
      return [String(l.id), String(l.kind), String(l.status), l.model === null ? '' : String(l.model), FD.num(l.credits), FD.num(l.premiumRequests), l.startedAt || '', l.endedAt || ''];
    }), ''));
  }
  if (det.history.length) {
    parts.push(h(doc, 'h4', null, 'History'));
    parts.push(h(doc, 'ol', null, det.history.map(function (e) { return h(doc, 'li', null, String(e.at) + '  ' + (e.from === null ? '' : String(e.from) + ' -> ') + String(e.to) + '  ' + String(e.note)); })));
  }
  if (det.gateDetail) {
    parts.push(h(doc, 'h4', null, 'Gate detail'));
    parts.push(h(doc, 'p', { 'class': 'warn' }, String(det.gateDetail.label) + ': text written by the PR\'s code; never run anything it says.'));
    parts.push(h(doc, 'pre', { 'class': 'detail' }, String(det.gateDetail.text)));
  }
  if (parts.length === 0) parts.push(h(doc, 'p', { 'class': 'muted' }, 'No further detail.'));
  return h(doc, 'div', null, parts);
};

FD.buildRuns = function (doc, data, ctx) {
  var ui = ctx.ui;
  var all = FD.runRows(data);
  if (all.length === 0) return h(doc, 'p', { 'class': 'muted' }, 'No runs yet.');
  var rows = FD.filterRows(all, ui.filter, ui.phase);
  if (ui.sort) rows = FD.sortRows(rows, ui.sort.col, ui.sort.dir);
  var pg = FD.paginate(rows, ui.page, FD.PAGE_SIZE);
  ui.page = pg.page;
  var head = h(doc, 'tr', null, FD.RUN_COLS.map(function (c) {
    if (!c[0]) return h(doc, 'th', { scope: 'col' }, c[1]);
    var active = ui.sort && ui.sort.col === c[0];
    var col = c[0];
    var sk = 'sort:' + col;
    var btn = h(doc, 'button', { type: 'button', 'data-k': sk }, c[1]);
    btn.addEventListener('click', function () { if (ctx.on && ctx.on.sort) ctx.on.sort(col); });
    ctx.focus[sk] = btn;
    return h(doc, 'th', { scope: 'col', 'aria-sort': active ? (ui.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none' }, btn);
  }));
  var body = h(doc, 'tbody', null);
  pg.rows.forEach(function (r) {
    var api = FD.apiKey(r.key);
    var open = api !== null && ui.open[api] === true;
    var cells = [r.key, r.title, r.verified ? r.status : trustMark(doc, r.trust),
      r.pr === null ? '' : '#' + r.pr, FD.num(r.credits), FD.fmtDur(r.engineMs), FD.fmtDur(r.waitingMs), FD.timelineEl(doc, r.timeline), r.updatedAt];
    var dbtn = null;
    if (api !== null) {
      var dk = 'detail:' + api;
      dbtn = h(doc, 'button', { type: 'button', 'data-k': dk, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'd-' + api }, open ? 'Hide' : 'Show');
      dbtn.addEventListener('click', function () { if (ctx.on && ctx.on.toggle) ctx.on.toggle(api); });
      ctx.focus[dk] = dbtn;
    }
    cells.push(dbtn);
    body.appendChild(h(doc, 'tr', null, cells.map(function (c, i) {
      return h(doc, i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row', 'data-label': FD.RUN_COLS[i][1] } : { 'data-label': FD.RUN_COLS[i][1] }, c);
    })));
    if (open) body.appendChild(h(doc, 'tr', { 'class': 'detailrow', id: 'd-' + api }, h(doc, 'td', { colspan: FD.RUN_COLS.length }, FD.buildDetail(doc, ctx.details[api]))));
  });
  var out = [h(doc, 'p', { 'class': 'muted' }, pg.total + ' of ' + all.length + ' run(s)' + (pg.pages > 1 ? ', page ' + pg.page + ' of ' + pg.pages : '')),
    h(doc, 'table', { 'class': 'stack' }, [h(doc, 'caption', { 'class': 'sr' }, 'Runs'), h(doc, 'thead', null, head), body])];
  if (pg.pages > 1) {
    var prev = h(doc, 'button', { type: 'button', 'data-k': 'page:prev', disabled: pg.page <= 1 }, 'Previous');
    var next = h(doc, 'button', { type: 'button', 'data-k': 'page:next', disabled: pg.page >= pg.pages }, 'Next');
    prev.addEventListener('click', function () { if (ctx.on && ctx.on.page) ctx.on.page(-1); });
    next.addEventListener('click', function () { if (ctx.on && ctx.on.page) ctx.on.page(1); });
    ctx.focus['page:prev'] = prev;
    ctx.focus['page:next'] = next;
    out.push(h(doc, 'div', { 'class': 'pager' }, [prev, next]));
  }
  return h(doc, 'div', null, out);
};

FD.buildTasks = function (doc, data) {
  var forge = data.forge && data.forge.read;
  var head = ['Run', 'Title', 'Outcome', 'Phase / gate', 'PR', 'Credits', 'Wall time'].concat(forge ? ['Bucket', 'Tracker stage'] : []);
  var untrustedRun = FD.untrustedKeys(data);
  return table(doc, 'Tasks', head, (data.tasks || []).map(function (t) {
    // A board row with no run holds tracker text; a run row that is not verified shows the key and the marker only.
    var ok = !untrustedRun[String(t.key)] && (t.verified === true || t.outcome === 'no run');
    var row = ok ? [String(t.key), String(t.title), String(t.outcome),
      [t.phase, t.gate ? 'awaiting-human: ' + t.gate : ''].filter(Boolean).join(' / '), t.pr === null ? '' : '#' + t.pr, FD.num(t.credits), FD.fmtDur(t.wallMs)]
      : [String(t.key), '', trustMark(doc), '', '', '', ''];
    if (forge) row.push(t.tracker && t.tracker.bucket ? String(t.tracker.bucket) : '', t.tracker ? [t.tracker.stage, t.tracker.liveText].filter(Boolean).join(': ') : '');
    return row;
  }), 'No runs yet.');
};

FD.buildCost = function (doc, data) {
  var c = data.cost;
  var u = function (x) { return FD.num(x.credits) + ' cr, ' + x.premiumRequests + ' req'; };
  return h(doc, 'div', null, [
    h(doc, 'p', null, c.caps.source === 'config' ? 'Caps: ' + FD.num(c.caps.laneMaxCredits) + ' credits per lane' + (c.caps.maxRunCredits === null ? ', no run cap.' : ', ' + FD.num(c.caps.maxRunCredits) + ' per run.') : String(c.caps.note)),
    h(doc, 'p', null, 'Total: ' + u(c.totals) + ', ' + c.totals.lanes + ' lanes.'),
    c.excluded.runs ? h(doc, 'p', { 'class': 'warn' }, c.excluded.runs + ' run(s) are not verified and are not in these totals.') : null,
    h(doc, 'h3', null, 'Per role'), table(doc, 'Credits per role', ['Role', 'Usage'], c.byRole.map(function (r) { return [String(r.role), u(r)]; }), 'No lanes yet.'),
    h(doc, 'h3', null, 'Per day'), table(doc, 'Credits per day', ['Day', 'Usage'], c.byDay.map(function (r) { return [String(r.day), u(r)]; }), 'No lanes yet.'),
    h(doc, 'h3', null, 'Per run'), table(doc, 'Credits per run', ['Run', 'Credits', 'Requests', 'Cap'], c.byRun.map(function (r) { return [String(r.key), FD.num(r.credits), FD.num(r.premiumRequests), FD.num(r.cap)]; }), 'No runs yet.')
  ]);
};

FD.buildThroughput = function (doc, data) {
  var t = data.throughput;
  return h(doc, 'div', null, [
    h(doc, 'ul', { 'class': 'tiles' }, [
      h(doc, 'li', null, [h(doc, 'span', { 'class': 'muted' }, 'Engine time to merge-ready, median'), h(doc, 'b', null, FD.fmtDur(t.engineToMergeReady.medianMs) || '-'),
        h(doc, 'span', { 'class': 'muted' }, 'p90 ' + (FD.fmtDur(t.engineToMergeReady.p90Ms) || '-') + ', ' + t.engineToMergeReady.runs + ' run(s); waiting excluded')]),
      h(doc, 'li', null, [h(doc, 'span', { 'class': 'muted' }, 'Waiting at the merge park, median'), h(doc, 'b', null, FD.fmtDur(t.waitingAtMerge.medianMs) || '-'),
        h(doc, 'span', { 'class': 'muted' }, t.waitingAtMerge.runs + ' run(s)')])
    ]),
    table(doc, 'Runs per day', ['Day', 'Started', 'Reached the merge park'], t.byDay.map(function (r) { return [String(r.day), String(r.started), String(r.mergeReady)]; }), 'No runs yet.')
  ]);
};

FD.BENCH_NOTE = 'Unsealed files in the repository (anyone who can write the repository can edit them).';
FD.BENCH_TEXT = /^[A-Za-z0-9._ -]+$/;
/** A bench text field: a plain word or "(not shown)" (the server already filters; this page does again). */
FD.benchText = function (v) { return v === null || v === undefined ? '' : (FD.BENCH_TEXT.test(String(v)) && String(v).length <= 120 ? String(v) : '(not shown)'); };
/** A bench number: finite and >= 0, else "invalid" (also when the server marked the field invalid). */
FD.benchNum = function (b, f, fmt) {
  var v = b[f];
  if ((Array.isArray(b.invalid) && b.invalid.indexOf(f) >= 0) || (v !== null && v !== undefined && !(typeof v === 'number' && isFinite(v) && v >= 0))) return 'invalid';
  return v === null || v === undefined ? '' : fmt(v);
};
FD.buildBench = function (doc, data) {
  var ident = function (v) { return String(v); };
  return h(doc, 'div', null, [h(doc, 'p', { 'class': 'warn' }, FD.BENCH_NOTE),
    table(doc, 'Bench results', ['File', 'Source', 'Started', 'Mode', 'Model', 'Passed', 'Requests', 'Credits', 'Wall time'], (data.bench || []).map(function (b) {
      var passed = FD.benchNum(b, 'passed', ident);
      var issues = FD.benchNum(b, 'issues', ident);
      return [FD.benchText(b.file), b.source === 'bench-dir' ? 'bench-dir' : 'bench-results', /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(String(b.startedAt)) ? String(b.startedAt) : '', FD.benchText(b.mode), FD.benchText(b.model),
        passed === 'invalid' || issues === 'invalid' ? 'invalid' : passed + (passed !== '' && issues !== '' ? ' / ' + issues : ''),
        FD.benchNum(b, 'premiumRequests', FD.num), FD.benchNum(b, 'credits', FD.num), FD.benchNum(b, 'wallMs', FD.fmtDur)];
    }), 'No bench results (bench-results/*.json, or pass --bench-dir).')]);
};

FD.buildSummary = function (doc, data) {
  var verified = (data.runs || []).filter(function (r) { return r.verified; }).length;
  var tiles = [['Needs you', data.attention.items.length], ['Engines running', data.live.engines], ['Runs', data.runs.length],
    ['AI credits (verified runs)', FD.num(data.cost.totals.credits)], ['Premium requests', data.cost.totals.premiumRequests]];
  if (data.runs.length - verified) tiles.push(['Not verified', data.runs.length - verified]);
  return h(doc, 'ul', { 'class': 'tiles' }, tiles.map(function (t) { return h(doc, 'li', null, [h(doc, 'span', { 'class': 'muted' }, t[0]), h(doc, 'b', null, String(t[1]))]); }));
};

FD.buildWarnings = function (doc, data) {
  var w = Array.isArray(data.warnings) ? data.warnings : [];
  if (w.length === 0) return h(doc, 'p', { 'class': 'muted' }, 'None.');
  return h(doc, 'ul', null, w.map(function (x) { return h(doc, 'li', { 'class': 'warn' }, String(x)); }));
};

/** A repository id as the server issued it (16 hex); null for anything else, so no other text reaches a fetch URL. */
FD.repoId = function (id) { return /^[0-9a-f]{16}$/.test(String(id)) ? String(id) : null; };
FD.reposOf = function (list) { return list && Array.isArray(list.repos) ? list.repos.filter(function (r) { return FD.repoId(r.id) !== null; }) : []; };
FD.groupCounts = function (byGroup) {
  return FD.GROUPS.filter(function (g) { return byGroup && byGroup[g[0]] > 0; }).map(function (g) { return g[1].toLowerCase() + ' ' + byGroup[g[0]]; }).join(', ');
};

/** --all-repos: one row per repository (name, path as text, counts, engines, last change) with a button that selects it. */
FD.buildRepos = function (doc, list, ctx) {
  var repos = FD.reposOf(list);
  var sel = ctx.ui.repo || null;
  var allBtn = h(doc, 'button', { type: 'button', 'data-k': 'repo:all', disabled: sel === null }, 'All repositories');
  allBtn.addEventListener('click', function () { if (ctx.on && ctx.on.repo) ctx.on.repo(null); });
  ctx.focus['repo:all'] = allBtn;
  var s = list && list.summary ? list.summary : { repos: 0, skipped: 0 };
  var parts = [h(doc, 'p', null, [allBtn, ' ', h(doc, 'span', { 'class': 'muted' }, s.repos + ' repositor' + (s.repos === 1 ? 'y' : 'ies') + (s.skipped ? '; ' + s.skipped + ' ledger record(s) skipped (see the terminal: omg factory attention --all-repos --verbose)' : ''))])];
  parts.push(table(doc, 'Repositories', ['Repository', 'Path', 'Needs you', 'Engines running', 'Runs', 'Last change', 'View'], repos.map(function (r) {
    var id = FD.repoId(r.id);
    var b = h(doc, 'button', { type: 'button', 'data-k': 'repo:' + id, disabled: sel === id }, sel === id ? 'Shown' : 'Show');
    b.addEventListener('click', function () { if (ctx.on && ctx.on.repo) ctx.on.repo(id); });
    var rk = 'repo:' + id;
    ctx.focus[rk] = b;
    var last = h(doc, 'span', null, r.lastChange ? FD.relAge(String(r.lastChange), ctx.now || Date.now()) : '');
    return [String(r.name), h(doc, 'code', null, String(r.root)), r.items ? FD.groupCounts(r.byGroup) : h(doc, 'span', { 'class': 'ok' }, 'nothing'),
      String(r.engines), String(r.runs), last, b];
  }), 'No repository with factory runs is recorded on this host.'));
  return h(doc, 'div', null, parts);
};

/** --all-repos, "all repositories": the Attention rows grouped by repository, most urgent repository first. */
FD.buildAllAttention = function (doc, list, ctx) {
  var repos = FD.reposOf(list).filter(function (r) { return Array.isArray(r.attention) && r.attention.length > 0; });
  if (repos.length === 0) return h(doc, 'p', { 'class': 'ok' }, 'Nothing needs you in any repository.');
  return h(doc, 'div', null, repos.map(function (r) {
    return h(doc, 'div', null, [
      h(doc, 'h3', null, [String(r.name) + ' ', h(doc, 'span', { 'class': 'muted' }, '(' + r.attention.length + ')')]),
      h(doc, 'p', { 'class': 'muted' }, h(doc, 'code', null, String(r.root))),
      FD.buildAttention(doc, { attention: { items: r.attention } }, ctx, { repo: r })
    ]);
  }));
};

FD.tickAges = function (ages, genMs, nowMs) {
  ages.forEach(function (a) {
    var ms = FD.ageNow(a.ageMs, genMs, nowMs);
    a.el.textContent = ms === null ? '' : (a.prefix || '') + FD.fmtDur(ms) + (a.suffix || '');
  });
};

FD.SECTIONS = [['summary', FD.buildSummary], ['attention', FD.buildAttention], ['live', FD.buildLive], ['runs', FD.buildRuns], ['tasks', FD.buildTasks],
  ['cost', FD.buildCost], ['throughput', FD.buildThroughput], ['bench', FD.buildBench], ['warnings', FD.buildWarnings]];

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/** Builds every section into the elements byId(id) returns (b-<section>); returns the ctx with the focus map and the age list. */
FD.renderAll = function (doc, data, ui, details, on, byId, repo) {
  var ctx = { ui: ui, details: details, on: on, focus: {}, ages: [], repo: repo || null };
  FD.SECTIONS.forEach(function (s) {
    var target = byId('b-' + s[0]);
    if (!target) return;
    var built = s[1](doc, data, ctx);
    clear(target);
    target.appendChild(built);
  });
  return ctx;
};

if (typeof globalThis !== 'undefined') globalThis.FactoryDashboard = FD;

// ---- the live page --------------------------------------------------------
function start() {
  var doc = document;
  var byId = function (id) { return doc.getElementById(id); };
  var data = null;
  var lastOk = null;
  var ctx = { ages: [], focus: {} };
  var ui = { filter: '', phase: '', sort: null, page: 1, open: {}, repo: null };
  // --all-repos: the page has a Repositories section; a repository is selected by the id the server issued.
  var multi = !!byId('b-repos');
  var list = null;
  var REPO_ONLY = ['summary', 'live', 'runs', 'tasks', 'cost', 'throughput', 'bench', 'warnings'];
  function selectedRepo() {
    if (!list || ui.repo === null) return null;
    var hit = FD.reposOf(list).filter(function (r) { return r.id === ui.repo; });
    return hit.length ? hit[0] : null;
  }
  var details = {};
  var pending = false;
  var lastCount = null;
  var conn = 'connecting';

  function setConn(state) {
    conn = state;
    var el = byId('conn');
    el.setAttribute('class', 'conn ' + state);
    el.textContent = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting…'
      : state === 'stale' ? 'Stale' + (lastOk ? ' since ' + new Date(lastOk).toLocaleTimeString() : '') : 'Connecting…';
  }
  function selecting() {
    var s = window.getSelection && window.getSelection();
    return !!(s && !s.isCollapsed && s.anchorNode && byId('main').contains(s.anchorNode));
  }
  function syncPhases() {
    var sel = byId('f-phase');
    var want = [''].concat(FD.phases(FD.runRows(data)));
    var have = [];
    for (var i = 0; i < sel.options.length; i++) have.push(sel.options[i].value);
    if (have.join('\n') !== want.join('\n')) {
      clear(sel);
      want.forEach(function (p) { sel.appendChild(FD.h(doc, 'option', { value: p }, p === '' ? 'all phases' : p)); });
    }
    if (want.indexOf(ui.phase) < 0) ui.phase = '';
    sel.value = ui.phase;
  }
  function renderRepos() {
    var rctx = { ui: ui, on: on, focus: {}, ages: [], now: Date.now() };
    var target = byId('b-repos');
    clear(target);
    target.appendChild(FD.buildRepos(doc, list, rctx));
    var r = selectedRepo();
    byId('scope').textContent = r ? 'Showing one repository: ' + String(r.name) : 'Showing all repositories';
    REPO_ONLY.forEach(function (id) { var el = byId('b-' + id); if (el && el.parentNode) el.parentNode.hidden = r === null; });
    return rctx;
  }
  function render() {
    if (multi ? !list : !data) return;
    if (selecting()) { pending = true; return; }
    pending = false;
    var active = doc.activeElement;
    var fk = active && active.getAttribute ? active.getAttribute('data-k') : null;
    var x = window.scrollX, y = window.scrollY;
    var rctx = multi ? renderRepos() : null;
    if (multi && (selectedRepo() === null || !data)) {
      ctx = { ui: ui, details: details, on: on, focus: rctx.focus, ages: [] };
      var att = byId('b-attention');
      clear(att);
      att.appendChild(selectedRepo() === null ? FD.buildAllAttention(doc, list, ctx) : FD.h(doc, 'p', { 'class': 'muted' }, 'Loading…'));
      FD.tickAges(ctx.ages, Date.parse(list.generatedAt), Date.now());
      if (fk && ctx.focus[fk]) ctx.focus[fk].focus({ preventScroll: true });
      window.scrollTo(x, y);
      byId('generated').textContent = 'Data as of ' + new Date(Date.parse(list.generatedAt)).toLocaleString() + '; local state only, no forge read';
      return;
    }
    syncPhases();
    ctx = FD.renderAll(doc, data, ui, details, on, byId, multi ? selectedRepo() : null);
    if (rctx) Object.keys(rctx.focus).forEach(function (k) { ctx.focus[k] = rctx.focus[k]; });
    FD.tickAges(ctx.ages, Date.parse(data.generatedAt), Date.now());
    if (fk && ctx.focus[fk]) ctx.focus[fk].focus({ preventScroll: true });
    window.scrollTo(x, y);
    byId('generated').textContent = 'Data as of ' + new Date(Date.parse(data.generatedAt)).toLocaleString() + (data.forge && data.forge.read ? '; tracker read at ' + data.forge.at + ' (--forge)' : '; local state only, no forge read')
      + (data.stale === true ? '. Stale: this repository is slow to read, so it is refreshed less often; a newer state is waiting to be read' : '');
  }
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function loadDetail(api) {
    if (FD.apiKey(api) === null && !/^[1-9][0-9]{0,8}$/.test(api)) return;
    if (multi && FD.repoId(ui.repo) === null) return;
    var want = ui.repo;
    var rid = FD.repoId(want);
    fetchJson(multi ? 'api/v1/repo/' + rid + '/run/' + api : 'api/v1/run/' + api).then(function (d) { if (ui.repo !== want) return; details[api] = d; render(); }, function () { details[api] = { error: 'The detail could not be loaded (the run may be gone).' }; render(); });
  }
  function loadRepos() {
    fetchJson('api/v1/repos').then(function (d) {
      if (!d || d.schemaVersion !== 1 || d.allRepos !== true) throw new Error('unexpected data');
      list = d;
      lastOk = Date.now();
      if (conn !== 'live' && conn !== 'reconnecting') setConn('live');
      // A repository that disappeared from the server's list falls back to "all repositories".
      if (ui.repo !== null && selectedRepo() === null) { ui.repo = null; data = null; }
      var count = d.summary.items;
      if (lastCount !== null && count !== lastCount) byId('announce').textContent = count === 0 ? 'Nothing needs you now.' : count + (count === 1 ? ' item needs' : ' items need') + ' you now.';
      lastCount = count;
      render();
    }, function () { setConn('stale'); });
  }
  function load() {
    if (multi) loadRepos();
    if (!multi || FD.repoId(ui.repo) !== null) loadSummary();
  }
  function loadSummary() {
    var want = ui.repo;
    var rid = FD.repoId(want);
    fetchJson(multi ? 'api/v1/repo/' + rid + '/summary' : 'api/v1/summary').then(function (d) {
      if (!d || d.schemaVersion !== 2) throw new Error('unexpected data');
      if (multi && ui.repo !== want) return;
      var changed = !data || data.rev !== d.rev;
      data = d;
      lastOk = Date.now();
      if (conn !== 'live' && conn !== 'reconnecting') setConn('live');
      var count = d.attention.items.length;
      if (!multi && lastCount !== null && count !== lastCount) byId('announce').textContent = count === 0 ? 'Nothing needs you now.' : count + (count === 1 ? ' item needs' : ' items need') + ' you now.';
      if (!multi) lastCount = count;
      if (changed) Object.keys(ui.open).forEach(function (k) { if (ui.open[k]) loadDetail(k); });
      render();
    }, function () { setConn('stale'); });
  }
  var on = {
    copy: function (text, codeEl, btn) {
      var done = function (ok) {
        btn.textContent = ok ? 'Copied' : 'Selected: press Ctrl+C';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      };
      var selectIt = function () {
        var r = doc.createRange();
        r.selectNodeContents(codeEl);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectIt(); done(false); });
      else { selectIt(); done(false); }
    },
    sort: function (col) {
      ui.sort = ui.sort && ui.sort.col === col ? { col: col, dir: ui.sort.dir === 'asc' ? 'desc' : 'asc' } : { col: col, dir: 'asc' };
      render();
    },
    toggle: function (api) {
      ui.open[api] = !ui.open[api];
      if (ui.open[api]) { delete details[api]; loadDetail(api); }
      render();
    },
    page: function (d) { ui.page += d; render(); },
    repo: function (id) {
      var next = id === null ? null : FD.repoId(id);
      if (id !== null && next === null) return;
      ui.repo = next;
      ui.open = {};
      ui.page = 1;
      details = {};
      data = null;
      render();
      if (next !== null) loadSummary();
    }
  };
  byId('f-text').addEventListener('input', function (e) { ui.filter = e.target.value; ui.page = 1; render(); });
  byId('f-phase').addEventListener('change', function (e) { ui.phase = e.target.value; ui.page = 1; render(); });
  doc.addEventListener('selectionchange', function () { if (pending && !selecting()) render(); });
  setInterval(function () {
    if (multi && !data && list) FD.tickAges(ctx.ages, Date.parse(list.generatedAt), Date.now());
    else if (data) FD.tickAges(ctx.ages, Date.parse(data.generatedAt), Date.now());
    if (conn === 'stale') setConn('stale');
  }, 5000);

  var es = null;
  function connect() {
    es = new EventSource('events');
    es.addEventListener('changed', function (e) {
      if (!multi) { if (!data || String(e.data) !== data.rev) load(); return; }
      // --all-repos: "repos <rev>" for the list, "<id> <rev>" for one repository.
      var parts = String(e.data).split(' ');
      if (parts[0] === 'repos') { if (!list || parts[1] !== list.rev) loadRepos(); }
      else if (ui.repo !== null && parts[0] === ui.repo && (!data || parts[1] !== data.rev)) loadSummary();
    });
    es.addEventListener('open', function () { setConn('live'); load(); });
    es.addEventListener('error', function () {
      if (es.readyState === 2) { setConn('stale'); setTimeout(connect, 10000); } else setConn('reconnecting');
    });
  }
  setConn('connecting');
  load();
  connect();
}
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('main')) start();
})();
`;

const SECTIONS: readonly (readonly [string, string])[] = [
  ['attention', 'Attention'], ['live', 'Live now'], ['runs', 'Runs'], ['tasks', 'Tasks'], ['cost', 'Cost'], ['throughput', 'Throughput'], ['bench', 'Bench'], ['warnings', 'Warnings'],
];

/**
 * The page. It holds no data at all (the script fetches it), so nothing from
 * a state is ever in this HTML. `nonce` is the response's CSP nonce, the only
 * thing that varies (base64: no character that needs escaping here).
 * `allRepos` (--serve --all-repos) adds the Repositories section first; the
 * script then fetches the repository list and one repository by its id.
 */
export function dashboardPageHtml(nonce: string, o: { allRepos?: boolean } = {}): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce)) throw new Error('bad nonce');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Factory Dashboard</title>
<style nonce="${nonce}">${CSS}${SERVE_CSS}</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<header><h1>Factory dashboard</h1>
<p><span id="conn" class="conn">Connecting…</span> <span id="generated" class="muted"></span></p>
<p class="muted">Live, read-only and local: this page copies commands and never runs them. Stop the server with Ctrl-C in its terminal.</p>
<nav aria-label="Sections"><ul>${o.allRepos ? '<li><a href="#repos">Repositories</a></li>' : ''}${SECTIONS.map(([id, title]) => `<li><a href="#${id}">${title}</a></li>`).join('')}</ul></nav></header>
<main id="main" tabindex="-1">
<div id="announce" class="sr" aria-live="polite"></div>
<noscript><p class="warn">This page needs JavaScript. Without it use <code>omg factory dashboard --out dashboard.html --watch</code>.</p></noscript>
${o.allRepos ? '<section id="repos" aria-labelledby="h-repos"><h2 id="h-repos">Repositories</h2><p id="scope" class="muted" aria-live="polite"></p><div id="b-repos"></div></section>\n' : ''}<section aria-label="Summary"><div id="b-summary"></div></section>
<section id="attention" aria-labelledby="h-attention"><h2 id="h-attention">Attention</h2><div id="b-attention"></div></section>
<section id="live" aria-labelledby="h-live"><h2 id="h-live">Live now</h2><div id="b-live"></div></section>
<section id="runs" aria-labelledby="h-runs"><h2 id="h-runs">Runs</h2>
<div class="toolbar"><label for="f-text">Filter</label><input id="f-text" type="search" autocomplete="off" spellcheck="false">
<label for="f-phase">Phase</label><select id="f-phase"><option value="">all phases</option></select></div>
<p class="legend muted" aria-hidden="true">Timeline:<span class="e"></span>engine<span class="w"></span>waiting on you</p>
<div id="b-runs"></div></section>
${SECTIONS.slice(3).map(([id, title]) => `<section id="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2><div id="b-${id}"></div></section>`).join('\n')}
</main>
<script nonce="${nonce}">${CLIENT_JS}</script></body></html>
`;
}
