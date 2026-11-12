import { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';

/**
 * A small emoji picker for the composer (Nov 2026): the ones people actually
 * use in a helpdesk reply, no library. Picking one drops it at the caret.
 */

const EMOJI = [
  ['Smileys', ['🙂', '😀', '😄', '😊', '😉', '😅', '😂', '🙃', '😎', '🤔', '😬', '😕', '😢', '😮', '🙏', '👋']],
  ['Hands', ['👍', '👎', '👌', '👏', '🙌', '🤝', '✌️', '🤞', '💪', '👀']],
  ['Signs', ['✅', '❌', '⚠️', '❗', '❓', '⭐', '🔥', '🎉', '💡', '📌', '🔒', '🔑', '⏳', '🕐', '📎', '🔗']],
  ['Things', ['💻', '🖥️', '🖨️', '📱', '🔌', '🔋', '📧', '📞', '📅', '🧾', '💳', '🚚', '🛠️', '🔧', '❤️', '☕']],
];

export default function EmojiPicker({ onPick, disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Insert an emoji"
        title="Emoji"
        className="tp-focus-ring inline-flex items-center rounded-lg p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Smile className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label="Emoji" data-testid="emoji-picker" className="absolute bottom-full left-0 z-30 mb-1 w-72 max-w-[calc(100vw-2.5rem)] tp-card rounded-lg p-2 shadow-soft animate-popIn">
          {EMOJI.map(([group, list]) => (
            <div key={group} className="mb-1 last:mb-0">
              <p className="px-1 pb-0.5 text-[10px] font-medium text-muted-foreground">{group}</p>
              <div className="grid grid-cols-8 gap-0.5">
                {list.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => { onPick?.(ch); setOpen(false); }}
                    aria-label={ch}
                    className="tp-focus-ring flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted"
                  >
                    {ch}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
