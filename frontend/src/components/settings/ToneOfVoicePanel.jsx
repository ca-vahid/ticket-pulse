import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, MessageSquareQuote, RotateCcw, Search, Trash2, UserPlus, UserSearch } from 'lucide-react';
import api, { ticketsAPI } from '../../services/api';
import { PersonAvatar } from '../tickets/ticketUi';

/**
 * Settings → Tone of Voice (QA 09-25 item 5). Mail Workflows' AI e-mails are
 * friendly by default; this panel sets the workspace default voice, keeps the
 * Straight-Talk List (people who always get a plain, professional reply), the
 * wording the AI is given for them, and whether a frustrated requester also
 * switches the tone.
 */

export const toneAPI = {
  getSettings: () => api.get('/tone/settings'),
  saveSettings: (data) => api.put('/tone/settings', data),
  listContacts: () => api.get('/tone/contacts'),
  addContact: (data) => api.post('/tone/contacts', data),
  removeContact: (id) => api.delete(`/tone/contacts/${id}`),
  preview: (data) => api.post('/tone/preview', data),
};

const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? (r.data?.data ?? r.data) : r);
const errorText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const inputCls = 'tp-focus-ring w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/75';

const VOICES = [
  { value: 'friendly', label: 'Friendly', hint: 'Each workflow uses its own Voice setting (Friendly, Playful or Professional).' },
  { value: 'professional', label: 'Professional', hint: 'Every AI e-mail in this workspace is plain and professional, whatever the workflow says.' },
];

const REASON_TEXT = {
  straight_talk_list: 'on the Straight-Talk List',
  frustrated: 'the requester seemed frustrated',
  workspace_default: 'the workspace default voice is Professional',
};

