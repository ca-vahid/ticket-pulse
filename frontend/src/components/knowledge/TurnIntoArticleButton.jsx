import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, FilePlus2 } from 'lucide-react';
import { knowledgeAPI, knowledgeGrowthAPI } from '../../services/api';

// One settings read per page load answers "may this person manage Knowledge?".
let capabilityPromise = null;
function canManageKnowledge() {
  if (!capabilityPromise) {
    capabilityPromise = knowledgeAPI.getSettings()
      .then((res) => res?.data?.canManage === true)
      .catch(() => { capabilityPromise = null; return false; });
  }
  return capabilityPromise;
}

/**
 * "Turn into an article" (Auto-help P1): on a ticket with a verified
 * solution, a Knowledge manager gets a draft article pre-filled from it —
 * the verified solution and the public replies, never internal notes, with
 * names, e-mail addresses and phone numbers removed — and lands in the
 * article editor. Clicking again reopens that draft instead of making
 * another. Renders nothing for people who cannot manage Knowledge.
 */
export default function TurnIntoArticleButton({ ticketId, className = '' }) {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    canManageKnowledge().then((ok) => { if (!cancelled) setAllowed(ok); });
    return () => { cancelled = true; };
  }, []);

  if (!allowed) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.draftFromTicket(ticketId);
      const id = res?.data?.article?.id;
      if (id) navigate(`/knowledge/articles/${id}`, { state: { afterDraft: { reused: res?.data?.reused === true } } });
    } catch (err) {
      setError(err?.message || 'Could not draft the article');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Draft a Knowledge article from this ticket's verified solution (you check it before it is published)"
        className={`tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60 ${className}`}
        data-testid="turn-into-article"
      >
        {busy ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />}
        {busy ? 'Drafting…' : 'Turn into an article'}
      </button>
      {error && <span className="text-xs text-red-700 dark:text-red-300" role="alert">{error}</span>}
    </span>
  );
}
