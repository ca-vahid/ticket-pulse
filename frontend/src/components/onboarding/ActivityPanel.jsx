import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { hrLifecycleAPI } from '../../services/api';
import { EmptyState, Loading } from '../knowledge/knowledgeUi';
import { StatusDot } from './onboardingUi';
import { DECISION_LABEL, EVENT_MODE, OUTCOME, fmtDate, fmtWhen } from './onboardingFormat';

/** What an observed notice would have built — the go-live rehearsal view. */
function PlanDetail({ plan, techById }) {
  if (!plan) return null;
  const who = (id) => (id ? techById.get(Number(id))?.name || `Technician ${id}` : 'AI routing');
  if (Array.isArray(plan.children) && plan.children.length) {
    return (
      <div className="mt-2 text-xs">
        <p className="text-muted-foreground">
          Parent: assign {plan.parent?.assigneeTechId ? who(plan.parent.assigneeTechId) : 'unchanged'}
          {plan.parent?.dueDate ? `, due ${fmtDate(plan.parent.dueDate, { withYear: true })}` : ''}
        </p>
        <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
          {plan.children.map((c) => (
            <li key={c.key} className="text-foreground/85">
              {c.title} <span className="text-muted-foreground">— {who(c.assigneeTechId)}{c.dueDate ? `, due ${fmtDate(c.dueDate)}` : ''}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const list = plan.moves?.length ? plan.moves : plan.closes;
  if (Array.isArray(list) && list.length) {
    return (
      <ul className="mt-2 text-xs text-foreground/85">
        {list.map((x) => (
          <li key={x.ticketId}>{x.ref} <span className="text-muted-foreground">({x.role}){x.dueDate ? ` → due ${fmtDate(x.dueDate)}` : ' → close'}</span></li>
        ))}
      </ul>
    );
  }
  return null;
}

export default function ActivityPanel({ techById = new Map() }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    hrLifecycleAPI.events({ limit: 200 })
      .then((res) => { if (!cancelled) setRows(Array.isArray(res?.data) ? res.data : []); })
      .catch((err) => { if (!cancelled) { setRows([]); setError(err?.message || 'Could not load activity'); } });
    return () => { cancelled = true; };
  }, []);

  if (rows === null) return <Loading label="Loading activity…" />;
  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!rows.length ? (
        <EmptyState icon={History} title="No notices handled yet">
          Every HR notice the section reads lands here with its decision — in observe mode, with the family it would have built.
        </EmptyState>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-subtle">
          {rows.map((e) => {
            const mode = EVENT_MODE[e.mode] || EVENT_MODE.live;
            const outcome = OUTCOME[e.outcome] || { tone: 'grey', label: e.outcome };
            const plan = e.details?.plan || null;
            const warnings = e.details?.warnings || [];
            const expandable = Boolean(plan?.children?.length || plan?.moves?.length || plan?.closes?.length || warnings.length);
            const open = openId === e.id;
            return (
              <li key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">{fmtWhen(e.createdAt)}</span>
                  <span className="text-sm font-medium text-foreground">{DECISION_LABEL[e.decision] || e.decision}</span>
                  {e.person && <span className="text-sm text-foreground/85">{e.person}</span>}
                  <span className="ml-auto flex items-center gap-3">
                    <StatusDot tone={mode.tone} label={mode.label} />
                    <StatusDot tone={outcome.tone} label={outcome.label} />
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground sm:pl-[7.75rem]">
                  {e.summary}
                  {e.ticketId && (
                    <Link to={`/tickets/${e.ticketId}`} className="tp-focus-ring ml-2 rounded text-primary hover:underline">Open notice</Link>
                  )}
                  {expandable && (
                    <button type="button" onClick={() => setOpenId(open ? null : e.id)} aria-expanded={open} className="tp-focus-ring ml-2 rounded text-primary hover:underline">
                      {open ? 'Hide details' : 'Details'}
                    </button>
                  )}
                </p>
                {open && (
                  <div className="sm:pl-[7.75rem]">
                    <PlanDetail plan={plan} techById={techById} />
                    {warnings.length > 0 && (
                      <ul className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                        {warnings.map((w) => <li key={w}>{w}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
