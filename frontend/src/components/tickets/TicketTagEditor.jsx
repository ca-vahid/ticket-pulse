import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Tag as TagGlyph } from 'lucide-react';
import { TagChip } from './ticketUi';
import { settingsAPI, ticketsAPI } from '../../services/api';

/**
 * Sidebar tag editor (gap plan P1). Tags are a TP-side layer valid for BOTH
 * ticket origins (never written to FreshService), so this stays editable on
 * FS-born tickets too. Picks from the workspace palette; admins can create a
 * new tag inline (everyone else picks from what admins defined).
 */
export default function TicketTagEditor({ ticketId, tags = [], allTags = [], canEdit = false, isAdmin = false, onChanged }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const currentIds = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const q = query.trim().toLowerCase();
  const options = useMemo(() => (allTags || [])
    .filter((t) => !currentIds.has(t.id))
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .slice(0, 8), [allTags, currentIds, q]);
  const exactExists = (allTags || []).some((t) => t.name.toLowerCase() === q);

  const apply = async (tagIds) => {
    setBusy(true);
    try {
      await ticketsAPI.setTags(ticketId, tagIds);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const addTag = (tag) => {
    setQuery('');
    setOpen(false);
    apply([...currentIds, tag.id]);
  };

  const removeTag = (tag) => apply([...currentIds].filter((id) => id !== tag.id));

  const createAndAdd = async () => {
    const name = query.trim();
    if (!name || !isAdmin) return;
    setBusy(true);
    try {
      const res = await settingsAPI.createTicketTag({ name });
      const created = res.data?.data || res.data;
      if (created?.id) await ticketsAPI.setTags(ticketId, [...currentIds, created.id]);
      setQuery('');
      setOpen(false);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit && tags.length === 0) return null;

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-1 flex items-center gap-1">
        <TagGlyph className="w-3 h-3" aria-hidden="true" /> Tags
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <TagChip key={tag.id} tag={tag} onRemove={canEdit && !busy ? removeTag : null} />
        ))}
        {canEdit && (
          <span ref={rootRef} className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              disabled={busy}
              aria-expanded={open}
              aria-label="Add tag"
              className="tp-focus-ring inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-dashed border-input text-[11px] text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 hover:border-blue-300 dark:hover:border-blue-500/40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Plus className="w-3 h-3" aria-hidden="true" />}
              Tag
            </button>
            {open && (
              <span className="absolute left-0 top-full mt-1 z-30 w-56 tp-card rounded-lg shadow-soft p-1.5 flex flex-col animate-scaleIn">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setOpen(false);
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (options.length > 0) addTag(options[0]);
                      else if (isAdmin && q && !exactExists) createAndAdd();
                    }
                  }}
                  placeholder="Search tags…"
                  aria-label="Search tags"
                  className="tp-focus-ring w-full text-xs bg-card border border-input rounded-md px-2 py-1.5 mb-1 placeholder:text-muted-foreground/75"
                />
                <span className="max-h-44 overflow-y-auto settings-scrollbar flex flex-col">
                  {options.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => addTag(tag)}
                      className="tp-focus-ring text-left px-1.5 py-1 rounded-md hover:bg-muted/50"
                    >
                      <TagChip tag={tag} size="xs" />
                    </button>
                  ))}
                  {options.length === 0 && (!isAdmin || !q || exactExists) && (
                    <span className="px-2 py-1.5 text-xs text-muted-foreground/75">
                      {q ? 'No matching tags.' : 'No more tags — admins manage them under Settings → Ticket Ops.'}
                    </span>
                  )}
                  {isAdmin && q && !exactExists && (
                    <button
                      type="button"
                      onClick={createAndAdd}
                      className="tp-focus-ring text-left px-2 py-1.5 rounded-md text-xs font-medium text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15"
                    >
                      Create “{query.trim()}”
                    </button>
                  )}
                </span>
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
