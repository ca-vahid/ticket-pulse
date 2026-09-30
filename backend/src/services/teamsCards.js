/**
 * Adaptive Cards for Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md).
 *
 * House style "D2-a" (Vahid, 30 Sep 2026): a coloured banner holding the
 * linked subject, "#ref · 👤 requester" under it and, in a column on the
 * right, a big icon with one word for what happened (no row of its own).
 * Below: a framed facts panel (Category › Subcategory · ● Priority · Due),
 * the new text for this event, and the ticket description as formatted
 * text (first part, the rest behind "Show full description").
 * Containers use Teams styles (accent / emphasis / borders) so the card holds
 * up in dark mode. Buttons are Action.Execute (Universal Actions) so the bot
 * answers with the refreshed card in place. Schema 1.5.
 */

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

/** Event key → icon, the one word in the banner, the heading over the new text, banner style. */
export const EVENT_META = {
  assigned: { icon: '🎫', word: 'Assigned', heading: 'Assigned to you', banner: 'accent' },
  unassigned_from_me: { icon: '↪️', word: 'Reassigned', heading: 'Reassigned away from you', banner: 'accent' },
  requester_replied: { icon: '💬', word: 'Reply', heading: 'The requester replied', banner: 'accent' },
  teammate_update: { icon: '📝', word: 'Update', heading: 'New note or reply', banner: 'accent' },
  status_changed: { icon: '🔄', word: 'Status', heading: 'Status changed', banner: 'accent' },
  reopened: { icon: '↩️', word: 'Reopened', heading: 'Reopened', banner: 'warning' },
  park_woke: { icon: '⏰', word: 'Woke up', heading: 'Parked ticket woke up', banner: 'accent' },
  sla_pre_breach: { icon: '⏳', word: 'Due soon', heading: 'SLA about to breach', banner: 'warning' },
  sla_breach: { icon: '🔥', word: 'Overdue', heading: 'SLA breached', banner: 'attention' },
  approval_waiting: { icon: '✅', word: 'Approval', heading: 'Approval waiting for you', banner: 'accent' },
  group_unassigned: { icon: '🆕', word: 'New', heading: 'New unassigned ticket', banner: 'accent' },
  test: { icon: '👋', word: 'Test', heading: 'Test message', banner: 'accent' },
};

