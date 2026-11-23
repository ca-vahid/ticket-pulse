import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, Copy, Download, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { personalApiKeysAPI } from '../../services/api';
import {
  ABILITIES, DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, abilitySentence, errorText, expiryWords,
  isLiveKey, lastUsedPhrase, parseIpList, rotationExpiry,
} from '../apiKeys/personalKeyText';

/**
 * Your API key (4.4.05). A personal key is owned by one person in one
 * workspace; every call made with it runs as them, capped by what their role
 * can do in the app. Shown only to people an admin put on the API access list
 * (`enabled`); everyone else sees nothing here.
 *
 * One key per person: rotate replaces it, revoke ends it. The secret is shown
 * once, right after create or rotate, and dropped from memory on Done.
 */

export const SECRET_WARNING = 'This key acts as you. Anyone who has it can reply to requesters in your name. Keep it secret; revoke it if it leaks.';

// The server sends the ability list ({ id, label, description, locked }) and
// the expiry choices; the local copy is the fallback for an older backend.
function abilityChoices(info) {
  const fromServer = Array.isArray(info?.abilities) ? info.abilities.filter((a) => a && a.id) : [];
  if (!fromServer.length) return ABILITIES;
  return fromServer.map((a) => {
    const local = ABILITIES.find((x) => x.id === a.id);
    return { id: a.id, label: a.label || local?.label || a.id, hint: a.description || local?.hint || '', always: a.locked === true || a.id === 'read' };
  });
}
function expiryChoices(info) {
  const list = Array.isArray(info?.expiryOptions) ? info.expiryOptions.map(Number).filter((n) => n > 0) : [];
  const options = list.length ? list : EXPIRY_CHOICES;
  const wanted = Number(info?.defaultExpiryDays) || DEFAULT_EXPIRY_DAYS;
  return { options, initial: options.includes(wanted) ? wanted : options[0] };
}

const btnPrimary = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60';
const btnQuiet = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60';
const btnDanger = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60';
const fieldBase = 'tp-focus-ring rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/75';
const field = `${fieldBase} w-full`;
// Content-width: `w-full` would beat `w-auto` in the built CSS, so the select
// never carries it.
const selectField = `${fieldBase} block w-auto min-w-[8rem]`;

function useCopied() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      return false; // manual selection still works
    }
  }, []);
  return [copied, copy];
}

