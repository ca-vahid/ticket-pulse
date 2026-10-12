import { useEffect, useState } from 'react';
import { knowledgeAPI, knowledgeGrowthAPI } from '../../services/api';
import { timeAgo } from '../tickets/ticketUi';
import { reviewWords } from './coverageFormat';
import FancySelect from '../common/FancySelect';
import { Switch } from '../ui';
import { SettingsRow, SettingsSection } from './knowledgeUi';

/**
 * Knowledge → Settings → Who writes knowledge (plans/KNOWLEDGE_SIMPLIFY_PLAN.md
 * sections 7 and 8): the skill level that may write, the level that may
 * confirm an article as Checked, and whether agents are asked to save their
 * answer when they close a ticket (rarely, and only with a reason).
 */
const LEVELS = [
  { value: 'basic', label: 'Basic and up' },
  { value: 'intermediate', label: 'Intermediate and up' },
  { value: 'advanced', label: 'Advanced and up' },
  { value: 'expert', label: 'Expert only' },
];
const CAPS = [1, 2, 3].map((n) => ({ value: n, label: n === 1 ? 'Once a day at most' : `${n} times a day at most` }));

export default function ContributionSettings({ canManage = false }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => knowledgeAPI.steward()).then((res) => { if (!cancelled) setLast(res?.data?.last || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const reviewNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await knowledgeAPI.runSteward();
      setLast(res?.data || null);
    } catch (err) {
      setError(err?.message || 'The review could not run');
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    knowledgeGrowthAPI.getSettings()
      .then((res) => { if (!cancelled) setS(res?.data || null); })
      .catch(() => { if (!cancelled) setS(null); });
    return () => { cancelled = true; };
  }, []);

  if (!s) return null;
  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.updateSettings(patch);
      setS(res?.data || s);
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const off = busy || !canManage;

  return (
    <SettingsSection id="kh-settings-contribution" title="Who writes knowledge" hint="Decided by the skills people already have in each category. A skill in a category covers its subcategories. Workspace admins can always do everything." testId="contribution-settings">
      {error && <p className="px-4 py-2 text-sm text-red-700 dark:text-red-300 sm:px-5" role="alert">{error}</p>}
      <SettingsRow>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Can write and fix articles</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">What they publish is marked “Not checked yet” until someone at the level below confirms it, or two agents use it and judge the answer good.</p>
        </div>
        <div className="w-56 flex-shrink-0"><FancySelect value={s.publishLevel} onChange={(v) => save({ publishLevel: v })} options={LEVELS} disabled={off} aria-label="Can write and fix articles" data-testid="contribution-publish" /></div>
      </SettingsRow>
      <SettingsRow>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Can confirm an article as Checked</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Only Checked articles are used in answers that send by themselves. Never lower than the level that can write.</p>
        </div>
        <div className="w-56 flex-shrink-0"><FancySelect value={s.checkLevel} onChange={(v) => save({ checkLevel: v })} options={LEVELS} disabled={off} aria-label="Can confirm an article as Checked" data-testid="contribution-check" /></div>
      </SettingsRow>
      <SettingsRow>
        <Switch id="kh-ask-at-close" checked={s.askAtClose === true} disabled={off} onCheckedChange={(v) => save({ askAtClose: v })} aria-label="Ask agents to save their answer when they close a ticket" />
        <label htmlFor="kh-ask-at-close" className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm font-medium text-foreground">Ask agents to save their answer when they close a ticket</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            Only when it is worth asking: nothing in the Library covers the ticket, the same kind of request came in at least three times in 90 days, the agent wrote a real answer and has the skill for the category. “Not now” is remembered for a month.
          </span>
        </label>
        <div className="w-56 flex-shrink-0"><FancySelect value={s.askDailyCap} onChange={(v) => save({ askDailyCap: Number(v) })} options={CAPS} disabled={off || !s.askAtClose} aria-label="How often a person is asked" data-testid="contribution-cap" /></div>
      </SettingsRow>
      <SettingsRow>
        <Switch id="kh-steward" checked={s.stewardEnabled === true} disabled={off} onCheckedChange={(v) => save({ stewardEnabled: v })} aria-label="Review the Library every night" />
        <label htmlFor="kh-steward" className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm font-medium text-foreground">Review the Library every night</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            Looks for articles that say the same thing, articles nobody uses, articles past their review date that are still in use, questions that keep coming with nothing written, and places where agents now say something the article does not.
            It puts suggestions in the Inbox for people with the skill. It never changes an article by itself.
          </span>
          <span className="mt-1 block text-xs text-muted-foreground" data-testid="review-last">
            {last?.at ? `Last review ${timeAgo(last.at)}. ` : ''}{reviewWords(last)}
          </span>
        </label>
        {canManage && (
          <button type="button" disabled={running} onClick={reviewNow} className="tp-focus-ring h-9 flex-shrink-0 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50" data-testid="review-now">
            {running ? 'Reviewing…' : 'Review now'}
          </button>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