const PRIORITY = { 1: ['Low', 'Default'], 2: ['Medium', 'Good'], 3: ['High', 'Warning'], 4: ['Urgent', 'Attention'] };

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Adaptive Card markdown treats [ ] ( ) * _ as syntax; a subject may contain them.
const mdSafe = (s) => String(s || '').replace(/([[\]()*_`])/g, '\\$1');

/** HTML (ticket description, reply body) → Adaptive Card markdown: bold, italics, links, lists, paragraphs. */
export function htmlToCardMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|tr|blockquote)>/gi, '\n\n').replace(/<(p|div|h[1-6]|blockquote)[^>]*>/gi, '');
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    let n = 0;
    return `\n${inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_x, li) => `${++n}. ${li.trim()}\n`)}\n`;
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '').replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `**${x.trim()}**` : ''));
  s = s.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `_${x.trim()}_` : ''));
  s = s.replace(/<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, x) => `[${x.replace(/<[^>]+>/g, '').trim() || href}](${href})`);
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
  // Pasted bullet glyphs at a line start become list items; other single line breaks become paragraphs.
  s = s.split('\n').map((l) => l.replace(/^[•·▪◦‣§]\s+/, '- ')).join('\n');
  s = s.replace(/([^\n])\n(?!- |\d+\. |\n)/g, '$1\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** Plain text (a reply or note typed without HTML) → the same markdown, escaping nothing but keeping paragraphs. */
export function textToCardMarkdown(text) {
  return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/([^\n])\n(?!\n)/g, '$1\n\n').trim();
}

/** First part (≈ limit chars, cut on a paragraph) + the rest. */
export function splitLong(md, limit = 900) {
  if (!md || md.length <= limit) return [md || '', ''];
  const cut = md.lastIndexOf('\n', limit);
  const at = cut > limit * 0.5 ? cut : limit;
  return [md.slice(0, at).trim(), md.slice(at).trim()];
}

const text = (t, extra = {}) => ({ type: 'TextBlock', text: t, wrap: true, ...extra });
const label = (t) => text(t, { size: 'Small', isSubtle: true, weight: 'Bolder', wrap: false });

/** The banner: linked title + sub-line on the left, big icon + one word on the right. */
// The title is plain bold text in the theme's own colour (a markdown link is
// Teams' fixed link blue, unreadable on the dark-mode banner); the whole
// banner is the link instead, and "↗" says so.
function banner({ style = 'accent', title, url, subline, icon, word }) {
  return {
    type: 'Container',
    style,
    bleed: true,
    ...(url ? { selectAction: { type: 'Action.OpenUrl', url, title: 'Open' } } : {}),
    items: [{
      type: 'ColumnSet',
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            text(`${title}${url ? '  ↗' : ''}`, { size: 'Large', weight: 'Bolder' }),
            ...(subline ? [text(subline, { size: 'Small', spacing: 'Small' })] : []),
          ],
        },
        {
          type: 'Column',
          width: 'auto',
          verticalContentAlignment: 'Center',
          items: [
            text(icon, { size: 'ExtraLarge', horizontalAlignment: 'Center', spacing: 'None', wrap: false }),
            text(word, { size: 'Small', weight: 'Bolder', horizontalAlignment: 'Center', spacing: 'None', wrap: false }),
          ],
        },
      ],
    }],
  };
}

/** Framed facts panel: Category › Subcategory | ● Priority | Due. */
function factsPanel(t) {
  const [pw, pc] = PRIORITY[t.priority] || [t.priorityLabel || '—', 'Default'];
  const cat = t.categoryTop ? `🗂️ ${mdSafe(t.categoryTop)}${t.categorySub ? ` › **${mdSafe(t.categorySub)}**` : ''}` : '🗂️ Not categorised yet';
  return {
    type: 'Container',
    showBorder: true,
    roundedCorners: true,
    spacing: 'Medium',
    items: [{
      type: 'ColumnSet',
      columns: [
        { type: 'Column', width: 'stretch', items: [label('CATEGORY'), text(cat, { spacing: 'None' })] },
        { type: 'Column', width: 'auto', items: [label('PRIORITY'), text(`● ${pw}`, { color: pc, weight: 'Bolder', spacing: 'None', wrap: false })] },
        { type: 'Column', width: 'auto', items: [label('DUE'), text(t.dueLabel || '—', { spacing: 'None', wrap: false, color: t.overdue ? 'Attention' : 'Default' })] },
      ],
    }],
  };
}

/** Long markdown: the first part always, the rest behind a toggle. */
function longText(id, md, { heading = null, framed = false, toggleTitle = 'Show full description', startHidden = false } = {}) {
  const [head, rest] = splitLong(md);
  if (!head) return [];
  const blocks = [
    ...(heading ? [label(heading)] : []),
    text(head, { spacing: heading ? 'Small' : 'Medium' }),
    ...(rest ? [
      text(rest, { id: `${id}-more`, isVisible: false, spacing: 'Small' }),
      { type: 'ActionSet', spacing: 'Small', actions: [{ type: 'Action.ToggleVisibility', title: 'Show more', targetElements: [`${id}-more`] }] },
    ] : []),
  ];
  if (startHidden) {
    // Collapsed entirely: one link reveals it (used for the ticket description on update cards).
    return [
      { type: 'ActionSet', spacing: 'Medium', actions: [{ type: 'Action.ToggleVisibility', title: toggleTitle, targetElements: [`${id}-all`] }] },
      { type: 'Container', id: `${id}-all`, isVisible: false, items: [text([head, rest].filter(Boolean).join('\n\n'), { spacing: 'Small' })] },
    ];
  }
  return framed ? [{ type: 'Container', style: 'emphasis', showBorder: true, roundedCorners: true, spacing: 'Medium', items: blocks }] : blocks;
}

const inputCard = (id, placeholder, verb, title, data) => ({
  type: 'Action.ShowCard',
  title,
  card: {
    type: 'AdaptiveCard',
    body: [{ type: 'Input.Text', id, placeholder, isMultiline: true, isRequired: true, errorMessage: 'Write something first' }],
    actions: [{ type: 'Action.Execute', title: verb === 'reply' ? 'Send reply' : 'Add note', verb, data, style: 'positive' }],
  },
});

const wrapCard = (body, actions) => ({ type: 'AdaptiveCard', $schema: SCHEMA, version: '1.5', body, actions, msteams: { width: 'Full' } });

/**
 * The ticket card.
 * t: { id, workspaceId, ref, subject, url, canWrite, isUnassigned, categoryTop, categorySub, priority, priorityLabel,
 *      dueLabel, overdue, requesterName, requesterPlace, descriptionMd }
 * lines: [{ eventKey, text (markdown), who }] — newest first; the first sets the banner.
 * outcome: { icon, word, heading, detail } — after a button press.
 */
export function ticketCard(t, lines = [], { outcome = null, actionsOff = false } = {}) {
  const first = lines[0] || { eventKey: 'assigned' };
  const meta = EVENT_META[first.eventKey] || EVENT_META.assigned;
  const data = { ticketId: t.id, workspaceId: t.workspaceId };
  const who = t.requesterName ? `👤 ${t.requesterName}${t.requesterPlace ? ` · ${t.requesterPlace}` : ''}` : null;
  const body = [
    banner({
      style: outcome ? 'emphasis' : meta.banner,
      title: t.subject || 'Ticket',
      url: t.url,
      subline: [t.ref, who].filter(Boolean).join(' · '),
      icon: outcome?.icon || meta.icon,
      word: outcome?.word || (lines.length > 1 ? `${lines.length} updates` : meta.word),
    }),
    factsPanel(t),
  ];

  if (outcome) {
    body.push(text(`**${outcome.heading}**${outcome.detail ? ` — ${outcome.detail}` : ''}`, { spacing: 'Medium' }));
  } else {
    // What happened: for an assignment the description is the news; for anything else the new text is.
    const updates = lines.filter((l) => !['assigned', 'group_unassigned'].includes(l.eventKey) && l.text);
    updates.slice(0, 4).forEach((l, i) => {
      const m = EVENT_META[l.eventKey] || EVENT_META.teammate_update;
      body.push(...longText(`u${i}`, l.text, { heading: `${m.icon} ${(l.who ? `${l.who} — ` : '') + m.heading}`.toUpperCase(), framed: true }));
    });
    const newsIsDescription = updates.length === 0;
    body.push(...longText('d', t.descriptionMd, newsIsDescription ? {} : { startHidden: true, toggleTitle: 'Show ticket description' }));
  }

  const actions = [];
  if (!actionsOff && !outcome) {
    if (t.isUnassigned) actions.push({ type: 'Action.Execute', title: '✋ Take it', verb: 'take', data, style: 'positive' });
    actions.push({ type: 'Action.OpenUrl', title: 'Open ticket', url: t.url });
    if (t.canWrite) {
      actions.push(inputCard('noteText', 'Internal note — never e-mailed', 'note', 'Add note', data));
      actions.push(inputCard('replyText', 'Reply to the requester', 'reply', 'Reply', data));
    }
    actions.push({ type: 'Action.Execute', title: '💤 Snooze 4 hours', verb: 'snooze', data, mode: 'secondary' });
    actions.push({ type: 'Action.Execute', title: '🔕 Mute this ticket', verb: 'mute', data, mode: 'secondary' });
  } else {
    actions.push({ type: 'Action.OpenUrl', title: 'Open ticket', url: t.url });
  }
  return wrapCard(body, actions);
}

/** Outcome presets for card actions. */
export const OUTCOMES = {
  taken: { icon: '✋', word: 'Yours', heading: 'Taken by you', detail: 'It is in your queue now.' },
  already: { icon: '👥', word: 'Taken', heading: 'Already assigned', detail: 'Someone took it before you.' },
  note: { icon: '📝', word: 'Noted', heading: 'Note added' },
  reply: { icon: '📤', word: 'Sent', heading: 'Reply sent' },
  snooze: { icon: '💤', word: 'Snoozed', heading: 'Snoozed for 4 hours', detail: 'You will hear about this ticket again after that.' },
  mute: { icon: '🔕', word: 'Muted', heading: 'Muted', detail: 'Unmute it in Ticket Pulse → Mail & alerts.' },
};

/**
 * Approval card for the named approver.
 * a: { approvalId, ticketId, workspaceId, categoryName, ref, subject, requesterName, askedByName, noteMd, decisionUrl, tierLabel }
 * stage: 'ask' | { confirm: 'approved'|'rejected' } | { done: 'approved'|'rejected'|'closed', detail }
 */
export function approvalCard(a, stage = 'ask', { error = null } = {}) {
  const data = { approvalId: a.approvalId, ticketId: a.ticketId, workspaceId: a.workspaceId, decisionUrl: a.decisionUrl };
  let icon = '✅';
  let word = 'Approval';
  let style = 'accent';
  if (stage?.done) {
    icon = stage.done === 'approved' ? '👍' : stage.done === 'rejected' ? '⛔' : 'ℹ️';
    word = stage.done === 'approved' ? 'Approved' : stage.done === 'rejected' ? 'Declined' : 'Closed';
    style = 'emphasis';
  } else if (stage?.confirm) {
    icon = stage.confirm === 'approved' ? '👍' : '⛔';
    word = 'Confirm';
    style = stage.confirm === 'approved' ? 'good' : 'attention';
  }
  const body = [
    banner({
      style,
      title: a.categoryName || a.subject || 'Approval',
      url: a.decisionUrl,
      subline: [a.ref, a.categoryName && a.subject ? clip(a.subject, 80) : null].filter(Boolean).join(' · '),
      icon,
      word,
    }),
    {
      type: 'Container',
      showBorder: true,
      roundedCorners: true,
      spacing: 'Medium',
      items: [{
        type: 'ColumnSet',
        columns: [
          { type: 'Column', width: 'stretch', items: [label('FOR'), text(`👤 ${a.requesterName || '—'}`, { spacing: 'None' })] },
          { type: 'Column', width: 'stretch', items: [label('ASKED BY'), text(a.askedByName || '—', { spacing: 'None' })] },
          ...(a.tierLabel ? [{ type: 'Column', width: 'auto', items: [label('TIER'), text(a.tierLabel, { spacing: 'None', wrap: false })] }] : []),
        ],
      }],
    },
  ];
  if (error) body.push(text(`⚠️ ${error}`, { color: 'Attention', spacing: 'Medium' }));

  const actions = [];
  if (stage?.done) {
    body.push(text(`**${stage.done === 'approved' ? 'You approved this' : stage.done === 'rejected' ? 'You did not approve this' : 'Already decided'}**${stage.detail ? ` — ${stage.detail}` : ''}`, { spacing: 'Medium' }));
    actions.push({ type: 'Action.OpenUrl', title: 'Open the approval', url: a.decisionUrl });
  } else {
    if (a.noteMd) body.push(...longText('n', a.noteMd, { heading: `WHY ${String(a.askedByName || 'THE AGENT').split(' ')[0].toUpperCase()} IS ASKING`, framed: true }));
    if (stage?.confirm) {
      const rejecting = stage.confirm === 'rejected';
      body.push({
        type: 'Input.Text',
        id: 'decisionNote',
        label: rejecting ? 'Reason (required — the agents read it)' : 'Note (optional)',
        isMultiline: true,
        isRequired: rejecting,
        errorMessage: 'Add a reason for not approving',
        spacing: 'Medium',
      });
      actions.push({ type: 'Action.Execute', title: rejecting ? 'Yes, do not approve' : 'Yes, approve', verb: 'approval.confirm', data: { ...data, decision: stage.confirm }, style: rejecting ? 'destructive' : 'positive' });
      actions.push({ type: 'Action.Execute', title: 'Go back', verb: 'approval.back', data, associatedInputs: 'none' });
    } else {
      actions.push({ type: 'Action.Execute', title: '👍 Approve', verb: 'approval.prepare', data: { ...data, decision: 'approved' }, style: 'positive' });
      actions.push({ type: 'Action.Execute', title: '⛔ Decline', verb: 'approval.prepare', data: { ...data, decision: 'rejected' } });
      actions.push({ type: 'Action.OpenUrl', title: '❓ Ask a question', url: `${a.decisionUrl}${a.decisionUrl.includes('?') ? '&' : '?'}intent=ask` });
      actions.push({ type: 'Action.OpenUrl', title: 'Open the approval', url: a.decisionUrl, mode: 'secondary' });
    }
  }
  return wrapCard(body, actions);
}

/** Daily digest. rows: [{ ref, subject, dueLabel, overdue, priority, url }]; counts: { open, overdue, dueToday } */
export function digestCard({ name, counts, rows, queueUrl, held = [] }) {
  const tile = (n, what, color = 'Default') => ({
    type: 'Column',
    width: 'stretch',
    items: [text(String(n), { size: 'ExtraLarge', weight: 'Bolder', color, spacing: 'None', wrap: false }), label(what)],
  });
  const body = [
    banner({ title: `Your tickets today${name ? `, ${name.split(' ')[0]}` : ''}`, url: queueUrl, subline: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), icon: '☀️', word: 'Digest' }),
    {
      type: 'Container',
      showBorder: true,
      roundedCorners: true,
      spacing: 'Medium',
      items: [{ type: 'ColumnSet', columns: [tile(counts.open, 'OPEN'), tile(counts.overdue, 'OVERDUE', counts.overdue ? 'Attention' : 'Default'), tile(counts.dueToday, 'DUE TODAY', counts.dueToday ? 'Warning' : 'Default')] }],
    },
  ];
  for (const r of rows.slice(0, 10)) {
    const [, pc] = PRIORITY[r.priority] || ['', 'Default'];
    body.push({
      type: 'ColumnSet',
      spacing: 'Small',
      selectAction: { type: 'Action.OpenUrl', url: r.url },
      columns: [
        { type: 'Column', width: 'auto', items: [text('●', { color: pc, spacing: 'None', wrap: false })] },
        { type: 'Column', width: 'stretch', items: [text(`**${mdSafe(clip(r.subject, 70))}**  ${r.ref}`, { spacing: 'None', wrap: false })] },
        { type: 'Column', width: 'auto', items: [text(r.overdue ? `🔥 ${r.dueLabel}` : r.dueLabel || '', { size: 'Small', spacing: 'None', wrap: false, color: r.overdue ? 'Attention' : 'Default' })] },
      ],
    });
  }
  if (rows.length > 10) body.push(text(`…and ${rows.length - 10} more`, { size: 'Small', isSubtle: true, spacing: 'Small' }));
  if (held.length) {
    const lines = held.slice(0, 8).map((h) => `- ${EVENT_META[h.eventKey]?.icon || '•'} ${EVENT_META[h.eventKey]?.heading || 'Update'} — ${clip(h.summary, 110)}`).join('\n');
    body.push({ type: 'Container', style: 'emphasis', showBorder: true, roundedCorners: true, spacing: 'Medium', items: [label('HELD FOR THIS DIGEST'), text(lines, { spacing: 'Small' })] });
  }
  return wrapCard(body, [{ type: 'Action.OpenUrl', title: 'Open my tickets', url: queueUrl }]);
}

/** Welcome / help / test cards in the same banner style. */
export function textCard(title, lines = [], actions = [], { icon = '👋', word = 'Ticket Pulse' } = {}) {
  return wrapCard([
    banner({ title, icon, word }),
    ...lines.map((l, i) => text(l, { spacing: i === 0 ? 'Medium' : 'Small' })),
  ], actions);
}

export default { EVENT_META, OUTCOMES, ticketCard, approvalCard, digestCard, textCard, htmlToCardMarkdown, textToCardMarkdown, splitLong };
