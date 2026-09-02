import { PersonAvatar, PriorityDot, formatDay } from '../../components/tickets/ticketUi';
import { APPROVER_DOT, approverStatusLabel, isOpenForDecision, sortApprovers } from './approvalMeta';

function RailHeading({ children }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{children}</h3>;
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(' · ');
}

export default function ApprovalRail({ approval, ticket, approvers }) {
  const requester = ticket?.requester || {};
  const rows = sortApprovers(approvers);
  const open = isOpenForDecision(approval?.status);

  return (
    <aside aria-label="Request details" className="flex flex-col gap-5 px-5 py-5 min-[800px]:px-[22px]">
      <section aria-labelledby="rail-requested-for">
        <RailHeading><span id="rail-requested-for">Requested for</span></RailHeading>
        <div className="flex items-center gap-3">
          <PersonAvatar name={requester.name} photoUrl={requester.photoUrl} size="h-11 w-11" textSize="text-sm" />
          <div className="min-w-0">
            <p className="font-semibold text-foreground">{requester.name || 'Unknown requester'}</p>
            {joinMeta([requester.title, requester.location]) && (
              <p className="text-xs text-muted-foreground">{joinMeta([requester.title, requester.location])}</p>
            )}
            {requester.department && <p className="text-xs text-muted-foreground">{requester.department}</p>}
            {requester.email && (
              <a href={`mailto:${requester.email}`} className="tp-focus-ring block truncate rounded text-xs text-muted-foreground hover:text-primary hover:underline">
                {requester.email}
              </a>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="rail-requested-by">
        <RailHeading><span id="rail-requested-by">Requested by</span></RailHeading>
        <div className="flex items-center gap-3">
          <PersonAvatar name={approval?.requestedByName} photoUrl={approval?.requestedByPhotoUrl} size="h-8 w-8" textSize="text-xs" />
          <div className="min-w-0">
            <p className="font-semibold text-foreground">{approval?.requestedByName || approval?.requestedByEmail || 'Agent'}</p>
            <p className="text-xs text-muted-foreground">{ticket?.workspace?.name ? `${ticket.workspace.name} workspace` : 'Ticket Pulse'}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="rail-ticket">
        <RailHeading><span id="rail-ticket">Ticket</span></RailHeading>
        <dl className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 text-[13px]">
          <div>
            <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Priority</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-semibold text-foreground">
              <PriorityDot priority={ticket?.priority} title={`Priority: ${ticket?.priorityLabel || '—'}`} />
              <span>{ticket?.priorityLabel || '—'}</span>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Type</dt>
            <dd className="mt-0.5 font-semibold text-foreground">{ticket?.ticketType || '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Category</dt>
            <dd className="mt-0.5 font-semibold text-foreground">{ticket?.categoryPath || '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Status</dt>
            <dd className="mt-0.5 font-semibold text-foreground">{ticket?.status || '—'}</dd>
          </div>
        </dl>
      </section>

      {rows.length > 0 && (
        <section aria-labelledby="rail-approvers">
          <RailHeading><span id="rail-approvers">Approvers</span></RailHeading>
          <ul className="flex flex-col gap-2 text-[13px]">
            {rows.map((row, idx) => {
              const label = approverStatusLabel(row, approval?.supersededBy);
              return (
                <li key={`${row.name}-${idx}`} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${APPROVER_DOT[row.status] || APPROVER_DOT.pending}`} />
                    <span className="truncate text-foreground">
                      {row.isYou ? <><span className="font-semibold">You</span>{row.name ? <span className="text-muted-foreground"> · {row.name}</span> : null}</> : row.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {label}{row.decidedAt && row.status !== 'pending' ? ` · ${formatDay(row.decidedAt)}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="rail-next">
        <RailHeading><span id="rail-next">What happens next</span></RailHeading>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {open
            ? 'Approving lets the team act on the request; the requester and the agent are notified either way. You can ask a question first — the agent answers by email and this page updates.'
            : 'The requester and the agent have been notified. Nothing else is needed from you — you can close this page.'}
        </p>
      </section>
    </aside>
  );
}
