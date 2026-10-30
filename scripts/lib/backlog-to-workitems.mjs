/**
 * Turn a BACKLOG.md in the ExcavatorTrek shape into Azure DevOps work item
 * fields for the live acceptance run (scripts/ado-acceptance.mjs, ADO parity
 * design §6 `create`). Pure: no I/O.
 *
 * The shape:
 *
 *   ## EXC-001 Fuel gauge
 *
 *   Depends on: EXC-007 (the `KeyValueStore` in `src/storage.ts`).
 *
 *   - [ ] One acceptance criterion per checkbox; indented lines continue it.
 *
 * A ticket ends at the next `#`/`##` heading or a `---` rule. Every ticket key
 * named on the `Depends on:` line is a dependency ("none" names none).
 */

const TICKET = /^##\s+([A-Z][A-Z0-9]*-\d+)\s+(.+?)\s*$/;
const SECTION_END = /^(#{1,2}\s|---\s*$)/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const DEPENDS = /^Depends on:\s*(.*)$/i;
const KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/**
 * @typedef {{ key: string, title: string, dependsOn: string[], dependsText: string, description: string[], acceptance: { text: string, done: boolean }[] }} BacklogTicket
 */

/** @returns {BacklogTicket[]} in file order; throws on a duplicate key or a ticket without acceptance criteria. */
export function parseBacklog(markdown) {
  const tickets = [];
  let current = null;
  let paragraph = [];
  const flush = () => {
    if (current && paragraph.length) current.description.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const raw of markdown.replace(/^﻿/, '').split(/\r?\n/)) {
    const heading = TICKET.exec(raw);
    if (heading || SECTION_END.test(raw)) {
      flush();
      current = null;
      if (heading) {
        current = { key: heading[1], title: heading[2], dependsOn: [], dependsText: '', description: [], acceptance: [] };
        tickets.push(current);
      }
      continue;
    }
    if (!current) continue;
    const box = CHECKBOX.exec(raw);
    if (box) {
      flush();
      current.acceptance.push({ text: box[2].trim(), done: box[1] !== ' ' });
      continue;
    }
    if (raw.trim() === '') {
      flush();
      continue;
    }
    const last = current.acceptance.at(-1);
    if (/^\s+\S/.test(raw) && last && paragraph.length === 0) {
      last.text = `${last.text} ${raw.trim()}`;
      continue;
    }
    const depends = DEPENDS.exec(raw.trim());
    if (depends && paragraph.length === 0) {
      current.dependsText = depends[1].trim();
      current.dependsOn = [...new Set(depends[1].match(KEY) ?? [])].filter((k) => k !== current.key);
      continue;
    }
    paragraph.push(raw.trim());
  }
  flush();
  const seen = new Set();
  for (const t of tickets) {
    if (seen.has(t.key)) throw new Error(`BACKLOG.md: ticket ${t.key} appears twice`);
    seen.add(t.key);
    if (t.acceptance.length === 0) throw new Error(`BACKLOG.md: ticket ${t.key} has no checkbox acceptance criteria`);
  }
  return tickets;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escaped text with `code` spans as <code>; nothing else is interpreted. */
export function inlineHtml(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : escapeHtml(part)))
    .join('');
}

/**
 * The fields `az boards work-item create` gets for one ticket: the title
 * (`<key> <title>`), the description and the acceptance criteria as HTML
 * (`Microsoft.VSTS.Common.AcceptanceCriteria` is a User Story field of the
 * Agile process), and the dependencies by key.
 */
export function ticketToWorkItem(ticket) {
  const depends = ticket.dependsText ? [`<p>Depends on: ${inlineHtml(ticket.dependsText)}</p>`] : [];
  return {
    key: ticket.key,
    title: `${ticket.key} ${ticket.title}`,
    descriptionHtml: [...depends, ...ticket.description.map((p) => `<p>${inlineHtml(p)}</p>`)].join('') || `<p>${inlineHtml(ticket.title)}</p>`,
    acceptanceHtml: `<ul>${ticket.acceptance.map((a) => `<li>${inlineHtml(a.text)}</li>`).join('')}</ul>`,
    dependsOn: ticket.dependsOn,
  };
}

/** Work items for every ticket; a dependency on a key the backlog lacks is reported, not invented. */
export function backlogToWorkItems(markdown) {
  const tickets = parseBacklog(markdown);
  const keys = new Set(tickets.map((t) => t.key));
  const unknown = tickets.flatMap((t) => t.dependsOn.filter((d) => !keys.has(d)).map((d) => `${t.key} depends on ${d}, which BACKLOG.md does not define`));
  return { items: tickets.map(ticketToWorkItem), unknown };
}
