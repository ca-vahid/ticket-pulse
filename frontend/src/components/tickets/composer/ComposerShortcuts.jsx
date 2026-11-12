import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Switch } from '../../ui/switch';

/**
 * The composer's keyboard list (Nov 2026). Opens with "?" on a ticket page or
 * from the keyboard button under the editor. The single-letter keys (R, N)
 * are a personal choice: the switch here turns them off for good, because a
 * stray key press should never be the only way to do anything.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

export const COMPOSER_KEYS = [
  { keys: ['R'], what: 'Reply to the requester', single: true },
  { keys: ['N'], what: 'Add an internal note', single: true },
  { keys: [MOD, 'Enter'], what: 'Send' },
  { keys: [MOD, 'Shift', 'Enter'], what: 'Send and set the status you used last' },
  { keys: [MOD, 'Shift', 'F'], what: 'Write beside the thread (bigger editor), and back' },
  { keys: ['Esc'], what: 'Leave the bigger editor' },
  { keys: [MOD, 'K'], what: 'Search and commands' },
  { keys: ['?'], what: 'This list', single: true },
];

export function Keys({ keys }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium text-foreground/85">{k}</kbd>
      ))}
    </span>
  );
}

export default function ComposerShortcuts({
  open, onClose, singleKeys, onSingleKeysChange, newEditor = false, onNewEditorChange = null,
  completion = false, onCompletionChange = null, onForgetPhrases = null, phraseCount = 0,
  ai = true, onAiChange = null,
}) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current?.(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="composer-shortcuts">
      <div className="absolute inset-0 bg-slate-950/45" aria-hidden="true" onClick={onClose} />
      <div className="tp-card relative w-full max-w-md rounded-xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Keyboard and editor</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <ul className="divide-y divide-border">
          {COMPOSER_KEYS.map((row) => (
            <li key={row.what} className={`flex items-center justify-between gap-4 py-2 text-sm ${row.single && !singleKeys ? 'text-muted-foreground/60' : 'text-foreground/85'}`}>
              <span>{row.what}{row.single && !singleKeys && <span className="ml-1.5 text-xs">(off)</span>}</span>
              <Keys keys={row.keys} />
            </li>
          ))}
        </ul>
        <label className="mt-4 flex items-start justify-between gap-4 border-t border-border pt-3">
          <span>
            <span className="block text-sm font-medium text-foreground">Single-letter keys</span>
            <span className="block text-xs text-muted-foreground">R, N and ? work when you are not typing in a box. Remembered for you.</span>
          </span>
          <Switch checked={Boolean(singleKeys)} onCheckedChange={(v) => onSingleKeysChange?.(Boolean(v))} aria-label="Single-letter keys" />
        </label>
        {onNewEditorChange && (
          <label className="mt-3 flex items-start justify-between gap-4 border-t border-border pt-3">
            <span>
              <span className="block text-sm font-medium text-foreground">New editor <span className="text-xs font-normal text-muted-foreground">Early access</span></span>
              <span className="block text-xs text-muted-foreground">
                For replies and internal notes. Type <strong>/</strong> for templates and quick notes, use Markdown as you type (<strong>**bold**</strong>, <strong>-</strong> lists, <strong>&gt;</strong> quote, <strong>```</strong> code), and undo properly. Switch it off to go back to the classic editor. Remembered for you.
              </span>
            </span>
            <Switch checked={Boolean(newEditor)} onCheckedChange={(v) => onNewEditorChange(Boolean(v))} aria-label="New editor" />
          </label>
        )}
        {onCompletionChange && (
          <div className={`mt-3 border-t border-border pt-3 ${newEditor ? '' : 'opacity-60'}`}>
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-foreground">Complete as I type <span className="text-xs font-normal text-muted-foreground">New editor only</span></span>
                <span className="block text-xs text-muted-foreground">
                  Offers the rest of a sentence in grey, from the workspace templates and from what you have sent before. No AI. <Keys keys={['Tab']} /> takes it, <Keys keys={[MOD, '→']} /> one word, <Keys keys={['Esc']} /> waves it away. Your own phrases stay in this browser.
                </span>
              </span>
              <Switch checked={Boolean(completion && newEditor)} disabled={!newEditor} onCheckedChange={(v) => onCompletionChange(Boolean(v))} aria-label="Complete as I type" />
            </label>
            {completion && newEditor && onForgetPhrases && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {phraseCount > 0 ? `${phraseCount} of your own phrases remembered on this computer.` : 'Nothing of yours is remembered yet; it learns from what you send.'}
                {phraseCount > 0 && <button type="button" onClick={onForgetPhrases} className="tp-focus-ring ml-1.5 rounded px-1 font-medium text-primary hover:underline">Forget them</button>}
              </p>
            )}
          </div>
        )}
        {onAiChange && (
          <label className="mt-3 flex items-start justify-between gap-4 border-t border-border pt-3">
            <span>
              <span className="block text-sm font-medium text-foreground">Writing help (AI)</span>
              <span className="block text-xs text-muted-foreground">
                The <strong>AI</strong> button under the editor: fix spelling, shorten, change the tone, translate, or turn notes into a reply. You always see the suggestion first; nothing changes until you choose Replace. Switch it off to hide the button. Remembered for you.
              </span>
            </span>
            <Switch checked={Boolean(ai)} onCheckedChange={(v) => onAiChange(Boolean(v))} aria-label="Writing help (AI)" />
          </label>
        )}
      </div>
    </div>
  );
}
