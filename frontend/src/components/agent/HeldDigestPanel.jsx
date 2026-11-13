import { useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { Switch } from '../ui/switch';

/**
 * Mail & alerts → Held e-mail digest (QA 11-12 #1): the 8:00 AM e-mail that
 * lists the workspace's held e-mail goes to every admin of the workspace.
 * This is each person's own switch, per workspace. It is stored as the
 * per-user preference `mail.heldDigest` ('on' | 'off'); no row means on.
 * Only people who receive the digest see the panel.
 */
export const HELD_DIGEST_PREF_KEY = 'mail.heldDigest';

export default function HeldDigestPanel({ workspaceId = null, workspaceName = '', receives = false }) {
  const [on, setOn] = useState(null); // null = not read yet
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!receives || !workspaceId) return undefined;
    let alive = true;
    setOn(null);
    setNote('');
    ticketsAPI.getQueuePreference(HELD_DIGEST_PREF_KEY)
      .then((res) => { if (alive) setOn((res?.data?.value ?? res?.value) !== 'off'); })
      .catch(() => { if (alive) { setOn(true); setNote('Could not read your setting. It is shown as on.'); } });
    return () => { alive = false; };
  }, [receives, workspaceId]);

  if (!receives || !workspaceId) return null;

  const change = async (next) => {
    const before = on;
    setOn(next);
    setBusy(true);
    setNote('');
    try {
      await ticketsAPI.setQueuePreference(HELD_DIGEST_PREF_KEY, next ? 'on' : 'off');
      setNote(next ? 'On. You will get the next morning list.' : 'Off. You will not get this e-mail for this workspace.');
    } catch {
      setOn(before);
      setNote('That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const where = workspaceName || 'this workspace';
  return (
    <section className="tp-card rounded-xl border border-border p-4 sm:p-5" aria-labelledby="held-digest-heading" data-testid="held-digest-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
            <MailWarning className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id="held-digest-heading" className="text-base font-bold text-foreground">Held e-mail digest</h3>
            <p className="text-xs text-muted-foreground">
              Each morning at 8:00, admins of {where} get one e-mail listing the e-mail Ticket Pulse could not file.
              This switch is yours alone, and only for {where}. The list stays on Tickets, Mail review either way.
            </p>
          </div>
        </div>
        <Switch
          checked={on === true}
          disabled={busy || on === null}
          aria-label={`Send me the held e-mail digest for ${where}`}
          onCheckedChange={(next) => change(Boolean(next))}
          data-testid="held-digest-toggle"
        />
      </div>
      {note && <p className="mt-3 text-xs text-muted-foreground" role="status" data-testid="held-digest-note">{note}</p>}
    </section>
  );
}
