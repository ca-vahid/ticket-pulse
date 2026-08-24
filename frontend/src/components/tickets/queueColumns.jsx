import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Columns3, CornerUpRight, GripVertical, RotateCcw, Sparkles } from 'lucide-react';
import AssigneePicker from './AssigneePicker';
import StatusPicker from './StatusPicker';
import {
  AgentFirstName, PersonAvatar, SlaChip, StatusPill, UnassignedBadge,
  ticketCategoryLabels, ticketSourceLabel, timeAgo,
} from './ticketUi';
import { baseStatusOf, statusToneFromDefs } from './statusDefs';
import { ticketsAPI } from '../../services/api';

/**
 * Queue column registry (Mega 08-23 Phase QC) — the single source of truth for
 * the tickets-list columns: labels, defaults, sortability, xl grid tracks and
 * the cell renderers (lifted from Tickets.jsx's old inline cell consts).
 *
 * Scope contract (QC3): user-chosen columns apply at xl+ ONLY. Below xl the
 * queue keeps its fixed "essentials" projection (subject + category/assignee/
 * status/due — the old md templates, hardcoded in Tickets.jsx) and the mobile
 * cards are untouched. Board mode has no columns, so the customizer hides.
 *
 * Renderer contract: render(ticket, ctx) returns the FULL cell element. ctx is
 * built once per row by Tickets.jsx and carries:
 *   cell(key)        base className: CELL + responsive visibility + xl placement
 *   cellStyle(key)   style carrying the computed `--tp-q-col` track index
 *   cellPad, roomy   layout bits
 *   technicians, statusDefs, groupNames, slaCalendarAware   workspace meta
 *   canReview, canSeeAi                                     role bits
 *   fx, aiLive, aiProgress, isEditable, fsRowEditable,
 *   removedLike, resolvedLike, ticketHref, linkState        row bits
 *   refreshAfterEdit, showToast, setAiTicket, fsAssign,
 *   fsStatusChange, onManualAssigned, onOpenFull            handlers
 */

// No vertical grid lines (modern list feel) — horizontal row dividers only.
// px-2 below xl: the tablet band's narrower tracks need the padding back as
// content width (px-3 alone truncated "Open" → "Op…" in the status column).
export const CELL = 'px-2 xl:px-3 self-stretch flex items-center min-w-0';

// Row anchors (QA 08-07 #7): plain left-click keeps the in-app peek/navigate
// behavior, but any modified click (Ctrl/Cmd new tab, Shift new window, Alt
// download, middle-click) must fall through to NATIVE anchor semantics — do
// not preventDefault those. Right-click needs no handler at all: real <a href>
// gives the context menu its "Open in new tab" for free.
export const isModifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1;

/**
 * "Handled in FreshService" marker: the assignment was made in FS, not by our
 * AI. Either the AI auto-assigned someone and a human reassigned it in FS
 * (kind='reassigned'), or the ticket was already taken in FS before the AI run
 * could act (kind='handled_in_fs'). The row shows the real current assignee;
 * this amber chip flags the FS handoff and links to the assignment-history
 * detail.
 */
export function BypassBadge({ bypass }) {
  let title;
  if (bypass.kind === 'reassigned') {
    const bits = [];
    if (bypass.aiTechName) bits.push(`AI assigned ${bypass.aiTechName}`);
    if (bypass.byActorName) bits.push(`reassigned by ${bypass.byActorName}`);
    title = `Handled in FreshService — ${bits.join('; ') || 'reassigned in FreshService'}. Click for assignment history.`;
  } else {
    const who = bypass.byActorName
      ? (bypass.selfPicked ? `self-assigned by ${bypass.byActorName}` : `assigned by ${bypass.byActorName}`)
      : 'assigned in FreshService';
    const aiNote = bypass.aiTechName ? ` (AI would have picked ${bypass.aiTechName})` : '';
    title = `Handled in FreshService — ${who} before AI could act${aiNote}. Click for assignment history.`;
  }
  return (
    <Link
      to={`/assignments/history/${bypass.runId}`}
      onClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className="tp-focus-ring flex-shrink-0 inline-flex items-center h-5 w-5 rounded-md bg-amber-50 border border-amber-200 text-amber-600 hover:bg-amber-100 transition-colors"
    >
      <CornerUpRight className="w-3 h-3 m-auto" aria-hidden="true" />
    </Link>
  );
}

