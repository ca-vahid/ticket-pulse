import { useEffect, useId, useState } from 'react';
import { CheckCheck, Code2, MessageSquareOff, RefreshCwOff } from 'lucide-react';
import ConditionGroupBuilder, { CG_FIELDS, sentenceValueLabel } from './ConditionGroupBuilder';
import SkipNoiseSwitch from './SkipNoiseSwitch';
import { Switch } from '../ui/switch';
import { conditionGroupPatch, visibleConditionGroup } from '../../utils/conditionNoise';
import { describeRuleReads, ruleConversionPatch } from '../../utils/conditionRuleShared';
import { REPLY_TRIGGER, conditionStepView, describeStep, stepSwitches, thanksSwitchPatch } from '../../utils/conditionStepView';

/**
 * The condition step's inspector (14 Oct 2026, "rules should be UI oriented").
 *
 *   1. One plain sentence of what the step checks.
 *   2. The step switches: Skip noise, and on "Requester replied" workflows
 *      (MEGA 11-14) "Don't reopen on a thank-you or out-of-office reply",
 *      "Resolve when the requester confirms it's done (waiting tickets)"
 *      (Off / Shadow / Live, 19 Nov 2026) and "Stop after 3 reopens by
 *      replies in a day".
 *   3. The conditions as builder rows, listing only the fields the trigger
 *      fills. A step that still carries a raw json-logic rule is shown as
 *      rows straight away when the rule converts (the panel writes the
 *      conversion into the draft; it is saved on publish). A rule that can
 *      not convert gets a clear notice, the code read-only, and "Edit as
 *      code" — the only place code is still typed.
 */

// QA 11-05: the step switches are the app's one switch (components/ui/switch).
function StepSwitch({ on, label, onToggle }) {
  return <Switch checked={on} aria-label={label} onCheckedChange={() => onToggle()} className="mt-0.5" />;
}

/** One switch row: icon, a bold label, one short line, the switch. */
function StepSwitchRow({ icon: Icon, label, help, on, onToggle, testId }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5" data-testid={testId}>
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? 'text-primary' : 'text-muted-foreground/60'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{label}</div>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <StepSwitch on={on} label={label} onToggle={onToggle} />
    </div>
  );
}

export const THANKS_SWITCH_LABEL = 'Don\'t reopen on a thank-you or out-of-office reply';
export const LOOP_GUARD_SWITCH_LABEL = 'Stop after 3 reopens by replies in a day';

/**
 * "Don't reopen on a thank-you or out-of-office reply" (`ignoreThanks`). A
 * step saved with the older `ignoreAutoHelpThanks` key shows it on; the first
 * toggle writes `ignoreThanks` and drops the old key.
 */
export function ThanksSwitch({ data, onPatch }) {
  const on = stepSwitches(data).thanks;
  return (
    <StepSwitchRow
      icon={MessageSquareOff}
      label={THANKS_SWITCH_LABEL}
      help={on ? 'Such a reply takes the False path, and the ticket says why.' : 'Every reply goes on to the conditions below.'}
      on={on}
      onToggle={() => onPatch(thanksSwitchPatch(!on))}
      testId="thanks-switch"
    />
  );
}
/** The pre-11-14 name, kept for imports. */
export const AutoHelpThanksSwitch = ThanksSwitch;

/** "Stop after 3 reopens by replies in a day" (`replyLoopGuard`). */
export function ReplyLoopGuardSwitch({ data, onPatch }) {
  const on = stepSwitches(data).loopGuard;
  return (
    <StepSwitchRow
      icon={RefreshCwOff}
      label={LOOP_GUARD_SWITCH_LABEL}
      help={on ? 'A 4th reopen within 24 hours takes the False path; the ticket asks a person to look.' : 'Replies can reopen the ticket any number of times.'}
      on={on}
      onToggle={() => onPatch({ replyLoopGuard: !on })}
      testId="loop-guard-switch"
    />
  );
}

export const CONFIRMED_DONE_LABEL = 'Resolve when the requester confirms it\'s done (waiting tickets)';
/** Off / Shadow / Live, worded for this step (the workflow editor's state dots). */
const CONFIRMED_DONE_CHOICES = Object.freeze([
  { value: 'off', label: 'Off', dot: 'bg-muted-foreground/40', help: 'A reply to a waiting ticket goes on to the conditions below, as before.' },
  { value: 'shadow', label: 'Shadow', dot: 'bg-amber-500', help: 'Waiting tickets still reopen. The ticket history records each one it would have resolved.' },
  { value: 'live', label: 'Live', dot: 'bg-emerald-500', help: 'When the requester says it\'s done, the ticket is resolved with a private note and the workflow stops here. No e-mail goes to the requester. FreshService-born tickets are only recorded.' },
]);

/**
 * "Resolve when the requester confirms it's done (waiting tickets)"
 * (`resolveConfirmedDone`, 19 Nov 2026). Off / Shadow / Live as the workflow
 * editor's own segmented control; a step saved before it existed is Off.
 */
export function ConfirmedDoneSwitch({ data, onPatch }) {
  const mode = stepSwitches(data).confirmedDone;
  const labelId = useId();
  const shown = CONFIRMED_DONE_CHOICES.find((c) => c.value === mode) || CONFIRMED_DONE_CHOICES[0];
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5" data-testid="confirmed-done-switch" data-mode={mode}>
      <CheckCheck className={`mt-0.5 h-4 w-4 flex-shrink-0 ${mode === 'off' ? 'text-muted-foreground/60' : 'text-primary'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground" id={labelId}>{CONFIRMED_DONE_LABEL}</div>
        <p className="text-xs text-muted-foreground">{shown.help}</p>
        <div role="radiogroup" aria-labelledby={labelId} className="mt-2 grid w-full max-w-[16rem] grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1">
          {CONFIRMED_DONE_CHOICES.map((c) => {
            const active = c.value === mode;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => { if (!active) onPatch({ resolveConfirmedDone: c.value }); }}
                className={`tp-focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-semibold ${active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                data-testid={`confirmed-done-${c.value}`}
              >
                <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
                {c.label}
              </button>
            );
          })}
        </div>
      </div>
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
  // The static catalog gives the new reply fields their names and types until
  // the shared module knows them; codes read as words.
  const sentence = describeStep(data, { fields: CG_FIELDS, valueLabel: sentenceValueLabel });
  const switches = stepSwitches(view);
  const isReply = triggerType === REPLY_TRIGGER;
  // Other triggers show a switch only while it is on, so it can be turned off.
  const showThanks = isReply || switches.thanks;
  const showLoopGuard = isReply || switches.loopGuard;
  const showConfirmedDone = isReply || switches.confirmedDone !== 'off';

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
      {showThanks && <ThanksSwitch data={view} onPatch={patch} />}
      {showConfirmedDone && <ConfirmedDoneSwitch data={view} onPatch={patch} />}
      {showLoopGuard && <ReplyLoopGuardSwitch data={view} onPatch={patch} />}
      {mode === 'code' ? (
        <RuleAsCodeNotice rule={data.rule} onApply={applyCode} />
      ) : (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-200">Conditions</div>
          <ConditionGroupBuilder
            value={visibleConditionGroup(view)}
            onChange={(group) => patch(conditionGroupPatch(view, group))}
            triggerType={triggerType}
          />
        </div>
      )}
    </div>
  );
}