function SectionTitle({ children, hint }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-semibold text-foreground">{children}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PersonPicker({ onPick, disabled, ariaLabel = 'Search people', placeholder = 'Search people by name or e-mail' }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) { setResults([]); return undefined; }
    timer.current = setTimeout(async () => {
      try {
        const res = await ticketsAPI.requesterSearch(query);
        const data = unwrap(res) || {};
        const seen = new Set();
        const merged = [];
        for (const p of [...(data.requesters || []), ...(data.directory || [])]) {
          const email = String(p.email || '').toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          merged.push({ name: p.name || null, email, detail: p.jobTitle || p.department || null });
        }
        setResults(merged.slice(0, 10));
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q]);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim());
  const pick = (person) => { onPick(person); setQ(''); setResults([]); setOpen(false); };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground/75" aria-hidden="true" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && looksLikeEmail) { e.preventDefault(); pick({ email: q.trim().toLowerCase(), name: null }); }
        }}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`${inputCls} pl-8`}
      />
      {open && (results.length > 0 || looksLikeEmail) && (
        <ul role="listbox" aria-label="People" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-card py-1 shadow-soft settings-scrollbar">
          {results.map((p) => (
            <li key={p.email}>
              <button type="button" role="option" aria-selected="false" onClick={() => pick(p)} className="tp-focus-ring flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-muted">
                <PersonAvatar name={p.name || p.email} size="h-7 w-7" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{p.name || p.email}</span>
                  <span className="block truncate text-xs text-muted-foreground">{p.name ? p.email : ''}{p.detail ? `${p.name ? ' · ' : ''}${p.detail}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
          {looksLikeEmail && !results.some((p) => p.email === q.trim().toLowerCase()) && (
            <li>
              <button type="button" role="option" aria-selected="false" onClick={() => pick({ email: q.trim().toLowerCase(), name: null })} className="tp-focus-ring flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted">
                <UserPlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Use {q.trim()}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function ToneOfVoicePanel() {
  const [settings, setSettings] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(null); // person picked, not yet added
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [check, setCheck] = useState({ person: null, ticketId: '' });
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);

  const say = (kind, body) => setMessage({ kind, body });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The list itself is admins/observers only (review N7) - a member still
      // sees the settings.
      const [s, c] = await Promise.all([toneAPI.getSettings(), toneAPI.listContacts().catch(() => null)]);
      const next = unwrap(s);
      setSettings(next);
      setText(next?.seriousToneText || '');
      setContacts(unwrap(c) || []);
    } catch (e) {
      say('error', errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch, okText = 'Saved') => {
    setSaving(true);
    try {
      const next = unwrap(await toneAPI.saveSettings(patch));
      setSettings(next);
      if (patch.seriousToneText !== undefined) setText(next?.seriousToneText || '');
      say('ok', okText);
    } catch (e) {
      say('error', errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const addPerson = async () => {
    if (!pending) return;
    setAdding(true);
    try {
      await toneAPI.addContact({ email: pending.email, name: pending.name, note: note.trim() || null });
      setPending(null);
      setNote('');
      setContacts(unwrap(await toneAPI.listContacts()) || []);
      say('ok', `${pending.name || pending.email} added to the Straight-Talk List`);
    } catch (e) {
      say('error', errorText(e));
    } finally {
      setAdding(false);
    }
  };

  const removePerson = async (contact) => {
    try {
      await toneAPI.removeContact(contact.id);
      setContacts((list) => list.filter((c) => c.id !== contact.id));
      say('ok', `${contact.name || contact.email} removed`);
    } catch (e) {
      say('error', errorText(e));
    }
  };

  const runCheck = async (e, person = check.person) => {
    e?.preventDefault?.();
    if (!person?.email) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const body = { email: person.email };
      if (String(check.ticketId).trim()) body.sampleTicketId = Number(String(check.ticketId).replace(/\D/g, '')) || undefined;
      setCheckResult(unwrap(await toneAPI.preview(body)));
    } catch (err) {
      setCheckResult({ error: errorText(err) });
    } finally {
      setChecking(false);
    }
  };

  if (loading && !settings) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading tone settings…
      </div>
    );
  }

  const defaultText = settings?.defaultSeriousToneText || '';
  const textDirty = text.trim() !== String(settings?.seriousToneText || '').trim();

  return (
    <div className="max-w-3xl space-y-6" data-testid="tone-of-voice-panel">
      <header className="flex items-start gap-3">
        <MessageSquareQuote className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">Tone of voice</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            How the AI writes Mail Workflow e-mails to requesters. Friendly is the default; some people would rather get it straight.
          </p>
        </div>
      </header>

      {message && (
        <p role="status" className={`text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300'}`}>
          {message.body}
        </p>
      )}

      <section>
        <SectionTitle>Default voice</SectionTitle>
        <div role="radiogroup" aria-label="Default voice" className="grid gap-2 sm:grid-cols-2">
          {VOICES.map((v) => {
            const active = settings?.defaultVoice === v.value;
            return (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={saving}
                onClick={() => !active && save({ defaultVoice: v.value }, `Default voice: ${v.label}`)}
                className={`tp-focus-ring rounded-lg border px-3 py-2.5 text-left transition-colors ${active ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {active && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                  {v.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{v.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <SectionTitle hint="People here always get a plain, professional reply — no jokes or emoji.">Straight-Talk List</SectionTitle>
        <div className="space-y-2">
          {!pending ? (
            <PersonPicker onPick={setPending} disabled={adding} />
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 p-2">
              <PersonAvatar name={pending.name || pending.email} size="h-7 w-7" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{pending.name || pending.email}</span>
                {pending.name && <span className="block truncate text-xs text-muted-foreground">{pending.email}</span>}
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="Note (optional) — e.g. asked for it"
                aria-label="Note"
                className={`${inputCls} sm:w-64`}
              />
              <button type="button" onClick={addPerson} disabled={adding} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {adding ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />} Add
              </button>
              <button type="button" onClick={() => { setPending(null); setNote(''); }} className="tp-focus-ring rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </div>
          )}

          {contacts.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">Nobody on the list yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Straight-Talk List">
              {contacts.map((c) => (
                <li key={c.id} className="flex items-center gap-2.5 px-3 py-2">
                  <PersonAvatar name={c.name || c.email} size="h-7 w-7" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{c.name || c.email}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.name ? c.email : ''}
                      {c.note ? `${c.name ? ' · ' : ''}${c.note}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePerson(c)}
                    aria-label={`Remove ${c.name || c.email}`}
                    title="Remove from the list"
                    className="tp-focus-ring rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <SectionTitle hint="Added to the AI's instructions whenever a professional reply is triggered for a person.">What the AI is told</SectionTitle>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          aria-label="Professional tone text"
          className={`${inputCls} resize-y`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={!textDirty || saving || !text.trim()} onClick={() => save({ seriousToneText: text }, 'Tone text saved')} className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            Save text
          </button>
          <button
            type="button"
            disabled={saving || (settings?.seriousToneTextIsDefault && !textDirty)}
            onClick={() => { setText(defaultText); save({ seriousToneText: '' }, 'Tone text reset to the default'); }}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset to default
          </button>
        </div>
      </section>

      <section>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="tp-focus-ring mt-0.5 h-4 w-4 rounded border-input accent-primary"
            checked={settings?.seriousWhenFrustrated !== false}
            disabled={saving}
            onChange={(e) => save({ seriousWhenFrustrated: e.target.checked }, e.target.checked ? 'Frustrated requesters get a professional reply' : 'Frustration no longer changes the tone')}
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Also switch to professional when someone seems frustrated</span>
            <span className="block text-xs text-muted-foreground">Ticket Pulse reads the requester&apos;s own messages (new ticket and every reply) and uses the same text above.</span>
          </span>
        </label>
      </section>

      <section>
        <SectionTitle hint="Which voice an AI e-mail to this person would use right now.">Check a person</SectionTitle>
        {!check.person ? (
          <PersonPicker
            ariaLabel="Person to check"
            placeholder="Find a person by name or e-mail"
            onPick={(p) => { setCheck((c) => ({ ...c, person: p })); runCheck(null, p); }}
          />
        ) : (
          <form onSubmit={runCheck} className="flex flex-wrap items-center gap-2">
            <span className="flex min-w-[14rem] flex-1 items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5" data-testid="tone-check-person">
              <PersonAvatar name={check.person.name || check.person.email} size="h-6 w-6" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{check.person.name || check.person.email}</span>
                {check.person.name && <span className="block truncate text-xs text-muted-foreground">{check.person.email}</span>}
              </span>
              <button type="button" onClick={() => { setCheck((c) => ({ ...c, person: null })); setCheckResult(null); }} className="tp-focus-ring rounded px-1 text-xs font-medium text-primary hover:underline">
              Change
              </button>
            </span>
            <input
              value={check.ticketId}
              onChange={(e) => setCheck((c) => ({ ...c, ticketId: e.target.value }))}
              placeholder="Ticket id (optional)"
              aria-label="Sample ticket id"
              className={`${inputCls.replace('w-full ', '')} w-40`}
            />
            <button type="submit" disabled={checking} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50">
              {checking ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserSearch className="h-4 w-4" aria-hidden="true" />} Check
            </button>
          </form>
        )}
        {checkResult && (
          <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="tone-check-result">
            {checkResult.error ? (
              <p className="text-destructive">{checkResult.error}</p>
            ) : (
              <>
                <p className="text-foreground">
                  {checkResult.voice === 'professional'
                    ? <>Professional tone{(checkResult.override?.reason || checkResult.workspaceVoice === 'professional') && <> — {REASON_TEXT[checkResult.override?.reason || 'workspace_default']}</>}.</>
                    : <>The workflow&apos;s own voice (friendly unless the workflow says otherwise).</>}
                  {checkResult.sentiment && <span className="text-muted-foreground"> Ticket sentiment: {checkResult.sentiment}.</span>}
                </p>
                {checkResult.illustration && (
                  <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Friendly</dt>
                      <dd className="mt-0.5 text-foreground/85">{checkResult.illustration.before}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">This person gets</dt>
                      <dd className="mt-0.5 text-foreground/85">{checkResult.illustration.after}</dd>
                    </div>
                  </dl>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
