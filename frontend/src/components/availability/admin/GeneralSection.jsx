import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { availabilityAPI } from '../../../services/api';
import { BTN_PRIMARY, Field, MONTHS, SectionTitle, TEXTAREA, Toggle } from '../availabilityUi';

/** General: leave-year start, the two Outlook switches (off by default), the purpose notice. */

const pick = (s = {}) => ({
  yearStartMonth: Number(s.yearStartMonth) || 1,
  outlookEventsEnabled: Boolean(s.outlookEventsEnabled),
  autoRepliesEnabled: Boolean(s.autoRepliesEnabled),
  purposeNotice: s.purposeNotice || '',
});

export default function GeneralSection({ config, reload, toast }) {
  const [draft, setDraft] = useState(() => pick(config.settings));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(pick(config.settings)); }, [config.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(config.settings));
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      await availabilityAPI.updateSettings(draft);
      toast('Settings saved');
      reload();
    } catch (err) {
      toast(err?.message || 'Could not save', 'red');
    } finally {
      setSaving(false);
    }
  };

  const outlookHint = 'Each person still confirms on every request; needs Microsoft Graph consent before turning on.';

  return (
    <section aria-label="General" className="max-w-2xl space-y-5">
      <div>
        <SectionTitle hint="Balances reset at the start of this month.">Leave year</SectionTitle>
        <Field label="Leave year starts in" className="max-w-xs">
          <FancySelect value={String(draft.yearStartMonth)} onChange={(v) => set({ yearStartMonth: Number(v) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} aria-label="Leave year start month" />
        </Field>
      </div>

      <div className="border-t border-border pt-5">
        <SectionTitle hint="Both are off by default. When on, the booking form offers them as unticked boxes.">Outlook</SectionTitle>
        <div className="space-y-3">
          <Toggle checked={draft.outlookEventsEnabled} onChange={(v) => set({ outlookEventsEnabled: v })} label="Offer “Add to my Outlook calendar”" hint={outlookHint} />
          <Toggle checked={draft.autoRepliesEnabled} onChange={(v) => set({ autoRepliesEnabled: v })} label="Offer “Set my automatic reply”" hint={outlookHint} />
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <SectionTitle hint="Shown under the booking form, e.g. why the company records time away.">Purpose notice</SectionTitle>
        <textarea rows={3} className={TEXTAREA} value={draft.purposeNotice} onChange={(e) => set({ purposeNotice: e.target.value })} aria-label="Purpose notice" maxLength={1000} />
      </div>

      <div className="flex justify-end">
        <button type="button" className={BTN_PRIMARY} onClick={save} disabled={!dirty || saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save changes
        </button>
      </div>
    </section>
  );
}
