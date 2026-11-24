import { useEffect, useRef, useState } from 'react';
import { canThumb, loadThumb, peekThumb } from './thumbnails';

/**
 * First-page thumbnail for a non-image attachment in the Attachments tab's
 * grid (24 Nov 2026). Fetches only once the card scrolls near the viewport;
 * until then, and whenever a thumbnail can't be made, it shows `fallback`
 * (the type icon). Decorative: the card's file name names it.
 *
 * Documents sit on a white "paper" well (`.tp-light` re-pins the light
 * tokens) in both themes — user documents are never inverted.
 */
export default function AttachmentThumbnail({ ticketId, attachment, fallback = null }) {
  const eligible = canThumb(attachment);
  const [result, setResult] = useState(() => (eligible ? peekThumb(ticketId, attachment) : undefined));
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);
  const latest = useRef(attachment);
  latest.current = attachment;
  const id = attachment?.id;
  const done = Boolean(result);

  useEffect(() => {
    if (!eligible || done) return undefined;
    const cached = peekThumb(ticketId, latest.current);
    if (cached) { setResult(cached); return undefined; }
    const el = ref.current;
    // No observer (very old browser, or a test DOM): keep the icon, fetch nothing.
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const controller = new AbortController();
    let started = false;
    const observer = new IntersectionObserver((entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return;
      started = true;
      observer.disconnect();
      setLoading(true);
      loadThumb(ticketId, latest.current, { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) { setResult(res); setLoading(false); } })
        .catch(() => { if (!controller.signal.aborted) { setResult({ kind: 'none' }); setLoading(false); } });
    }, { rootMargin: '160px 0px' });
    observer.observe(el);
    return () => { observer.disconnect(); controller.abort(); };
  }, [ticketId, id, eligible, done]);

  const shown = result && result.kind !== 'none' ? result : null;
  return (
    <span
      ref={ref}
      className="relative flex h-full w-full items-center justify-center"
      data-testid="attachment-thumb"
      data-thumb={shown ? shown.kind : loading ? 'loading' : 'icon'}
    >
      {shown ? <ThumbBody result={shown} /> : fallback}
      {loading && !shown && <span className="tp-thumb-shimmer pointer-events-none absolute inset-0" aria-hidden="true" />}
    </span>
  );
}

function Paper({ children, fade = true, className = '' }) {
  return (
    <span aria-hidden="true" className={`tp-light absolute inset-0 overflow-hidden bg-card text-left text-card-foreground ${className}`}>
      {children}
      {fade && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />}
    </span>
  );
}

const COLS = ['A', 'B', 'C', 'D', 'E'];

function ThumbBody({ result: r }) {
  if (r.kind === 'pdf') {
    return (
      <Paper fade={false}>
        <img src={r.url} alt="" draggable={false} className="h-full w-full object-cover object-top" />
      </Paper>
    );
  }
  if (r.kind === 'docx') {
    // Sanitised in thumbnails.js (allow list, no attributes) before it was cached.
    return (
      <Paper>
        <span className="tp-thumb-doc block px-3 pt-2.5" data-testid="thumb-docx" dangerouslySetInnerHTML={{ __html: r.html }} />
      </Paper>
    );
  }
  if (r.kind === 'sheet') {
    return (
      <Paper>
        <table className="w-full table-fixed border-collapse text-[8px] leading-tight" data-testid="thumb-sheet">
          <thead>
            <tr className="bg-muted text-muted-foreground">
              {r.rows[0].map((_, i) => <th key={i} className="border border-border px-1 py-px text-center font-medium">{COLS[i]}</th>)}
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? 'font-semibold' : ''}>
                {row.map((cell, ci) => (
                  <td key={ci} className="overflow-hidden text-ellipsis whitespace-nowrap border border-border px-1 py-0.5">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Paper>
    );
  }
  if (r.kind === 'email') {
    return (
      <Paper>
        <span className="block px-3 pt-2.5 text-[8px] leading-[1.4]" data-testid="thumb-email">
          {r.subject && <span className="block truncate text-[9px] font-semibold text-foreground">{r.subject}</span>}
          {r.from && <span className="block truncate text-muted-foreground">{r.from}</span>}
          <span className="my-1 block border-t border-border" />
          <span className="block whitespace-pre-line text-foreground/85">{r.text}</span>
        </span>
      </Paper>
    );
  }
  return (
    <Paper>
      <pre className="m-0 whitespace-pre px-2.5 pt-2 font-mono text-[7px] leading-[1.45] text-foreground/85" data-testid="thumb-text">{r.text}</pre>
    </Paper>
  );
}
