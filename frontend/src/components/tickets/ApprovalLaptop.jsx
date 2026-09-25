import { useState } from 'react';
import { AlertTriangle, Laptop, Loader2 } from 'lucide-react';
import LaptopPicker, { assetTitle, assetSpec } from './LaptopPicker';

/**
 * The Assetron laptop held for one approval request (24 Sep 2026): what it is,
 * who it is for, and where it stands. Admins and the original requester may
 * change the laptop or recipient while the request is open.
 */
const STATE = {
  reserved: { text: 'On hold in Assetron until this is decided', tone: 'text-amber-700 dark:text-amber-200' },
  assigned: { text: 'Assigned in Assetron', tone: 'text-emerald-700 dark:text-emerald-200' },
  released: { text: 'Hold released in Assetron', tone: 'text-muted-foreground' },
  failed: { text: 'Assetron refused the update — an admin needs to check it', tone: 'text-red-700 dark:text-red-200' },
};

export default function ApprovalLaptop({ hold = null, decided, canChange = false, onChange, requester }) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(null);
  const [recipient, setRecipient] = useState(null);
  const [saving, setSaving] = useState(false);

  if (!hold) return null;
  const a = hold.asset || {};
  const st = hold.state === 'reserved' && hold.pendingOutcome ? { text: `Telling Assetron: ${hold.pendingOutcome.toLowerCase()}${hold.attempts ? ` (retry ${hold.attempts})` : ''}`, tone: 'text-amber-700 dark:text-amber-200' } : (STATE[hold.state] || STATE.reserved);

  const save = async () => {
    if (!pick || !recipient?.email) return;
    setSaving(true);
    try {
      await onChange({ assetId: pick.id, recipient });
      setEditing(false); setPick(null);
    } finally { setSaving(false); }
  };

  return (
    <div className="border-b border-border/70 px-5 py-3" data-testid="approval-laptop">
      <div className="flex items-start gap-2.5">
        <Laptop className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-foreground">
            <span className="font-medium">{assetTitle(a)}</span>
            {a.assetTag || a.serialNumber ? <span className="text-muted-foreground"> · {a.assetTag || `S/N ${a.serialNumber}`}</span> : null}
            <span className="text-muted-foreground"> for </span>
            <span className="font-medium">{hold.recipient?.name || hold.recipient?.email}</span>
          </p>
          <p className="text-xs text-muted-foreground">{assetSpec(a)}{a.location ? ` · ${a.location}` : ''}</p>
          <p className={`mt-0.5 flex items-center gap-1 text-xs ${st.tone}`}>
            {hold.state === 'failed' && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
            {st.text}{hold.state === 'failed' && hold.lastError ? ` — ${hold.lastError}` : ''}
          </p>
        </div>
        {canChange && !decided && !editing && hold.state === 'reserved' && (
          <button type="button" onClick={() => { setEditing(true); setPick(null); setRecipient(hold.recipient?.email ? hold.recipient : (requester || null)); }}
            className="tp-focus-ring text-xs font-medium text-primary hover:underline">Change laptop or person</button>
        )}
      </div>
      {editing && (
        <div className="mt-3 rounded-lg border border-border p-3">
          <LaptopPicker recipient={recipient} onRecipient={setRecipient} value={pick} onChange={setPick} />
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={save} disabled={!pick || !recipient?.email || saving}
              className="tp-focus-ring inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-60">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Hold this laptop instead
            </button>
            <button type="button" onClick={() => setEditing(false)} className="tp-focus-ring rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50">Keep the current one</button>
          </div>
        </div>
      )}
    </div>
  );
}
