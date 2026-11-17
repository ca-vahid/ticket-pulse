import { useEffect, useState } from 'react';
import { Bot, Plus, X } from 'lucide-react';
import { notificationWorkflowAPI } from '../../services/api';

/**
 * Mail Workflows: "Machine senders" (16 Nov 2026). Addresses that never get a
 * workflow e-mail: BambooHR's new-hire notices, Darktrace's alerts, no-reply
 * senders. Their tickets still open, get sorted and assigned as usual; only the
 * acknowledgement, "resolved" and reminder e-mails to them stop.
 *
 * Closed: one line naming the list. Open: one row per entry with Remove, a box
 * to add one, and a box to test an address.
 */
const KIND_LABEL = Object.freeze({
  address: 'this address',
  domain: 'anyone at this domain',
  word: 'any address with this in its name',
});

/** Same three shapes the server accepts; null when the text is none of them. */
export function cleanEntry(raw) {
  let v = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '');
  if (v.startsWith('*@')) v = v.slice(1);
  if (v.startsWith('*.')) v = v.slice(2);
  if (!v || v.length < 3 || v.length > 254 || !/^[a-z0-9._%+\-@]+$/.test(v)) return null;
  const at = v.indexOf('@');
  if (at > 0 && (v.indexOf('@', at + 1) !== -1 || !v.slice(at + 1).includes('.'))) return null;
  if (at === 0 && !v.slice(1).includes('.')) return null;
  // A word matches inside any address's name: a short one would catch real people.
  if (at === -1 && !v.includes('.') && v.length < 5) return null;
  return v;
}

export function kindOf(value) {
  const v = String(value || '');
  if (v.includes('@') && !v.startsWith('@')) return 'address';
  if (v.startsWith('@') || v.includes('.')) return 'domain';
  return 'word';
}

export function summary(entries = []) {
  if (!entries.length) return 'No machine senders: every requester can get workflow e-mails.';
  const names = entries.map((e) => e.value);
  const shown = names.slice(0, 4).join(', ');
  return `Workflows never e-mail ${shown}${names.length > 4 ? ` and ${names.length - 4} more` : ''}.`;
}

export default function WorkflowMachineSenders({ className = '' }) {
  const [list, setList] = useState(null);
  const [saved, setSaved] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [input, setInput] = useState('');
  const [testAddress, setTestAddress] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => notificationWorkflowAPI.getMachineSenders())
      .then((res) => {
        if (cancelled) return;
        setList(res?.data?.entries || []);
        setSaved(res?.data?.saved !== false);
      })
      .catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, []);

  const open = () => {
    setDraft((list || []).map((e) => e.value));
    setInput('');
    setTestResult(null);
    setError(null);
    setEditing(true);
  };

  const add = () => {
    const value = cleanEntry(input);
    if (!value) { setError('Enter an address (name@example.com), a domain (example.com) or a word of 5+ letters (noreply)'); return; }
    setError(null);
    setDraft((d) => (d.includes(value) ? d : [...d, value]));
    setInput('');
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await notificationWorkflowAPI.setMachineSenders(draft);
      setList(res?.data?.entries || []);
      setSaved(true);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const address = String(testAddress || '').trim();
    if (!address.includes('@')) { setTestResult({ error: 'Enter a full address' }); return; }
    // Against the list being edited, so a change can be tried before it is saved.
    const hit = draft.find((v) => {
      const a = address.toLowerCase();
      const local = a.slice(0, a.lastIndexOf('@'));
      const domain = a.slice(a.lastIndexOf('@') + 1);
      const kind = kindOf(v);
      if (kind === 'address') return a === v;
      if (kind === 'domain') { const d = v.replace(/^@/, ''); return domain === d || domain.endsWith(`.${d}`); }
      return local.includes(v);
    });
    setTestResult({ address, matchedBy: hit || null });
  };

  if (list === null) return null;

  return (
    <section className={`rounded-lg border border-border bg-card px-3 py-2 ${className}`} aria-label="Machine senders" data-testid="workflow-machine-senders">
      <div className="flex items-start gap-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          {!editing ? (
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-foreground">
              <span data-testid="machine-senders-summary">
                <strong className="font-semibold">Machine senders.</strong> {summary(list)}
                {!saved && <span className="text-muted-foreground"> (the standard list)</span>}
              </span>
              <button type="button" onClick={open} className="tp-focus-ring rounded px-1 text-xs font-medium text-primary hover:underline">
                Edit
              </button>
            </div>
          ) : (
            <div className="space-y-2" data-testid="machine-senders-form">
              <p className="text-xs text-muted-foreground">
                Workflows never e-mail these addresses: no acknowledgement, no &ldquo;resolved&rdquo;, no reminder. Their tickets still open and get assigned as usual.
              </p>
              <ul className="settings-scrollbar max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Machine senders list">
                {draft.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">Nothing on the list.</li>}
                {draft.map((v) => (
                  <li key={v} className="flex items-center gap-2 px-2 py-1 text-xs" data-testid="machine-sender-row">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{v}</span>
                    <span className="shrink-0 text-muted-foreground">{KIND_LABEL[kindOf(v)]}</span>
                    <button type="button" onClick={() => setDraft((d) => d.filter((x) => x !== v))} className="tp-focus-ring shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${v}`}>
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                  placeholder="name@example.com, example.com or noreply"
                  aria-label="Add a machine sender"
                  className="tp-focus-ring h-7 w-64 rounded-md border border-input bg-card px-2 text-xs text-foreground"
                />
                <button type="button" onClick={add} className="tp-focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:bg-muted">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  value={testAddress}
                  onChange={(e) => { setTestAddress(e.target.value); setTestResult(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); test(); } }}
                  placeholder="Test an address"
                  aria-label="Test an address"
                  className="tp-focus-ring h-7 w-64 rounded-md border border-input bg-card px-2 text-xs text-foreground"
                />
                <button type="button" onClick={test} className="tp-focus-ring h-7 rounded-md px-2 text-xs font-medium text-primary hover:bg-muted">Test</button>
                {testResult && (
                  <span className="text-muted-foreground" data-testid="machine-sender-test">
                    {testResult.error || (testResult.matchedBy
                      ? <>No workflow e-mails: matches <strong className="text-foreground">{testResult.matchedBy}</strong>.</>
                      : 'Gets workflow e-mails as usual.')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" disabled={busy} onClick={save} className="tp-focus-ring h-7 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)} className="tp-focus-ring h-7 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}
