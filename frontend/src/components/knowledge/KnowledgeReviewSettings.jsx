import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import { Switch } from '../ui';
import { timeAgo } from '../tickets/ticketUi';
import { SettingsRow, SettingsSection } from './knowledgeUi';

/**
 * Knowledge → Settings → Reviews: the Monday "review due" e-mail to article
 * owners (Auto-help P1). People who can't manage Knowledge see it read-only.
 *
 * The "Knowledge sources" card above it (the FreshService solution-article
 * import) was removed on 26 Oct 2026 (QA 10-26 #7); Confluence keeps its own
 * card (ConfluenceSettings).
 */
export function KnowledgeReviews({ canManage = true }) {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    knowledgeGrowthAPI.getSettings()
      .then((res) => { if (!cancelled) setSettings(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the settings'); });
    return () => { cancelled = true; };
  }, []);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.updateSettings(patch);
      setSettings(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="kh-settings-reviews" title="Reviews" hint="Keeping articles true once they are published." testId="knowledge-reviews">
      {!settings && !error && (
        <SettingsRow>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
        </SettingsRow>
      )}
      {settings && (
        <SettingsRow>
          <Switch
            id="kg-digest"
            checked={settings.reviewDigestEnabled}
            disabled={!canManage || busy}
            onCheckedChange={(v) => save({ reviewDigestEnabled: v })}
            aria-label="Weekly review e-mail to article owners"
          />
          <label htmlFor="kg-digest" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Monday review e-mail to article owners</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              At 08:00 on Mondays each owner gets one e-mail listing their articles that are due for an accuracy check, grouped by category.
              {settings.reviewDigestSentAt ? ` Last sent ${timeAgo(settings.reviewDigestSentAt)}.` : ''} Owners always see their own list on the Articles tab.
            </span>
          </label>
          <span className={`hidden shrink-0 text-xs font-medium sm:block ${settings.reviewDigestEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
            {settings.reviewDigestEnabled ? 'On' : 'Off'}
          </span>
        </SettingsRow>
      )}
      {error && (
        <SettingsRow>
          <p className="text-xs text-destructive" role="alert">{error}</p>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

export default KnowledgeReviews;
