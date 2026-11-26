import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { availabilityAPI } from '../../../services/api';
import { BTN_QUIET, ErrorNote, Loading, SectionTitle, nameFromEmail } from '../availabilityUi';

/**
 * Vacation Pulse → Settings → Recent changes (26 Nov 2026): who changed which
 * setting, when, and what changed, in plain words. Newest first, 50 a page.
 * Super admins see every change; a workspace admin the changes to their
 * workspaces and the company-wide ones (the server decides).
 */

const FIELD = {
  name: 'Name', icon: 'Icon', color: 'Colour', unit: 'Booked in', allowHalfDays: 'Half days', requiresApproval: 'Needs approval',
  availability: 'Shows as', visibility: 'Colleagues see', requiresNote: 'Note required', allowPastDated: 'Booked after the fact',
  tracksBalance: 'Tracks a balance', balancePolicy: 'Balance policy', vtLeaveTypeNames: 'Vacation Tracker names', sortOrder: 'Sort order',
  isActive: 'Active', enabled: 'Used', province: 'Province', timezone: 'Time zone', yearStartMonth: 'Leave year starts in',
  outlookEventsEnabled: 'Outlook events', autoRepliesEnabled: 'Automatic replies', vtWriteBackEnabled: 'Write back to Vacation Tracker',
  purposeNotice: 'Notice', description: 'Description', requireAll: 'Every approver must approve', autoApproveTypeIds: 'Approved automatically',
  officeId: 'Office', startDate: 'Start date', workdays: 'Workdays', dailyHours: 'Hours a day', entitlementOverrides: 'Allowances',
  scopeType: 'Applies to', scopeRef: 'Who it applies to', leaveTypeIds: 'Leave types', condition: 'Condition', outcome: 'Outcome',
  message: 'Message', priority: 'Priority', mode: 'Mode', members: 'Members', approvers: 'Approvers', key: 'Key',
};
// Values that are a whole structure read better as "changed" than as JSON.
const STRUCTURED = new Set(['balancePolicy', 'condition', 'entitlementOverrides', 'workdays', 'autoApproveTypeIds', 'leaveTypeIds', 'vtLeaveTypeNames']);

const VERB = {
  create: 'Added', update: 'Changed', delete: 'Deleted', activate: 'Brought back', deactivate: 'Retired',
};
const ENTITY = { leave_type: 'the leave type', office: 'the office', approval_group: 'the approval group', rule: 'the rule' };

function fmtValue(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v === null || v === undefined || v === '') return 'none';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'object') return 'changed';
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

const emailsOf = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.email)).filter(Boolean) : []);

/** "Members: added b@…; removed c@…" for a list of people. */
function listChange(label, before, after) {
  const was = new Set(emailsOf(before));
  const now = new Set(emailsOf(after));
  const added = [...now].filter((e) => !was.has(e));
  const removed = [...was].filter((e) => !now.has(e));
  const parts = [];
  if (added.length) parts.push(`added ${added.map(nameFromEmail).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map(nameFromEmail).join(', ')}`);
  return parts.length ? `${label}: ${parts.join('; ')}` : `${label} changed`;
}

/** The changed fields, one short line each (at most six). */
export function changeDetails(c) {
  if (!c.after || c.action === 'create' || c.action === 'delete') return [];
  if (c.entity === 'leave_type_workspace' || c.entity === 'calendar_import') return [];
  if (c.entity === 'settings' && c.entityId === 'vacation_tracker') return [];
  const lines = [];
  for (const k of Object.keys(c.after)) {
    const label = FIELD[k] || k;
    const was = c.before ? c.before[k] : undefined;
    const now = c.after[k];
    if (k === 'members' || k === 'approvers') lines.push(listChange(label, was, now));
    else if (STRUCTURED.has(k) || (now && typeof now === 'object' && !Array.isArray(now))) lines.push(`${label} changed`);
    else lines.push(`${label}: ${fmtValue(was)} → ${fmtValue(now)}`);
  }
  return lines.slice(0, 6);
}

/** What happened, in plain words, without the person ("switched Site visit off for Team Five"). */
export function changeHeadline(c) {
  const name = c.entityName ? `“${c.entityName}”` : '';
  const ws = c.workspaceName || (c.workspaceId ? `workspace ${c.workspaceId}` : '');
  switch (c.entity) {
  case 'leave_type_workspace':
    return `switched ${name || 'a leave type'} ${c.action === 'enable' ? 'on' : 'off'} for ${ws}`;
  case 'calendar_import':
    return `set the shared calendar import for ${ws} to ${fmtValue(c.after?.mode)}`;
  case 'person':
    return `changed the Vacation Pulse settings of ${c.entityName || 'a person'}`;
  case 'settings':
    if (c.action === 'retire_vacation_tracker') return 'retired Vacation Tracker';
    if (c.action === 'handover_again') return 'ran the Vacation Tracker handover again';
    return 'changed the general settings';
  default: {
    const verb = (VERB[c.action] || 'Changed').toLowerCase();
    const what = ENTITY[c.entity] || c.entity;
    return `${verb} ${what}${name ? ` ${name}` : ''}`;
  }
  }
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function RecentChangesSection() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const res = await availabilityAPI.settingsChanges({ page: p });
      setData(res?.data || { changes: [], page: p, hasMore: false });
    } catch (err) {
      setError(err?.message || 'Could not load the recent changes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(page); }, [load, page]);

  const changes = data?.changes || [];
  return (
    <section aria-label="Recent changes">
      <SectionTitle hint="Who changed which Vacation Pulse setting, and when. Newest first.">Recent changes</SectionTitle>
      <ErrorNote>{error}</ErrorNote>
      {loading && !data ? <Loading label="Loading recent changes…" className="py-10" /> : (
        <>
          {changes.length === 0 && !error && <p className="py-6 text-sm text-muted-foreground">Nothing has been changed here yet.</p>}
          {changes.length > 0 && (
            <ol className="divide-y divide-border" data-testid="recent-changes">
              {changes.map((c) => {
                const details = changeDetails(c);
                return (
                  <li key={c.id} className="py-2.5">
                    <p className="text-sm text-foreground/85">
                      <span className="font-medium text-foreground">{c.actorName || nameFromEmail(c.actor)}</span> {changeHeadline(c)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <time dateTime={c.createdAt}>{fmtWhen(c.createdAt)}</time>
                      {c.workspaceName && c.entity !== 'leave_type_workspace' && c.entity !== 'calendar_import' ? ` · ${c.workspaceName}` : ''}
                    </p>
                    {details.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-foreground/85">
                        {details.map((d) => <li key={d}>{d}</li>)}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {(page > 1 || data?.hasMore) && (
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <button type="button" className={BTN_QUIET} disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />Newer
              </button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <button type="button" className={BTN_QUIET} disabled={!data?.hasMore || loading} onClick={() => setPage((p) => p + 1)}>
                Older<ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