function CreateForm({ busy, error, onSubmit, onCancel, abilities: choices = ABILITIES, expiry = { options: EXPIRY_CHOICES, initial: DEFAULT_EXPIRY_DAYS } }) {
  const [draft, setDraft] = useState(() => ({ name: '', abilities: ['read'], expiresInDays: expiry.initial, ips: '' }));
  const toggle = (id) => setDraft((d) => ({
    ...d,
    abilities: d.abilities.includes(id) ? d.abilities.filter((a) => a !== id) : [...d.abilities, id],
  }));
  const submit = (e) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name || busy) return;
    const abilities = choices.filter((a) => a.always || draft.abilities.includes(a.id)).map((a) => a.id);
    onSubmit({ name, abilities, expiresInDays: Number(draft.expiresInDays), ipAllowlist: parseIpList(draft.ips) });
  };

  return (
    <form onSubmit={submit} aria-label="Create a key" className="space-y-4">
      <div>
        <label htmlFor="pk-name" className="block text-sm font-medium text-foreground">Name</label>
        <p className="text-xs text-muted-foreground">What will use it, so you recognise it later.</p>
        <input
          id="pk-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          maxLength={80}
          placeholder="e.g. My reply assistant"
          className={`${field} mt-1.5 sm:max-w-sm`}
          autoComplete="off"
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-foreground">What it can do</legend>
        <p className="text-xs text-muted-foreground">Never more than you can do in the app, checked on every call.</p>
        <div className="mt-2 space-y-2">
          {choices.map((a) => (
            <label key={a.id} className={`flex items-start gap-2.5 ${a.always ? 'cursor-default' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={a.always || draft.abilities.includes(a.id)}
                disabled={a.always}
                onChange={() => toggle(a.id)}
                className="tp-focus-ring mt-0.5 h-4 w-4 rounded border-input text-primary disabled:opacity-60"
              />
              <span className="min-w-0">
                <span className="block text-sm text-foreground">{a.label}{a.always && <span className="text-muted-foreground"> (always on)</span>}</span>
                {a.hint && <span className="block text-xs text-muted-foreground">{a.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="pk-expiry" className="block text-sm font-medium text-foreground">Expires after</label>
        <select
          id="pk-expiry"
          value={draft.expiresInDays}
          onChange={(e) => setDraft({ ...draft, expiresInDays: Number(e.target.value) })}
          className={`${selectField} mt-1.5`}
        >
          {expiry.options.map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">You get an e-mail 7 days before it ends.</p>
      </div>

      <div>
        <label htmlFor="pk-ips" className="block text-sm font-medium text-foreground">IP addresses <span className="font-normal text-muted-foreground">(optional)</span></label>
        <p className="text-xs text-muted-foreground">One per line. If you add any, the key works only from them, so a leaked key is useless elsewhere.</p>
        <textarea
          id="pk-ips"
          value={draft.ips}
          onChange={(e) => setDraft({ ...draft, ips: e.target.value })}
          rows={3}
          placeholder={'10.1.2.3\n203.0.113.0/24'}
          className={`${field} mt-1.5 font-mono text-xs sm:max-w-sm`}
        />
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !draft.name.trim()} className={btnPrimary}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
          Create key
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={btnQuiet}>Cancel</button>
      </div>
    </form>
  );
}

function SecretOnce({ secret, keyName, onDone }) {
  const [copied, copy] = useCopied();
  return (
    <div className="space-y-2" data-testid="personal-key-secret" role="region" aria-label="Your new key">
      <p className="text-sm font-semibold text-foreground">Copy “{keyName}” now. You will not see it again.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">{secret}</code>
        <div className="flex gap-2">
          <button type="button" onClick={() => copy(secret)} className={btnPrimary}>
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={onDone} className={btnQuiet}>Done</button>
        </div>
      </div>
      <p className="text-sm text-amber-800 dark:text-amber-200">{SECRET_WARNING}</p>
    </div>
  );
}

function KeyRow({ k, busy, onRotate, onRevoke }) {
  const [confirm, setConfirm] = useState(null); // 'rotate' | 'revoke' | null
  const switchedOff = k.status === 'disabled';
  const ips = Array.isArray(k.ipAllowlist) ? k.ipAllowlist : [];
  const rotation = rotationExpiry(k);
  return (
    <div data-testid="personal-key-row">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-semibold text-foreground">
            {k.name}
            {k.prefix && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{k.prefix}…</span>}
          </p>
          <p className="text-sm text-foreground/85">{abilitySentence(k)}</p>
          <p className="text-xs text-muted-foreground">
            {expiryWords(k)} · {lastUsedPhrase(k)}
          </p>
          {ips.length > 0 && <p className="text-xs text-muted-foreground">Works only from {ips.join(', ')}</p>}
          {switchedOff && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">An admin switched this key off. Ask them to switch it back on, or revoke it.</p>
          )}
        </div>
        {!confirm && (
          // -ml-3 on the stacked layout lines the icons up with the text above
          // (the buttons' own px-3 would push them 12 px in).
          <div className="-ml-3 flex shrink-0 gap-1 sm:ml-0">
            {!switchedOff && (
              <button type="button" onClick={() => setConfirm('rotate')} disabled={busy} className={btnQuiet}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Rotate
              </button>
            )}
            <button type="button" onClick={() => setConfirm('revoke')} disabled={busy} className={`${btnQuiet} hover:text-destructive`}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Revoke
            </button>
          </div>
        )}
      </div>

      {confirm && (
        <div role="alertdialog" aria-label={confirm === 'rotate' ? 'Rotate this key?' : 'Revoke this key?'} className="mt-3 border-l-2 border-amber-400 dark:border-amber-500/60 pl-3">
          <p className="text-sm text-foreground">
            {confirm === 'rotate'
              ? `Rotate “${k.name}”? The current secret stops working at once and you get a new one. The name, abilities and IP addresses stay.${rotation ? ` The new key lasts ${rotation.days} days from today, until ${rotation.until}.` : ''}`
              : `Revoke “${k.name}”? It stops working at once and anything using it fails. This can't be undone.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => { const ok = await (confirm === 'rotate' ? onRotate(k) : onRevoke(k)); if (ok === false) return; setConfirm(null); }}
              className={confirm === 'rotate' ? btnPrimary : btnDanger}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {confirm === 'rotate' ? 'Rotate key' : 'Revoke key'}
            </button>
            <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={btnQuiet}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Your AI assistant guide: the Markdown the backend writes for you. */
export function AssistantGuide() {
  const [state, setState] = useState({ status: 'loading', markdown: '', filename: 'ticket-pulse-api-guide.md' });
  const [copied, copy] = useCopied();
  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const res = await personalApiKeysAPI.guide();
      const data = res?.data || {};
      setState({ status: 'ready', markdown: String(data.markdown || ''), filename: data.filename || 'ticket-pulse-api-guide.md' });
    } catch {
      setState((s) => ({ ...s, status: 'error' }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const download = () => {
    const blob = new Blob([state.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const ready = state.status === 'ready' && state.markdown;
  return (
    <div data-testid="assistant-guide">
      <div className="flex items-start gap-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Your AI assistant guide</h3>
          <p className="text-xs text-muted-foreground">Give this to your AI assistant so it writes replies the app can format; the app adds your signature.</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-6">
        <button type="button" onClick={() => copy(state.markdown)} disabled={!ready} className={`${btnQuiet} border border-border`}>
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download} disabled={!ready} className={`${btnQuiet} border border-border`}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download (.md)
        </button>
        {state.status === 'loading' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the guide" />}
        {state.status === 'error' && (
          <span className="text-xs text-destructive" role="alert">
            Could not load the guide. <button type="button" onClick={load} className="tp-focus-ring rounded underline">Try again</button>
          </span>
        )}
      </div>
      {ready && (
        <details className="mt-2 pl-6">
          <summary className="tp-focus-ring w-fit cursor-pointer rounded text-xs font-medium text-muted-foreground hover:text-foreground">See what it says</summary>
          <pre className="settings-scrollbar mt-2 max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed text-foreground/85">{state.markdown}</pre>
        </details>
      )}
    </div>
  );
}

export default function PersonalApiKeyPanel() {
  const [info, setInfo] = useState(null); // null = loading or hidden
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null); // { secret, keyName } — shown once
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await personalApiKeysAPI.mine();
      setInfo(res?.data || { enabled: false });
    } catch {
      setInfo({ enabled: false });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const keys = Array.isArray(info?.keys) ? info.keys : [];
  // Final contract: hide when the person is off the list AND has no key left
  // (someone downgraded to read-only keeps seeing the key so they can revoke it).
  if (!info || (!info.enabled && keys.length === 0)) return null;

  const live = keys.find(isLiveKey) || null;
  const expired = live ? null : keys.find((k) => k.status === 'expired') || null;
  const canCreate = info.enabled === true && info.canCreate !== false;

  const create = async (body) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await personalApiKeysAPI.create(body);
      const data = res?.data || {};
      setFresh({ secret: data.secret, keyName: data.key?.name || body.name });
      setCreating(false);
      await load();
    } catch (err) {
      setError(errorText(err, 'Could not create the key.'));
    } finally {
      setBusy(false);
    }
  };
  const rotate = async (k) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await personalApiKeysAPI.rotate(k.id);
      const data = res?.data || {};
      setFresh({ secret: data.secret, keyName: data.key?.name || k.name });
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, 'Could not rotate the key.'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await personalApiKeysAPI.revoke(k.id);
      setFresh(null);
      setNotice(`“${k.name}” is revoked. It no longer works.`);
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, 'Could not revoke the key.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card shadow-sm" aria-label="Your API key">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300"><KeyRound className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground">Your API key</h2>
            <p className="text-xs text-muted-foreground">For your own scripts and AI assistant. It works as you, and only as far as you can in the app.</p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {fresh && <SecretOnce secret={fresh.secret} keyName={fresh.keyName} onDone={() => setFresh(null)} />}
        {notice && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}
        {error && !creating && <p className="text-sm text-destructive" role="alert">{error}</p>}

        {live ? (
          <>
            <KeyRow k={live} busy={busy} onRotate={rotate} onRevoke={revoke} />
            {!info.enabled && info.reason && <p className="text-sm text-muted-foreground">{info.reason}</p>}
          </>
        ) : creating ? (
          <CreateForm
            busy={busy}
            error={error}
            abilities={abilityChoices(info)}
            expiry={expiryChoices(info)}
            onSubmit={create}
            onCancel={() => { setCreating(false); setError(null); }}
          />
        ) : (
          <div className="space-y-3" data-testid="personal-key-empty">
            <p className="text-sm text-foreground/85">
              You have no key. A key lets a script or AI assistant read your tickets and reply in your name, with your signature, from outside the app.
            </p>
            {expired && <p className="text-xs text-muted-foreground">Your key “{expired.name}” {expiryWords(expired).replace(/^Expired/, 'expired')}.</p>}
            {canCreate ? (
              <button type="button" onClick={() => { setCreating(true); setError(null); setNotice(null); }} className={btnPrimary}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Create a key
              </button>
            ) : (
              <p className="text-sm text-muted-foreground">{info.reason || 'You cannot create a key right now.'}</p>
            )}
          </div>
        )}

        {info.enabled && (
          <div className="border-t border-border pt-4">
            <AssistantGuide />
          </div>
        )}
      </div>
    </section>
  );
}
