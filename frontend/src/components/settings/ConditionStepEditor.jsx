import { useEffect, useState } from 'react';
import { Code2, MessageSquareOff } from 'lucide-react';
import ConditionGroupBuilder from './ConditionGroupBuilder';
import SkipNoiseSwitch from './SkipNoiseSwitch';
import { conditionGroupPatch, visibleConditionGroup } from '../../utils/conditionNoise';
import { describeConditionStep, describeRuleReads, ruleConversionPatch } from '../../utils/conditionRuleShared';
import { REPLY_TRIGGER, conditionStepView } from '../../utils/conditionStepView';

/**
 * The condition step's inspector (14 Oct 2026, "rules should be UI oriented").
 *
 *   1. One plain sentence of what the step checks.
 *   2. The step switches: Skip noise, and on "Requester replied" workflows
 *      "Ignore a thank-you or out-of-office reply after an Auto-help close".
 *   3. The conditions as builder rows. A step that still carries a raw
 *      json-logic rule is shown as rows straight away when the rule converts
 *      (the panel writes the conversion into the draft; it is saved on
 *      publish). A rule that can not convert gets a clear notice, the code
 *      read-only, and "Edit as code" — the only place code is still typed.
 */

function Switch({ on, label, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={`tp-focus-ring relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

/** "Ignore a thank-you or out-of-office reply after an Auto-help close" (ignoreAutoHelpThanks). */
export function AutoHelpThanksSwitch({ data, onPatch }) {
  const on = data?.ignoreAutoHelpThanks === true;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5" data-testid="auto-help-thanks-switch">
      <MessageSquareOff className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? 'text-primary' : 'text-muted-foreground/60'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">Ignore a thank-you or out-of-office reply after an Auto-help close</div>
        <p className="text-xs text-muted-foreground">
          {on
            ? 'Within 7 days of an Auto-help close, a reply that reads as thanks or an automatic out-of-office takes the False path. So does one to any closed ticket when "A thank-you or out-of-office reply does not reopen" is on in Ticket Ops → When a requester replies. Checked before the conditions below.'
            : 'Every reply goes on to the conditions below, thank-yous after an Auto-help close included.'}
        </p>
      </div>
      <Switch on={on} label="Ignore a thank-you or out-of-office reply after an Auto-help close" onToggle={() => onPatch({ ignoreAutoHelpThanks: !on })} />
    </div>
  );
}

/**
 * A rule that can not be shown as rows: say so, show it read-only, and keep
 * "Edit as code" for this case only. Applying code that converts turns the
 * step into rows.
 */
export function RuleAsCodeNotice({ rule, onApply, what = 'step' }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(rule, null, 2));
  const [error, setError] = useState(null);
  useEffect(() => {
    setText(JSON.stringify(rule, null, 2));
    setError(null);
  }, [rule]);
  const reads = describeRuleReads(rule);

  const apply = () => {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      setEditing(false);
      onApply(parsed);
    } catch {
      setError('This is not valid JSON, so nothing was changed.');
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/10" data-testid="rule-as-code-notice">
      <div className="flex items-start gap-2">
        <Code2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">This {what} uses a rule written as code</p>
          <p className="text-xs text-muted-foreground">
            It can not be shown as conditions without changing what it does.{reads ? ` ${reads}` : ''}
          </p>
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Rule as code"
            spellCheck={false}
            className="h-44 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={apply} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background hover:bg-foreground/90">Apply</button>
            <button type="button" onClick={() => { setEditing(false); setText(JSON.stringify(rule, null, 2)); setError(null); }} className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          </div>
        </>
      ) : (
        <>
          <pre className="settings-scrollbar max-h-44 overflow-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] leading-4 text-foreground/85" aria-label="Rule as code (read-only)">{JSON.stringify(rule, null, 2)}</pre>
          <button type="button" onClick={() => setEditing(true)} className="text-xs font-medium text-primary hover:underline">Edit as code</button>
        </>
      )}
    </div>
  );
}

export default function ConditionStepEditor({ data = {}, triggerType = null, onPatch }) {
  const { mode, view, conversion } = conditionStepView(data);
  // Every edit made while the draft still holds the raw rule carries the
  // conversion with it, so the saved step is rows + switches, never both.
  const patch = (p) => onPatch({ ...(conversion || {}), ...p });
  const sentence = describeConditionStep(view);
  const showThanks = triggerType === REPLY_TRIGGER || view.ignoreAutoHelpThanks === true;

  const applyCode = (rule) => {
    const converted = ruleConversionPatch({ rule });
    onPatch(converted || { rule, conditionGroup: null });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm leading-5 text-foreground" data-testid="condition-sentence">
        {sentence || 'Continues when the rule written as code below is true.'}
      </p>
      {/* In code mode the switch shows only its own flag: reading the noise
          test out of a rule it can not convert would let "off" drop the code. */}
      <SkipNoiseSwitch data={mode === 'code' ? { skipNoise: view.skipNoise === true } : view} onPatch={patch} />
      {showThanks && <AutoHelpThanksSwitch data={view} onPatch={patch} />}
      {mode === 'code' ? (
        <RuleAsCodeNotice rule={data.rule} onApply={applyCode} />
      ) : (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-200">Conditions</div>
          <ConditionGroupBuilder
            value={visibleConditionGroup(view)}
            onChange={(group) => patch(conditionGroupPatch(view, group))}
          />
        </div>
      )}
    </div>
  );
}
