import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Building2, Loader2, Search, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { initials } from './ticketUi';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_FIELD_CLASS = 'tp-focus-ring w-full text-sm bg-white border border-input rounded-lg px-3 py-2.5 text-slate-800 placeholder:text-slate-400';

/**
 * Normalize a search hit (known requester row or Entra directory user) into
 * the picked-requester shape the create form and the edit modal both use.
 */
export function toPickedRequester(person, fromDirectory = false) {
  const location = person.entraOfficeLocation || person.entraCity || null;
  return {
    id: fromDirectory ? null : (person.id ?? null),
    name: person.name,
    email: person.email,
    jobTitle: person.jobTitle || null,
    department: person.department || null,
    location,
    hint: [person.jobTitle, location || person.department].filter(Boolean).join(' · '),
    fromDirectory,
  };
}

/**
 * Requester picker (Phase ET3 — lifted out of TicketCreate so the Edit
 * modal shares it): debounced search over known requesters + the Entra
 * directory, a "use this email" escape hatch, and the picked-person chip
 * enriched with the Entra photo + helpdesk history.
 *
 * Controlled: `value` is the picked requester (or null); `onChange` gets the
 * pick / null on clear. `onQueryChange` surfaces the typed text so a parent
 * can accept a bare typed email without a pick (the create form's flow).
 * `onEnrich` hands the photo/stats up for parents that render them elsewhere.
 */
const RequesterTypeahead = forwardRef(function RequesterTypeahead({
  value,
  onChange,
  onQueryChange,
  onEnrich,
  inputId = 'requester-typeahead',
  placeholder = 'Search people by name or email…',
  allowNewEmail = true,
  newEmailNote = null, // override the "will be created with the ticket" line
  autoFocus = false,
  fieldClass = DEFAULT_FIELD_CLASS,
  chipClass = 'bg-blue-50/60 border-blue-200',
  ariaLabel = 'Requester',
}, ref) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [stats, setStats] = useState(null);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }), []);

  useEffect(() => { if (autoFocus && !value) inputRef.current?.focus(); }, [autoFocus, value]);

  useEffect(() => { onQueryChange?.(query); }, [query, onQueryChange]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults(null); return undefined; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await ticketsAPI.requesterSearch(q);
        setResults(res.data);
        setOpen(true);
      } catch { setResults(null); }
      setLoading(false);
    }, 300);
    return () => { clearTimeout(timer); setLoading(false); };
  }, [query]);

  useEffect(() => {
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Enrich the picked requester: photo (Entra) + helpdesk history (known ones).
  useEffect(() => {
    setPhoto(null);
    setStats(null);
    onEnrich?.({ photo: null, stats: null });
    if (!value?.email) return undefined;
    let alive = true;
    let nextPhoto = null;
    let nextStats = null;
    ticketsAPI.requesterPhoto(value.email)
      .then((res) => { if (alive) { nextPhoto = res.data?.photo || null; setPhoto(nextPhoto); onEnrich?.({ photo: nextPhoto, stats: nextStats }); } })
      .catch(() => {});
    if (value.id) {
      ticketsAPI.requesterStats(value.id)
        .then((res) => { if (alive) { nextStats = res.data || null; setStats(nextStats); onEnrich?.({ photo: nextPhoto, stats: nextStats }); } })
        .catch(() => {});
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.email, value?.id]);

  const pick = (person, fromDirectory = false) => {
    onChange?.(toPickedRequester(person, fromDirectory));
    setQuery('');
    setResults(null);
    setOpen(false);
  };
  const clear = () => {
    onChange?.(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const typedEmailOk = allowNewEmail && EMAIL_RE.test(query.trim());
  const hasHits = Boolean(results && (results.requesters.length > 0 || results.directory.length > 0));

  return (
    <div ref={rootRef} className="relative" data-testid="requester-typeahead">
      {value ? (
        <div className={`flex items-center gap-3 px-3 py-2.5 border rounded-xl ${chipClass}`} data-testid="requester-chip">
          {photo ? (
            <img src={photo} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          ) : (
            <span className="h-9 w-9 rounded-full bg-blue-100 text-blue-700 inline-flex items-center justify-center text-xs font-semibold flex-shrink-0">
              {initials(value.name)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800 truncate">
              {value.name}
              {value.fromDirectory && <span className="ml-1.5 text-[10px] font-semibold text-violet-600 uppercase">Entra</span>}
            </span>
            <span className="block text-xs text-slate-500 truncate">
              {value.email}{value.hint ? ` · ${value.hint}` : ''}
              {stats && (stats.total ?? stats.totalTickets) != null ? ` · ${stats.total ?? stats.totalTickets} previous ticket${(stats.total ?? stats.totalTickets) === 1 ? '' : 's'}` : ''}
            </span>
          </span>
          <button
            type="button"
            onClick={clear}
            aria-label="Clear requester"
            className="tp-focus-ring p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              id={inputId}
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => { if (results) setOpen(true); }}
              placeholder={placeholder}
              autoComplete="off"
              role="combobox"
              aria-label={ariaLabel}
              aria-expanded={open}
              aria-autocomplete="list"
              className={`${fieldClass} pl-9`}
            />
            {loading && <Loader2 className="w-4 h-4 animate-spin text-slate-300 absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true" />}
          </div>
          {typedEmailOk && !open && (
            <p className="mt-1 text-[11px] text-emerald-600">
              {newEmailNote || <>New requester — “{query.trim()}” will be created with the ticket.</>}
            </p>
          )}
          {open && results && (hasHits || typedEmailOk) && (
            <div className="absolute left-0 right-0 top-full mt-1 z-30 tp-card rounded-xl shadow-soft py-1 max-h-80 overflow-y-auto settings-scrollbar" role="listbox">
              {results.requesters.length > 0 && (
                <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Requesters</p>
              )}
              {results.requesters.map((p) => (
                <button
                  key={`r-${p.id}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => pick(p)}
                  className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center gap-2.5"
                >
                  <span className="h-7 w-7 rounded-full bg-blue-50 text-blue-700 border border-blue-100 inline-flex items-center justify-center text-[10px] font-semibold flex-shrink-0">{initials(p.name)}</span>
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                    <span className="block text-xs text-slate-400 truncate">{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}</span>
                  </span>
                </button>
              ))}
              {results.directory.length > 0 && (
                <p className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-400 flex items-center gap-1">
                  <Building2 className="w-3 h-3" aria-hidden="true" /> Entra directory
                </p>
              )}
              {results.directory.map((p) => (
                <button
                  key={`d-${p.email}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => pick(p, true)}
                  className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-violet-50 flex items-center gap-2.5"
                >
                  <span className="h-7 w-7 rounded-full bg-violet-50 text-violet-700 border border-violet-100 inline-flex items-center justify-center text-[10px] font-semibold flex-shrink-0">{initials(p.name)}</span>
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                    <span className="block text-xs text-slate-400 truncate">{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}</span>
                  </span>
                </button>
              ))}
              {typedEmailOk && (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => pick({ name: query.trim().split('@')[0], email: query.trim().toLowerCase() }, false)}
                  className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-emerald-50 text-sm text-emerald-700 border-t border-slate-100 mt-1"
                >
                  Use “{query.trim()}” as a new requester
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default RequesterTypeahead;
