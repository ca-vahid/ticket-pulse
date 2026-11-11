import { useEffect, useId, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

const EMAIL_SHAPE = /^[^\s@<>+,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const MAX_ALIASES = 10;

/** Why this address cannot be added, or null when it can. */
export function aliasProblem(value, { mailboxAddress = '', aliases = [] } = {}) {
  const address = String(value || '').trim().toLowerCase();
  if (!address) return 'Type an e-mail address.';
  if (!EMAIL_SHAPE.test(address)) return `"${address}" is not an e-mail address.`;
  if (address === String(mailboxAddress || '').trim().toLowerCase()) return 'That is this mailbox’s own address.';
  if (aliases.includes(address)) return 'That address is already listed.';
  if (aliases.length >= MAX_ALIASES) return `A mailbox can have at most ${MAX_ALIASES} other addresses.`;
  return null;
}

/**
 * "Also known as" on a mailbox card (11 Nov 2026): the public addresses that
 * deliver into this mailbox (receivables@ → ar-tickets@). Mail sent or copied
 * to one of them is treated as sent to the mailbox, and none of them is ever
 * taken for a requester or a Cc.
 *
 * A plain list: one address per row with its own Remove, an add field, and a
 * quiet line of one-click suggestions taken from the mailbox's recent mail.
 */
export default function MailboxAliases({ mailbox, onChanged }) {
  const inputId = useId();
  const errorId = useId();
  const aliases = Array.isArray(mailbox?.aliases) ? mailbox.aliases : [];
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    let live = true;
    // Suggestions are a convenience: any failure simply offers none.
    Promise.resolve()
      .then(() => ticketsAPI.getMailboxAliasSuggestions(mailbox.id))
      .then((res) => { if (live) setSuggestions(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) setSuggestions([]); });
    return () => { live = false; };
  }, [mailbox.id]);

  const save = async (next) => {
    setBusy(true);
    setError(null);
    try {
      await ticketsAPI.updateMailbox(mailbox.id, { aliases: next });
      await onChanged?.();
      return true;
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'That could not be saved.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (value) => {
    const address = String(value || '').trim().toLowerCase();
    const problem = aliasProblem(address, { mailboxAddress: mailbox.address, aliases });
    if (problem) { setError(problem); return; }
    if (await save([...aliases, address])) setDraft('');
  };

  const offered = suggestions.filter((s) => s?.address && !aliases.includes(s.address));

  return (
    <div className="basis-full pl-5 pt-1" data-testid={`mailbox-aliases-${mailbox.id}`}>
      <p className="text-xs font-medium text-foreground">Also known as</p>
      <p className="text-[11px] text-muted-foreground">
        Other addresses that deliver into this mailbox. Mail sent or copied to one of them counts as sent to {mailbox.address}.
      </p>

      {aliases.length > 0 && (
        <ul className="mt-1.5 space-y-0.5" aria-label={`Other addresses of ${mailbox.address}`}>
          {aliases.map((address) => (
            <li key={address} className="flex items-center gap-2 text-sm text-foreground">
              <span className="break-all">{address}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => save(aliases.filter((a) => a !== address))}
                aria-label={`Remove ${address}`}
                title={`Remove ${address}`}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted tp-focus-ring disabled:opacity-60"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-1.5 flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); add(draft); }}
        noValidate
      >
        <label htmlFor={inputId} className="sr-only">Add another address of {mailbox.address}</label>
        <input
          id={inputId}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          placeholder="team-address@yourcompany.com"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
          className="w-64 max-w-full px-2.5 py-1.5 text-xs border border-input rounded-lg bg-card text-foreground placeholder:text-muted-foreground/75 tp-focus-ring"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted tp-focus-ring disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : null}
          Add
        </button>
      </form>
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>}

      {offered.length > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid={`mailbox-alias-suggestions-${mailbox.id}`}>
          Often on this mailbox&apos;s mail:{' '}
          {offered.map((s, i) => (
            <span key={s.address}>
              {i > 0 ? ', ' : ''}
              <button
                type="button"
                disabled={busy}
                onClick={() => add(s.address)}
                className="text-primary hover:underline rounded tp-focus-ring disabled:opacity-60"
              >
                Add {s.address}
              </button>
              {s.count ? ` (${s.count} e-mails)` : ''}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
