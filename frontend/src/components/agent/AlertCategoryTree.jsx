import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';

/**
 * Searchable category tree for My alerts. Ticking a top category means "all of
 * it" — its subcategories show as included. Each subcategory can also be
 * ticked on its own. A search keeps a parent visible when one of its
 * subcategories matches, and opens it.
 *
 * value: array of category ids (tops and/or subs); onChange(nextIds).
 */
export default function AlertCategoryTree({ tree = [], value = [], onChange, idPrefix = 'alert-cat' }) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(value), [value]);
  const [open, setOpen] = useState(() => new Set(
    tree.filter((t) => (t.children || []).some((c) => selected.has(c.id))).map((t) => t.id),
  ));

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => tree.map((top) => {
    const kids = top.children || [];
    if (!q) return { top, kids, searchOpen: false };
    const topHit = top.name.toLowerCase().includes(q);
    const kidHits = kids.filter((c) => c.name.toLowerCase().includes(q));
    if (!topHit && !kidHits.length) return null;
    return { top, kids: topHit ? kids : kidHits, searchOpen: kidHits.length > 0 };
  }).filter(Boolean), [tree, q]);

  const toggleTop = (top) => {
    if (selected.has(top.id)) {
      onChange(value.filter((id) => id !== top.id));
    } else {
      const kidIds = new Set((top.children || []).map((c) => c.id));
      onChange([...value.filter((id) => !kidIds.has(id)), top.id]);
    }
  };
  const toggleKid = (kid) => {
    onChange(selected.has(kid.id) ? value.filter((id) => id !== kid.id) : [...value, kid.id]);
  };
  const toggleOpen = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const box = 'tp-focus-ring h-4 w-4 flex-shrink-0 cursor-pointer rounded border-input accent-primary disabled:cursor-default';

  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Find a category</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a category"
          className="tp-focus-ring w-full rounded-lg border border-input bg-card py-1.5 pl-8 pr-2.5 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </label>

      <fieldset className="mt-2">
        <legend className="sr-only">Categories</legend>
        <div className="settings-scrollbar max-h-72 overflow-y-auto rounded-lg border border-border bg-card">
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {tree.length ? `No category matches “${query.trim()}”.` : 'This workspace has no categories yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map(({ top, kids, searchOpen }) => {
                const allKids = top.children || [];
                const topOn = selected.has(top.id);
                const picked = allKids.filter((c) => selected.has(c.id)).length;
                const expanded = allKids.length > 0 && (searchOpen || open.has(top.id));
                const kidsId = `${idPrefix}-kids-${top.id}`;
                const topBoxId = `${idPrefix}-${top.id}`;
                return (
                  <li key={top.id}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      {allKids.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleOpen(top.id)}
                          aria-expanded={expanded}
                          aria-controls={kidsId}
                          aria-label={`${expanded ? 'Hide' : 'Show'} subcategories of ${top.name}`}
                          className="tp-focus-ring rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                        </button>
                      ) : <span className="w-5" aria-hidden="true" />}
                      <input
                        id={topBoxId}
                        type="checkbox"
                        checked={topOn}
                        ref={(el) => { if (el) el.indeterminate = !topOn && picked > 0; }}
                        onChange={() => toggleTop(top)}
                        className={box}
                      />
                      <label htmlFor={topBoxId} className="min-w-0 flex-1 cursor-pointer truncate text-sm text-foreground">
                        {top.name}
                      </label>
                      {allKids.length > 0 && (topOn || picked > 0) && (
                        <span className="flex-shrink-0 text-xs text-muted-foreground">
                          {topOn ? `includes all ${allKids.length}` : `${picked} of ${allKids.length}`}
                        </span>
                      )}
                    </div>
                    {expanded && (
                      <ul id={kidsId} className="pb-1">
                        {kids.map((kid) => {
                          const kidId = `${idPrefix}-${kid.id}`;
                          return (
                            <li key={kid.id} className="flex items-center gap-2 py-1 pl-[3.25rem] pr-2">
                              <input
                                id={kidId}
                                type="checkbox"
                                checked={topOn || selected.has(kid.id)}
                                disabled={topOn}
                                onChange={() => toggleKid(kid)}
                                aria-describedby={topOn ? `${kidId}-inc` : undefined}
                                className={`${box} ${topOn ? 'opacity-50' : ''}`}
                              />
                              <label htmlFor={kidId} className={`min-w-0 flex-1 truncate text-sm ${topOn ? 'text-muted-foreground' : 'text-foreground cursor-pointer'}`}>
                                {kid.name}
                              </label>
                              {topOn && <span id={`${kidId}-inc`} className="flex-shrink-0 text-xs text-muted-foreground">included</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </fieldset>
    </div>
  );
}