// Live pipeline progress → human stage label for the "AI choosing…" chip.
// Tool names arrive over SSE per analysis turn; buckets are coarse on purpose
// (the run is agentic, so exact step totals don't exist ahead of time).
const AI_STAGE_LABELS = [
  [/submit_recommendation/, 'making the call'],
  [/find_matching_agents|competenc/, 'matching skills'],
  [/availability|workload|history|risk_signals|routing|site_context|ad_profile/, 'weighing the team'],
  [/similar|search/, 'checking similar tickets'],
  [/ticket_details|categories|requester|thread|conversation/, 'reading the ticket'],
];
function aiProgressLabel(progress) {
  if (!progress?.step) return null;
  const stage = AI_STAGE_LABELS.find(([re]) => re.test(progress.tool || ''))?.[1] || 'analyzing';
  return `${stage} · step ${progress.step}`;
}

// ------------------------------------------------------------ cell renderers

// Requester (QA 08-07 #6): name on the primary line, Entra office/city as the
// quiet second line when present — mirrors the category cell's shape.
function renderRequester(ticket, ctx) {
  const office = ticket.requester?.entraOfficeLocation || ticket.requester?.entraCity || null;
  return (
    <span
      className={`${ctx.cell('requester')} ${ctx.cellPad} flex-col !items-start justify-center gap-0.5`}
      style={ctx.cellStyle('requester')}
      title={[ticket.requester?.name, office].filter(Boolean).join(' · ') || undefined}
    >
      <span className="block w-full text-xs font-medium text-slate-700 truncate">
        {ticket.requester?.name || 'Unknown requester'}
      </span>
      {office && (
        <span className="block w-full text-[10px] text-slate-400 truncate">{office}</span>
      )}
    </span>
  );
}

// Category, leaf-first: the SUBCATEGORY is the most specific (= most useful)
// piece, so it gets the primary line; parent under it.
function renderCategory(ticket, ctx) {
  const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
  return (
    <span
      className={`${ctx.cell('category')} ${ctx.cellPad} flex-col !items-start justify-center gap-0.5`}
      style={ctx.cellStyle('category')}
      title={[catLabel, subLabel].filter(Boolean).join(' / ') || undefined}
    >
      {subLabel ? (
        <>
          <span className="block w-full text-xs font-medium text-slate-700 truncate">{subLabel}</span>
          {catLabel && <span className="block w-full text-[10px] text-slate-400 truncate">in {catLabel}</span>}
        </>
      ) : (
        <span className="block w-full text-xs text-slate-600 truncate">{catLabel || '—'}</span>
      )}
    </span>
  );
}

