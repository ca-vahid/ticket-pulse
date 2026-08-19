import { useEffect, useRef, useState } from 'react';
import { Building2, Loader2, X } from 'lucide-react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email addresses as removable chips (QA 08-18 #1 — extracted from CcChips so
 * the workflows "Custom emails" field stops eating commas). Behavior contract:
 *
 * - a typed address commits on comma / semicolon / Enter / blur;
 * - pasted text commits immediately, split tolerantly on commas, semicolons
 *   and whitespace (`c@x.io; d@x.io e@x.io` → three chips);
 * - invalid fragments stay in the input with a hint instead of vanishing;
 * - duplicates are dropped case-insensitively;
 * - Backspace on an empty input removes the last chip.
 *
 * Directory/requester typeahead is OFF by default — pass an async `search`
 * prop (q → [{ name, email, hint }]) to opt in (the CcChips-style dropdown).
 */
export default function EmailChipsInput({
  value = [],
  onChange,
  max = 25,
  placeholder = 'Add email…',
  label = 'Email recipients',
  search = null,
  className = '',
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
    const seen = new Set(value.map((e) => String(e).toLowerCase()));
    const fresh = [];
    for (const raw of emails) {
      const email = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      fresh.push(email);
    }
    if (fresh.length) onChange([...value, ...fresh].slice(0, max));
  };

  const commit = (raw) => {
    const parts = String(raw).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    addEmails(parts);
    // Invalid fragments stay visible for fixing instead of silently vanishing.
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

  // Opt-in typeahead (debounced) — only wired when a search fn is provided.
  useEffect(() => {
    if (!search) return undefined;
    const q = input.trim();
    if (q.length < 2) { setResults([]); setOpen(false); setLoading(false); return undefined; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await search(q);
        const seen = new Set(value.map((e) => String(e).toLowerCase()));
        const merged = [];
        for (const p of found || []) {
          const email = (p.email || '').toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          merged.push({ name: p.name, email, hint: p.hint });
        }
        setResults(merged.slice(0, 8));
        setOpen(true);
      } catch { setResults([]); }
      setLoading(false);
    }, 250);
    return () => { clearTimeout(timer); setLoading(false); };
  }, [input, value, search]);

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

  const onPaste = (e) => {
    const pasted = e.clipboardData?.getData('text/plain');
    if (!pasted) return;
    e.preventDefault();
    commit(`${input} ${pasted}`);
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <div
        className={`flex flex-wrap items-center gap-1.5 border rounded-lg px-2 py-1.5 bg-white ${
          invalid ? 'border-red-300' : 'border-input focus-within:ring-2 focus-within:ring-ring'
        }`}
      >
        {value.map((email) => (
          <span key={email} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-800">
            {email}
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v !== email))}
              aria-label={`Remove ${email}`}
              className="tp-focus-ring rounded-full p-0.5 hover:bg-blue-100 text-blue-500"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <span className="relative flex-1 min-w-[140px] flex items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setActive(-1); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => { if (results.length) setOpen(true); }}
            onBlur={() => commit(input)}
            placeholder={value.length >= max ? `Max ${max} addresses` : placeholder}
            disabled={value.length >= max}
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-expanded={search ? open : undefined}
            role={search ? 'combobox' : undefined}
            aria-autocomplete={search ? 'list' : undefined}
            autoComplete="off"
            className="w-full text-xs py-0.5 outline-none placeholder:text-slate-400 disabled:bg-transparent"
          />
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-300 flex-shrink-0" aria-hidden="true" />}
        </span>
        {invalid && <span className="text-[10px] text-red-500 w-full">Not a valid email address yet — press Enter once fixed</span>}
      </div>

      {search && open && results.length > 0 && (
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
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 ${i === active ? 'bg-blue-50' : 'hover:bg-blue-50'}`}
            >
              <span className="min-w-0">
                <span className="block text-sm text-slate-800 truncate">{p.name || p.email}</span>
                <span className="block text-xs text-slate-400 truncate flex items-center gap-1">
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
