import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import TicketSearchBox from '../tickets/TicketSearchBox';

// The all-in-one search in the app header (16 Sep 2026) — Vahid wanted it on
// every page, not only above the queue. Same box as before; here the results
// navigate instead of peeking, and "apply as filter" lands on the Tickets list
// (keeping the other filters when you are already there).
export default function HeaderSearch({ className = '' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const onQueue = /^\/tickets\/?$/.test(location.pathname);
  const urlQ = onQueue ? (new URLSearchParams(location.search).get('q') || '') : '';
  const [value, setValue] = useState(urlQ);
  // The queue's own URL wins whenever it changes (a chip removed, a view picked).
  useEffect(() => { setValue(urlQ); }, [urlQ]);

  const applyQuery = (q) => {
    const text = String(q || '').trim();
    if (onQueue) {
      const next = new URLSearchParams(location.search);
      if (text) next.set('q', text); else next.delete('q');
      next.delete('page');
      navigate(`/tickets?${next.toString()}`, { replace: true });
    } else if (text) {
      navigate(`/tickets?q=${encodeURIComponent(text)}`);
    }
  };
  const openTicket = (id, { newTab } = {}) => {
    const path = `/tickets/${id}`;
    if (newTab) window.open(path, '_blank', 'noopener');
    else navigate(path);
  };

  return (
    <TicketSearchBox
      className={className}
      size="sm"
      value={value}
      onChange={setValue}
      onApply={applyQuery}
      onOpenTicket={openTicket}
      onOpenRequester={(r) => navigate(`/requesters/${r.id}`, { state: { from: `${location.pathname}${location.search}` } })}
      onOpenAgent={(a) => navigate(`/technician/${a.id}`)}
      onOpenTask={(task) => { if (task?.ticket?.id) navigate(`/tickets/${task.ticket.id}?tab=tasks`); }}
      onFilterDepartment={(name) => applyQuery(name)}
    />
  );
}