function renderAssignee(ticket, ctx) {
  const {
    aiLive, canReview, canSeeAi, fx, isEditable, fsRowEditable, resolvedLike, technicians,
  } = ctx;
  // Shared body of the dashed "Suggested · NN%" capsule — rendered as a BUTTON
  // for reviewers (opens the AI modal) and as a read-only SPAN for everyone
  // else (QA 08-19 #2 read/act split).
  const suggestedPct = typeof ticket.ai?.score === 'number' ? Math.round(ticket.ai.score * 100) : null;
  const suggestedChipBody = ticket.ai?.state === 'suggested' ? (
    <>
      <span className="relative flex-shrink-0">
        <PersonAvatar name={ticket.ai.techName} photoUrl={technicians.find((t) => t.id === ticket.ai.techId)?.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-violet-600 ring-2 ring-white inline-flex items-center justify-center" aria-hidden="true">
          <Sparkles className="w-[7px] h-[7px] text-white" />
        </span>
      </span>
      <span className="flex flex-col min-w-0 flex-1 leading-tight">
        <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">
          Suggested{suggestedPct !== null ? ` · ${suggestedPct}%` : ''}
        </span>
        {ticket.ai.techName
          ? <AgentFirstName name={ticket.ai.techName} className="text-xs font-semibold text-slate-800" />
          : <span className="truncate text-xs font-semibold text-slate-800">AI pick</span>}
      </span>
      {ticket.ai.count > 1 && (
        <span className="text-[9px] font-medium text-violet-400 flex-shrink-0">+{ticket.ai.count - 1}</span>
      )}
    </>
  ) : null;
  const viewerSuggestedTitle = `AI suggests ${ticket.ai?.techName || 'a technician'}${suggestedPct !== null ? ` — ${suggestedPct}% match` : ''} — waiting on a reviewer's approval`;
  // Viewer/agent + unassigned + pending suggestion: show the same capsule
  // reviewers get, read-only. (The decision belongs to a reviewer; manual
  // assignment stays available in the peek drawer / detail / mobile sheet.)
  const viewerSuggested = canSeeAi && !canReview
    && !ticket.assignedTechId && ticket.ai?.state === 'suggested';

  if (isEditable || fsRowEditable) {
    return (
      <span
        className={`${ctx.cell('assignee')} py-1 gap-1 relative ${fx === 'aiDone' ? 'tp-assign-pop' : ''}`}
        style={ctx.cellStyle('assignee')}
      >
        {viewerSuggested ? (
          /* Read-only Suggested capsule (span, not button): non-reviewers see
             the pick but can't approve/dismiss — those endpoints would 403. */
          <span
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={viewerSuggestedTitle}
            className="flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full border border-dashed border-violet-300 bg-violet-50/60"
          >
            {suggestedChipBody}
          </span>
        ) : (
          <AssigneePicker
            ticketId={ticket.id}
            value={ticket.assignedTechId}
            currentTech={ticket.assignedTech}
            technicians={technicians}
            ticketOrigin={ticket.origin}
            assignFn={fsRowEditable ? ((techId) => ctx.fsAssign(ticket, techId)) : undefined}
            onAssigned={(techId) => ctx.onManualAssigned(ticket.id, techId)}
            size="sm"
            align="right"
            showAi={canReview}
            aiSuggestion={canReview ? (ticket.ai || (aiLive ? { state: 'analyzing' } : null)) : null}
            onAiAssign={canReview ? () => ctx.setAiTicket(ticket) : null}
          />
        )}
        {/* Provenance badge AFTER the picker so avatars/names align vertically
            across rows (QA 08-03). */}
        {ticket.aiBypass && <BypassBadge bypass={ticket.aiBypass} />}
      </span>
    );
  }
  return (
    <span
      className={`${ctx.cell('assignee')} py-1 gap-1.5 relative ${fx === 'aiDone' ? 'tp-assign-pop' : ''}`}
      style={ctx.cellStyle('assignee')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {aiLive && !ticket.assignedTech ? (
        canReview ? (
          <button
            onClick={() => ctx.setAiTicket(ticket)}
            title="AI is choosing the best person for this ticket — click to watch live. A manual assignment overrides the pick; category & priority detection still finish."
            className="tp-focus-ring tp-ai-think flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full text-left"
          >
            <span className="h-6 w-6 rounded-full bg-violet-100 inline-flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3 h-3 text-violet-600 tp-ai-twinkle" aria-hidden="true" />
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">AI choosing…</span>
              <span className="text-xs italic text-slate-400 truncate">{aiProgressLabel(ctx.aiProgress) || 'best person for this'}</span>
            </span>
          </button>
        ) : (
          <span
            title="AI is choosing the best person for this ticket"
            className="tp-ai-think flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full"
          >
            <span className="h-6 w-6 rounded-full bg-violet-100 inline-flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3 h-3 text-violet-600 tp-ai-twinkle" aria-hidden="true" />
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">AI choosing…</span>
              <span className="text-xs italic text-slate-400 truncate">{aiProgressLabel(ctx.aiProgress) || 'best person for this'}</span>
            </span>
          </span>
        )
      ) : canSeeAi && ticket.ai?.state === 'suggested' && !ticket.assignedTech ? (
        canReview ? (
          <button
            onClick={() => ctx.setAiTicket(ticket)}
            title={`AI suggests ${ticket.ai.techName || 'a technician'}${suggestedPct !== null ? ` — ${suggestedPct}% match` : ''}${ticket.ai.count > 1 ? ` (+${ticket.ai.count - 1} more candidate${ticket.ai.count - 1 === 1 ? '' : 's'})` : ''} · awaiting your approval`}
            className="tp-focus-ring group flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full border border-dashed border-violet-300 bg-violet-50/60 hover:bg-violet-50 transition-colors text-left"
          >
            {suggestedChipBody}
          </button>
        ) : (
          <span
            title={viewerSuggestedTitle}
            className="flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full border border-dashed border-violet-300 bg-violet-50/60"
          >
            {suggestedChipBody}
          </span>
        )
      ) : (
        <>
          <span className="flex items-center gap-2 min-w-0 flex-1" title="Synced from FreshService — read-only here">
            {ticket.assignedTech ? (
              <>
                <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} />
                <AgentFirstName name={ticket.assignedTech.name} className="text-xs text-slate-600" />
              </>
            ) : (
              <UnassignedBadge variant="muted" />
            )}
          </span>
          {!canSeeAi ? null : ticket.ai?.state === 'suggested' ? (
            canReview ? (
              <button
                onClick={() => ctx.setAiTicket(ticket)}
                title={ticket.assignedTech
                  ? `Already assigned to ${ticket.assignedTech.name} — AI suggested ${ticket.ai.techName || 'someone'} (informational)`
                  : `AI suggests ${ticket.ai.techName || 'a technician'} — review`}
                aria-label={ticket.assignedTech ? 'AI suggestion (already assigned)' : 'Review AI suggestion'}
                className={`tp-focus-ring p-1 rounded-md flex-shrink-0 ${
                  ticket.assignedTech
                    ? 'text-slate-300 hover:text-slate-500 hover:bg-slate-50'
                    : 'text-indigo-500 hover:bg-indigo-50'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            ) : (
              /* Non-reviewers: informational sparkle only — no modal, no API. */
              <span
                title={ticket.assignedTech
                  ? `Already assigned to ${ticket.assignedTech.name} — AI suggested ${ticket.ai.techName || 'someone'} (informational)`
                  : viewerSuggestedTitle}
                aria-label="AI suggestion — waiting on a reviewer's approval"
                className={`p-1 rounded-md flex-shrink-0 ${ticket.assignedTech ? 'text-slate-300' : 'text-indigo-400'}`}
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              </span>
            )
          ) : ticket.ai?.state === 'queued' ? (
            canReview ? (
              <button
                onClick={() => ctx.setAiTicket(ticket)}
                title="AI run queued for business hours"
                aria-label="AI run queued"
                className="tp-focus-ring p-1 rounded-md text-indigo-400 hover:bg-indigo-50 flex-shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            ) : (
              <span
                title="AI run queued for business hours"
                aria-label="AI run queued"
                className="p-1 rounded-md text-indigo-300 flex-shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              </span>
            )
          ) : ticket.ai?.state === 'analyzing' ? null : canReview && !ticket.assignedTech && !resolvedLike ? (
            <button
              onClick={() => ctx.setAiTicket(ticket)}
              title="Ask AI to assign"
              aria-label="Ask AI to assign"
              className="tp-focus-ring p-1 rounded-md text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 flex-shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </>
      )}
    </span>
  );
}

function renderStatus(ticket, ctx) {
  const { isEditable, fsRowEditable, removedLike, statusDefs } = ctx;
  return (
    <span className={`${ctx.cell('status')} py-1`} style={ctx.cellStyle('status')}>
      {(isEditable || fsRowEditable) && !removedLike ? (
        <StatusPicker
          ticketId={ticket.id}
          value={ticket.status}
          statusDefs={statusDefs}
          fsChange={fsRowEditable ? ((next) => ctx.fsStatusChange(ticket, next)) : null}
          onChanged={(next, prev) => {
            ctx.refreshAfterEdit();
            ctx.showToast(`${ticket.displayRef} → ${next}`, isEditable ? (async () => {
              try { await ticketsAPI.setStatus(ticket.id, prev); ctx.refreshAfterEdit(); } catch { /* refresh shows truth */ }
            }) : null);
          }}
        />
      ) : (
        <StatusPill status={ticket.status} size="sm" tone={statusToneFromDefs(statusDefs, ticket.status)} />
      )}
    </span>
  );
}

function renderDue(ticket, ctx) {
  const { removedLike, resolvedLike, statusDefs } = ctx;
  return (
    <span className={`${ctx.cell('due')} ${ctx.cellPad}`} style={ctx.cellStyle('due')}>
      {removedLike
        ? <span className="text-xs text-slate-300">—</span>
        : resolvedLike
          ? <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
          : ticket.dueBy
            ? <SlaChip value={ticket.dueBy} paused={baseStatusOf(statusDefs, ticket.status) === 'Pending'} calendarAware={ctx.slaCalendarAware} className="!px-1.5 !text-[10px]" />
            : <span className="text-xs text-slate-300">—</span>}
    </span>
  );
}

function renderLastActivity(ticket, ctx) {
  return (
    <span
      className={`${ctx.cell('lastActivity')} ${ctx.cellPad} justify-end relative`}
      style={ctx.cellStyle('lastActivity')}
      title={ticket.lastActivityAt ? new Date(ticket.lastActivityAt).toLocaleString() : ''}
    >
      <span className="text-xs text-slate-400 whitespace-nowrap transition-opacity group-hover:opacity-0">
        {timeAgo(ticket.lastActivityAt || ticket.updatedAt)}
      </span>
      <Link
        to={ctx.ticketHref}
        state={ctx.linkState}
        onClick={(e) => { e.stopPropagation(); if (isModifiedClick(e)) return; e.preventDefault(); ctx.onOpenFull(ticket.id); }}
        title="Open full ticket"
        aria-label={`Open ${ticket.displayRef}`}
        className="tp-focus-ring absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50"
      >
        <ChevronRight className="w-4 h-4" aria-hidden="true" />
      </Link>
    </span>
  );
}

// Created date (Phase QC): absolute · relative, same recipe as Updated —
// short date on the primary line, quiet "3d ago" beneath, full timestamp on
// hover.
function renderCreatedAt(ticket, ctx) {
  const d = ticket.createdAt ? new Date(ticket.createdAt) : null;
  const dateLabel = d
    ? d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  return (
    <span
      className={`${ctx.cell('createdAt')} ${ctx.cellPad} flex-col !items-start justify-center gap-0.5`}
      style={ctx.cellStyle('createdAt')}
      title={d ? d.toLocaleString() : undefined}
    >
      {dateLabel ? (
        <>
          <span className="block w-full text-xs text-slate-600 truncate">{dateLabel}</span>
          <span className="block w-full text-[10px] text-slate-400 truncate">{timeAgo(ticket.createdAt)}</span>
        </>
      ) : (
        <span className="text-xs text-slate-300">—</span>
      )}
    </span>
  );
}

function renderSource(ticket, ctx) {
  const label = ticketSourceLabel(ticket.source);
  return (
    <span className={`${ctx.cell('source')} ${ctx.cellPad}`} style={ctx.cellStyle('source')} title={label || undefined}>
      {label
        ? <span className="text-xs text-slate-600 truncate">{label}</span>
        : <span className="text-xs text-slate-300">—</span>}
    </span>
  );
}

// Department: the ticket's own field first, then the requester's Entra/FS
// profile as a fallback (the ticket column is sparse on FS-born rows). NOTE:
// sort=department orders by the ticket column only — fallback-labeled rows
// sort with the blanks (see ticketService).
function renderDepartment(ticket, ctx) {
  const dept = ticket.department || ticket.requester?.entraDepartment || ticket.requester?.department || null;
  return (
    <span className={`${ctx.cell('department')} ${ctx.cellPad}`} style={ctx.cellStyle('department')} title={dept || undefined}>
      {dept
        ? <span className="text-xs text-slate-600 truncate">{dept}</span>
        : <span className="text-xs text-slate-300">—</span>}
    </span>
  );
}

function renderGroup(ticket, ctx) {
  const name = (ticket.groupId && ctx.groupNames.get(String(ticket.groupId)))
    || ticket.internalGroup?.name || null;
  return (
    <span className={`${ctx.cell('group')} ${ctx.cellPad}`} style={ctx.cellStyle('group')} title={name || undefined}>
      {name
        ? <span className="text-xs text-indigo-600 font-medium truncate">{name}</span>
        : <span className="text-xs text-slate-300">—</span>}
    </span>
  );
}

// ---------------------------------------------------------------- registry

/**
 * Column registry. Fields:
 *   key/label      identity + header/flyout text
 *   mandatory      cannot be hidden (subject pinned first; requester per QA 08-21 #2)
 *   defaultOn      today's visible set — an untouched user sees ZERO change
 *   sortField      backend sort key wired to the header button (null = unsortable)
 *   headerTitle    tooltip on the sort button
 *   headerClass    extra header alignment classes
 *   track          xl grid track (defaultWidth); minPx = resize floor (Phase QR)
 *   mdEssential    part of the fixed below-xl projection (renders at md even
 *                  when deselected; deselection only applies at xl+)
 *   render         cell renderer — subject is layout-owned in Tickets.jsx
 *                  (compact cell vs roomy full-width row 1), so it has none.
 */
export const QUEUE_COLUMNS = [
  { key: 'subject', label: 'Subject', mandatory: true, defaultOn: true, sortField: 'subject', track: 'minmax(0,2.4fr)', minPx: 240, mdEssential: true, render: null },
  { key: 'requester', label: 'Requester', mandatory: true, defaultOn: true, sortField: 'requester', headerTitle: 'Sort by requester name', track: '150px', minPx: 110, render: renderRequester },
  { key: 'category', label: 'Category', defaultOn: true, sortField: null, track: 'minmax(150px,1fr)', minPx: 120, mdEssential: true, render: renderCategory },
  { key: 'assignee', label: 'Assignee', defaultOn: true, sortField: null, track: '210px', minPx: 150, mdEssential: true, render: renderAssignee },
  { key: 'status', label: 'Status', defaultOn: true, sortField: 'status', headerTitle: 'Sort by status (Open first)', track: '116px', minPx: 90, mdEssential: true, render: renderStatus },
  { key: 'due', label: 'Due', defaultOn: true, sortField: 'dueBy', headerTitle: 'Sort by due date (soonest first)', track: '88px', minPx: 70, mdEssential: true, render: renderDue },
  { key: 'lastActivity', label: 'Updated', defaultOn: true, sortField: 'updatedAt', track: '74px', minPx: 60, headerClass: 'justify-end', render: renderLastActivity },
  { key: 'createdAt', label: 'Created', defaultOn: false, sortField: 'createdAt', headerTitle: 'Sort by created date', track: '96px', minPx: 80, render: renderCreatedAt },
  { key: 'source', label: 'Source', defaultOn: false, sortField: 'source', track: '96px', minPx: 70, render: renderSource },
  { key: 'department', label: 'Department', defaultOn: false, sortField: 'department', headerTitle: 'Sort by department (blanks last)', track: '130px', minPx: 100, render: renderDepartment },
  { key: 'group', label: 'Group', defaultOn: false, sortField: null, track: '120px', minPx: 90, render: renderGroup },
];

export const QUEUE_COLUMN_MAP = new Map(QUEUE_COLUMNS.map((c) => [c.key, c]));
export const DEFAULT_COLUMN_KEYS = QUEUE_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);

/**
 * Normalize a stored/foreign column list into a safe ordered key list:
 * unknown keys + dupes dropped, subject pinned first, requester (mandatory)
 * inserted up front when missing, null/garbage → today's defaults.
 */
export function normalizeColumnKeys(value) {
  if (!Array.isArray(value)) return [...DEFAULT_COLUMN_KEYS];
  const seen = new Set();
  const rest = [];
  for (const raw of value) {
    const k = String(raw);
    if (k === 'subject' || !QUEUE_COLUMN_MAP.has(k) || seen.has(k)) continue;
    seen.add(k);
    rest.push(k);
  }
  if (!rest.includes('requester')) rest.unshift('requester');
  return ['subject', ...rest];
}

/**
 * One computed gridTemplateColumns for header + rows (QC3): accent track,
 * subject (compact) / the roomy 60px type slot, then the chosen non-subject
 * columns in user order. Applied at xl+ via the `--tp-q-grid` variable; the
 * below-xl templates stay hardcoded in Tickets.jsx (fixed essentials).
 */
export function buildQueueGridTemplate(columnKeys, { roomy = false } = {}) {
  const tracks = columnKeys
    .filter((k) => k !== 'subject' && QUEUE_COLUMN_MAP.has(k))
    .map((k) => QUEUE_COLUMN_MAP.get(k).track);
  return [
    '6px',
    roomy ? '60px' : QUEUE_COLUMN_MAP.get('subject').track,
    ...tracks,
  ].join(' ');
}

// ------------------------------------------------------------ columns menu

/**
 * Toolbar "Columns" flyout (QC4): checkbox list in display order with
 * drag-to-reorder (the filter rail's grip pattern), mandatory rows locked as
 * "Always shown", Reset-to-default footer. Same shell as FilterFlyout.
 * Hidden in board mode (the board has status columns, not these).
 */
export function QueueColumnsMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [dragKey, setDragKey] = useState(null);
  // Display order while the menu is open: current visible order, then the
  // remaining registry columns — kept locally so a hidden column holds its
  // spot while the user rearranges (the stored value is visible-only).
  const [order, setOrder] = useState([]);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setOrder([
      ...value.filter((k) => QUEUE_COLUMN_MAP.has(k)),
      ...QUEUE_COLUMNS.map((c) => c.key).filter((k) => !value.includes(k)),
    ]);
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const visibleSet = new Set(value);
  const customized = value.join(',') !== DEFAULT_COLUMN_KEYS.join(',');
  const emit = (nextOrder, nextVisible) => onChange(nextOrder.filter((k) => nextVisible.has(k)));

  const toggle = (key) => {
    if (QUEUE_COLUMN_MAP.get(key)?.mandatory) return;
    const nextVisible = new Set(visibleSet);
    if (nextVisible.has(key)) nextVisible.delete(key); else nextVisible.add(key);
    emit(order, nextVisible);
  };
  const dropOn = (targetKey) => {
    if (!dragKey || dragKey === targetKey || targetKey === 'subject') return;
    const next = order.filter((k) => k !== dragKey);
    next.splice(next.indexOf(targetKey), 0, dragKey);
    setOrder(next);
    emit(next, visibleSet);
  };
  const reset = () => {
    setOrder([
      ...DEFAULT_COLUMN_KEYS,
      ...QUEUE_COLUMNS.map((c) => c.key).filter((k) => !DEFAULT_COLUMN_KEYS.includes(k)),
    ]);
    onChange([...DEFAULT_COLUMN_KEYS]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Choose and reorder the list's columns (applies on large screens)"
        className={`tp-focus-ring relative inline-flex items-center gap-1.5 text-sm rounded-lg px-2.5 min-h-[44px] py-2 border transition-colors ${
          customized ? 'bg-blue-50 text-blue-700 border-blue-200 font-medium' : 'bg-white text-slate-700 border-input hover:border-blue-300'
        }`}
      >
        <Columns3 className={`w-4 h-4 ${customized ? 'text-blue-500' : 'text-slate-400'}`} aria-hidden="true" />
        Columns
        <ChevronDown className={`w-3.5 h-3.5 ${customized ? 'text-blue-500' : 'text-slate-400'}`} aria-hidden="true" />
        {customized && <span aria-hidden="true" className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-500" />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Customize columns"
          className="absolute top-full mt-1 z-30 right-0 w-64 tp-card rounded-lg shadow-soft p-2 animate-scaleIn"
        >
          <p className="px-2 pb-1.5 text-[11px] text-slate-400 border-b border-slate-100">
            Drag to reorder · applies on large screens (smaller screens keep the essentials)
          </p>
          <ul className="max-h-72 overflow-y-auto settings-scrollbar -mx-0.5 mt-1">
            {order.map((key) => {
              const col = QUEUE_COLUMN_MAP.get(key);
              if (!col) return null;
              const dragging = dragKey === key;
              const pinned = key === 'subject';
              return (
                <li
                  key={key}
                  onDragOver={(e) => { if (dragKey && dragKey !== key && !pinned) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); dropOn(key); }}
                  className={`transition-opacity ${dragging ? 'opacity-40' : dragKey && !pinned ? 'hover:bg-blue-50/40' : ''}`}
                >
                  <label className="flex items-center gap-2 px-1.5 py-1.5 rounded-md hover:bg-blue-50 cursor-pointer text-sm text-slate-700">
                    <span
                      draggable={!pinned}
                      onDragStart={(e) => { if (pinned) return; setDragKey(key); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => setDragKey(null)}
                      title={pinned ? undefined : 'Drag to reorder'}
                      aria-label={pinned ? undefined : `Reorder ${col.label} column`}
                      className={pinned ? 'w-3.5 flex-shrink-0' : 'cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 flex-shrink-0'}
                    >
                      {!pinned && <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />}
                    </span>
                    <input
                      type="checkbox"
                      checked={visibleSet.has(key)}
                      disabled={Boolean(col.mandatory)}
                      onChange={() => toggle(key)}
                      aria-label={`${col.label} column`}
                      className="tp-focus-ring rounded border-slate-300 text-blue-600 disabled:opacity-50"
                    />
                    <span className="truncate flex-1">{col.label}</span>
                    {col.mandatory && <span className="text-[10px] text-slate-400 flex-shrink-0">Always shown</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            onClick={reset}
            disabled={!customized}
            className="tp-focus-ring mt-1.5 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded-md border-t border-slate-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}
