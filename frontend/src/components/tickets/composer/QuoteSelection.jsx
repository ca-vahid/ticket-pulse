import { useEffect, useState } from 'react';
import { TextQuote } from 'lucide-react';

/**
 * Select some text in the ticket's description or conversation and a small
 * "Quote in reply" button appears beside it (Nov 2026). Clicking it hands the
 * text to the host, which drops it into the composer as a quote.
 *
 * `scope`: CSS selector of the areas whose text may be quoted.
 */
export default function QuoteSelection({ scope, onQuote, enabled = true }) {
  const [at, setAt] = useState(null); // { top, left, text }

  useEffect(() => {
    if (!enabled) { setAt(null); return undefined; }
    const read = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setAt(null); return; }
      const text = sel.toString().trim();
      const anchor = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      const focus = sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement;
      if (!text || text.length < 3 || !anchor?.closest?.(scope) || !focus?.closest?.(scope)
        || anchor.closest('[contenteditable="true"], input, textarea')) { setAt(null); return; }
      let top = 0;
      let left = 0;
      try {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        top = Math.max(8, rect.top - 38);
        left = Math.max(8, Math.min(rect.left + rect.width / 2 - 70, window.innerWidth - 160));
      } catch { /* no layout (tests): the button sits at the top left */ }
      setAt({ top, left, text: text.slice(0, 4000) });
    };
    const onUp = () => setTimeout(read, 0);
    const onKey = (e) => { if (e.key === 'Escape') setAt(null); else if (e.shiftKey) onUp(); };
    const onScroll = () => setAt(null);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [scope, enabled]);

  if (!at) return null;
  return (
    <button
      type="button"
      data-testid="quote-selection"
      // mousedown, not click: the selection must survive until we have used it.
      onMouseDown={(e) => { e.preventDefault(); onQuote?.(at.text); window.getSelection?.()?.removeAllRanges(); setAt(null); }}
      style={{ top: at.top, left: at.left }}
      className="tp-focus-ring fixed z-[45] inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-soft hover:border-blue-300 hover:text-blue-700 dark:hover:border-blue-500/40 dark:hover:text-blue-200 print-hide"
    >
      <TextQuote className="h-3.5 w-3.5" aria-hidden="true" />Quote in reply
    </button>
  );
}
