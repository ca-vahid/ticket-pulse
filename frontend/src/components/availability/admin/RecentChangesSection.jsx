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

// The words a field reads as inside a sentence ("changed Vacation: allow past dates off").
const FIELD = {
  name: 'name', icon: 'icon', color: 'colour', unit: 'booked in', allowHalfDays: 'half days', requiresApproval: 'needs approval',
  availability: 'shows as', visibility: 'colleagues see', requiresNote: 'note required', allowPastDated: 'allow past dates',
  tracksBalance: 'tracks a balance', balancePolicy: 'balance policy', vtLeaveTypeNames: 'Vacation Tracker names', sortOrder: 'sort order',
  isActive: 'active', enabled: 'used', province: 'province', timezone: 'time zone', yearStartMonth: 'leave year starts in month',
  outlookEventsEnabled: 'Outlook events', autoRepliesEnabled: 'automatic replies', vtWriteBackEnabled: 'copy to Vacation Tracker',
  purposeNotice: 'purpose notice', description: 'description', requireAll: 'every approver must approve', autoApproveTypeIds: 'approved automatically',
  officeId: 'office', startDate: 'start date', workdays: 'workdays', dailyHours: 'hours a day', entitlementOverrides: 'allowances',
  scopeType: 'applies to', scopeRef: 'who it applies to', leaveTypeIds: 'leave types', condition: 'condition', outcome: 'outcome',
  message: 'message', priority: 'priority', mode: 'mode', key: 'key',
};
// Values that are a whole structure read better as just their name.
const STRUCTURED = new Set(['balancePolicy', 'condition', 'entitlementOverrides', 'workdays', 'autoApproveTypeIds', 'leaveTypeIds', 'vtLeaveTypeNames']);
const VERB = { create: 'added', update: 'changed', delete: 'deleted', activate: 'brought back', deactivate: 'retired' };
const ENTITY = { leave_type: 'the leave type', office: 'the office', approval_group: 'the approval group', rule: 'the rule' };
const MAX_PARTS = 4;

function fmtValue(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v === null || v === undefined || v === '') return 'cleared';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'cleared';
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

const emailsOf = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.email)).filter(Boolean) : []);

/** "added B Person as a member", "removed C Person as an approver". */
function peopleChange(role, before, after) {
  const was = new Set(emailsOf(before));
  const now = new Set(emailsOf(after));
  const added = [...now].filter((e) => !was.has(e)).map(nameFromEmail);
  const removed = [...was].filter((e) => !now.has(e)).map(nameFromEmail);
  const parts = [];
  if (added.length) parts.push(`added ${added.join(', ')} as ${role}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')} as ${role}`);
  return parts;
}

/** What changed, field by field: ["allow past dates off", "time zone America/Edmonton"]. */
export function changeParts(c) {
  if (!c.after || c.action === 'create' || c.action === 'delete') return [];
  const parts = [];
  for (const k of Object.keys(c.after)) {
    const now = c.after[k];
    if (k === 'members') parts.push(...peopleChange('a member', c.before?.[k], now));
    else if (k === 'approvers') parts.push(...peopleChange('an approver', c.before?.[k], now));
    else if (STRUCTURED.has(k) || (now && typeof now === 'object' && !Array.isArray(now))) parts.push(FIELD[k] || k);
    else parts.push(`${FIELD[k] || k} ${fmtValue(now)}`);
  }
  return parts;
}

const withParts = (head, parts) => {
  if (!parts.length) return head;
  const shown = parts.slice(0, MAX_PARTS);
  const more = parts.length - shown.length;
  return `${head}: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/**
 * The change in words, without the person: "turned off Working from home for
 * Project Accounting", "changed Vacation: allow past dates off".
 */
export function describeChange(c) {
  const name = c.entityName || '';
  const ws = c.workspaceName || '';
  switch (c.entity) {
  case 'leave_type_workspace':
    return `turned ${c.action === 'enable' ? 'on' : 'off'} ${name || 'a leave type'}${ws ? ` for ${ws}` : ''}`;
  case 'calendar_import':
    return `set the shared calendar import${ws ? ` for ${ws}` : ''} to ${fmtValue(c.after?.mode)}`;
  case 'settings':
    if (c.action === 'retire_vacation_tracker') return 'retired Vacation Tracker';
    if (c.action === 'handover_again') return 'ran the Vacation Tracker handover again';
    return withParts('changed the general settings', changeParts(c));
  case 'person':
    return withParts(`changed ${name || 'a person'}`, changeParts(c));
  default: {
    const verb = VERB[c.action] || 'changed';
    // A change names the thing ("changed Vacation"); adding, deleting or retiring says what kind it is.
    if (verb === 'changed' && name) return withParts(`changed ${name}`, changeParts(c));
    return withParts(`${verb} ${ENTITY[c.entity] || c.entity}${name ? ` ${name}` : ''}`, verb === 'changed' ? changeParts(c) : []);
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
              {changes.map((c) => (
                <li key={c.id} className="py-2.5">
                  <p className="text-sm text-foreground/85">
                    {/* The person's name (the server looks it up from the agents), else their e-mail. */}
                    <span className="font-medium text-foreground">{c.actorName || c.actor}</span> {describeChange(c)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={c.createdAt}>{fmtWhen(c.createdAt)}</time>
                    {c.workspaceName && c.entity !== 'leave_type_workspace' && c.entity !== 'calendar_import' ? ` · ${c.workspaceName}` : ''}
                  </p>
                </li>
              ))}
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
