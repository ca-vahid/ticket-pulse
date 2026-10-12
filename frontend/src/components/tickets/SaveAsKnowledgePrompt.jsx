import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, X } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';

/**
 * "Save your answer as knowledge?" (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 8).
 * Shown only at the moment the person resolves the ticket in this page
 * (never on opening one that is already resolved), and only when the server
 * says it is worth asking: nothing in the Library covers it, the same kind of
 * request keeps coming, the agent wrote a real answer and has the skill. The
 * server also keeps the daily limit and remembers "Not now".
 *
 * Yes = one click: the draft is written in the background from the ticket's
 * replies and waits in the Knowledge inbox for a two-minute check.
 */
export default function SaveAsKnowledgePrompt({ ticketId, resolved }) {
  const was = useRef(resolved);
  const [ask, setAsk] = useState(null);
  const [state, setState] = useState('idle'); // idle | saving | saved | gone | error
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    // A different ticket starts clean.
    was.current = resolved;
    setAsk(null);
    setState('idle');
    setSaved(null);
  }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps -- only the ticket resets it

  useEffect(() => {
    const before = was.current;
    was.current = resolved;
    if (before !== false || resolved !== true || !ticketId) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => knowledgeAPI.ticketCapture(ticketId))
      .then((res) => { if (!cancelled && res?.data?.ask) setAsk(res.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [resolved, ticketId]);

  if (!ask || state === 'gone') return null;

  const answer = async (decision) => {
    if (decision === 'not_now') {
      setState('gone');
      knowledgeAPI.captureTicket(ticketId, { decision: 'not_now' }).catch(() => {});
      return;
    }
    setState('saving');
    try {
      const res = await knowledgeAPI.captureTicket(ticketId, { decision: 'yes' });
      setSaved(res?.data || null);
      setState('saved');
    } catch {
      setState('error');
    }
  };

  return (
    <section className="tp-card mb-4 rounded-xl border-primary/30 p-4" aria-label="Save your answer as knowledge" data-testid="save-as-knowledge">
      <div className="flex items-start gap-3">
        <BookOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {state === 'saved' ? (
            <p className="text-sm text-foreground" role="status">
              Drafted{saved?.article?.title ? <>: <span className="font-medium">{saved.article.title}</span></> : ''}. It waits in your{' '}
              <Link to="/knowledge/inbox" className="tp-focus-ring rounded font-medium text-primary hover:underline">Knowledge inbox</Link> for a quick check before it is published.
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">Save your answer as knowledge?</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{ask.reason}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button type="button" disabled={state === 'saving'} onClick={() => answer('yes')} className="tp-focus-ring h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {state === 'saving' ? 'Drafting…' : 'Save it'}
                </button>
                <button type="button" disabled={state === 'saving'} onClick={() => answer('not_now')} className="tp-focus-ring h-8 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Not now</button>
                <span className="text-xs text-muted-foreground">One click. A draft is written from your replies; you check it later.</span>
              </div>
              {state === 'error' && <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">The draft could not be written just now. You can try again from the ticket&rsquo;s Knowledge card.</p>}
            </>
          )}
        </div>
        {state !== 'saving' && (
          <button type="button" onClick={() => setState('gone')} aria-label="Close" className="tp-focus-ring inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}
