import { useEffect, useRef, useState } from 'react';
import { Building2, Loader2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { initials } from './ticketUi';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Cc recipients as removable chips with a GAL/Entra typeahead. Type a name or
 * email to search known requesters + the Entra directory; click (or Enter on a
 * highlighted match) to add. A fully-typed address still commits on
 * Enter/comma/semicolon/blur. Backspace on an empty input removes the last chip.
 */
export default function CcChips({
  value = [],
  onChange,
  max = 10,
  placeholder = 'Add Cc…',
  label = 'Cc recipients',
  // Chip-row prefix ("Cc" in the composer, "Also for" on the ticket page).
  prefix = 'Cc',
  // readOnly: chips only (no input, no remove) — FS-owned lists / no write
  // access. disabled: keep the row but block edits while a save is in flight.
  readOnly = false,
  disabled = false,
}) {
  const [input, setInput] = useState('');
  const [results, setResults] = useState([]); // [{name, email, hint}]
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  const trimmed = input.trim();
  const invalid = trimmed.length > 0 && !EMAIL_RE.test(trimmed) && !open;

  const addEmails = (emails) => {
    const fresh = emails
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e) && !value.includes(e));
    if (fresh.length) onChange([...value, ...fresh].slice(0, max));
  };

  const commit = (raw) => {
    const parts = String(raw).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    addEmails(parts);
    setInput(parts.filter((p) => !EMAIL_RE.test(p)).join(' '));
    setResults([]);
    setOpen(false);
    setActive(-1);
  };

  const pick = (person) => {
    if (!person?.email) return;
    addEmails([person.email]);
    setInput('');
    setResults([]);
    setOpen(false);
    setActive(-1);
  };

  // Debounced directory search — known requesters + Entra.
  useEffect(() => {
    const q = input.trim();
    if (q.length < 2) { setResults([]); setOpen(false); setLoading(false); return undefined; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await ticketsAPI.requesterSearch(q);
        const seen = new Set(value);
        const merged = [];
        for (const p of [...(res.data?.requesters || []), ...(res.data?.directory || [])]) {
          const email = (p.email || '').toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          merged.push({
            name: p.name,
            email,
            hint: [p.jobTitle, p.department || p.entraOfficeLocation || p.entraCity].filter(Boolean).join(' · '),
          });
        }
        setResults(merged.slice(0, 8));
        setOpen(true);
      } catch { setResults([]); }
      setLoading(false);
    }, 250);
    return () => { clearTimeout(timer); setLoading(false); };
  }, [input, value]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const onKeyDown = (e) => {
    if (open && results.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return ((next % results.length) + results.length) % results.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && results[active]) pick(results[active]);
      else commit(input);
    } else if (e.key === ',' || e.key === ';') {
      e.preventDefault();
      commit(input);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div
        className={`flex flex-wrap items-center gap-1.5 border rounded-lg px-2 py-1.5 bg-card ${
          invalid ? 'border-red-300 dark:border-red-500/40' : 'border-input focus-within:ring-2 focus-within:ring-ring'
        }`}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mr-0.5">
          {prefix}{value.length > 0 && <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200 text-[10px] font-bold">{value.length}</span>}
        </span>
        {value.map((email) => (
          <span key={email} className={`inline-flex items-center gap-1 pl-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 text-xs text-blue-800 dark:text-blue-200 ${readOnly ? 'pr-2' : 'pr-1'}`}>
            {email}
            {!readOnly && (
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== email))}
                disabled={disabled}
                aria-label={`Remove ${email} from ${prefix}`}
                className="tp-focus-ring rounded-full p-0.5 hover:bg-blue-100 dark:hover:bg-blue-500/20 text-blue-500 disabled:opacity-50"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        {readOnly && value.length === 0 && (
          <span className="text-xs text-muted-foreground/75">{placeholder}</span>
        )}
        {!readOnly && <span className="relative flex-1 min-w-[140px] flex items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setActive(-1); }}
            onKeyDown={onKeyDown}
            onFocus={() => { if (results.length) setOpen(true); }}
            onBlur={() => commit(input)}
            placeholder={value.length >= max ? `Max ${max} recipients` : placeholder}
            disabled={disabled || value.length >= max}
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-expanded={open}
            role="combobox"
            aria-autocomplete="list"
            autoComplete="off"
            className="w-full text-xs py-0.5 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/75"
          />
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/50 flex-shrink-0" aria-hidden="true" />}
        </span>}
        {invalid &&<span className="text-[10px] text-red-500 w-full">Not a valid email address yet — press Enter once fixed</span>}
      </div>

      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 tp-card rounded-lg shadow-soft py-1 max-h-64 overflow-y-auto settings-scrollbar" role="listbox">
          {results.map((p, i) => (
            <button
              key={p.email}
              type="button"
              role="option"
              aria-selected={i === active}
              // preventDefault keeps the input focused so onBlur-commit doesn't fire first
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setActive(i)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 ${i === active ? 'bg-blue-50 dark:bg-blue-500/15' : 'hover:bg-blue-50 dark:hover:bg-blue-500/15'}`}
            >
              <span className="h-6 w-6 rounded-full bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20 inline-flex items-center justify-center text-[9px] font-semibold flex-shrink-0">{initials(p.name)}</span>
              <span className="min-w-0">
                <span className="block text-sm text-foreground truncate">{p.name || p.email}</span>
                <span className="block text-xs text-muted-foreground/75 truncate flex items-center gap-1">
                  <Building2 className="w-3 h-3 flex-shrink-0" aria-hidden="true" />{p.email}{p.hint ? ` · ${p.hint}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
