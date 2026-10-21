// One run, read the same way everywhere (18 Oct 2026): the Mail Workflows
// Preview page and the Workflow Audit detail both render this.
//
//   ┌ summary line: status · ticket · audit id · time · model · Send test ┐
//   ├ pipeline: every step as a chip (✓ / spinner / ⚠ / ✗ / not reached) ┤
//   ├──────────── wide: e-mail + LLM output ────────────┬─ narrow rail ───┤
//   │ subject, recipients, the e-mail as it will look,  │ issues, steps   │
//   │ then each LLM step: model, tokens, guard, prompt, │ checklist,      │
//   │ what it wrote, tool calls, evidence               │ action blocks,  │
//   └───────────────────────────────────────────────────┴─ routing, ... ──┘
//
// It takes a plain model (built by NotificationWorkflowsPanel from a preview
// response or an audit run), so it imports nothing from the panel.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Clipboard,
  Code,
  Mail,
  Monitor,
  RefreshCw,
  Send,
  Smartphone,
  Wrench,
  XCircle,
} from 'lucide-react';

function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

function formatJson(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes} m ${seconds} s`;
}

function sanitizeHtml(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

// Step state → one of: done, warn, failed, running, pending, skipped.
function stepVisualState(step) {
  if (!step) return 'pending';
  if (step.issue?.tone === 'red' || step.status === 'failed') return 'failed';
  if (step.status === 'running' || step.status === 'queued') return 'running';
  if (step.status === 'not_reached' || step.status === 'pending') return step.status === 'pending' ? 'pending' : 'skipped';
  if (step.issue?.tone === 'amber') return 'warn';
  return 'done';
}

const STATE_META = {
  done: { Icon: CheckCircle2, icon: 'text-emerald-600 dark:text-emerald-300', label: 'Done' },
  warn: { Icon: AlertTriangle, icon: 'text-amber-600 dark:text-amber-300', label: 'Needs a look' },
  failed: { Icon: XCircle, icon: 'text-red-600 dark:text-red-300', label: 'Failed' },
  running: { Icon: RefreshCw, icon: 'animate-spin text-primary', label: 'Running' },
  pending: { Icon: Circle, icon: 'text-muted-foreground/60', label: 'Waiting' },
  skipped: { Icon: CircleDashed, icon: 'text-muted-foreground/50', label: 'Not reached' },
};

function StepIcon({ state, className = 'h-4 w-4' }) {
  const meta = STATE_META[state] || STATE_META.pending;
  const { Icon } = meta;
  return <Icon className={cls('shrink-0', className, meta.icon)} aria-hidden="true" />;
}

const TONE_TEXT = {
  red: 'text-red-700 dark:text-red-200',
  amber: 'text-amber-800 dark:text-amber-200',
  blue: 'text-blue-800 dark:text-blue-200',
  gray: 'text-muted-foreground',
  emerald: 'text-emerald-700 dark:text-emerald-200',
};

function ToneIcon({ tone, className = 'mt-0.5 h-3.5 w-3.5' }) {
  if (tone === 'red') return <XCircle className={cls('shrink-0 text-red-600 dark:text-red-300', className)} aria-hidden="true" />;
  if (tone === 'amber') return <AlertTriangle className={cls('shrink-0 text-amber-600 dark:text-amber-300', className)} aria-hidden="true" />;
  if (tone === 'emerald') return <CheckCircle2 className={cls('shrink-0 text-emerald-600 dark:text-emerald-300', className)} aria-hidden="true" />;
  return <AlertCircle className={cls('shrink-0 text-blue-600 dark:text-blue-300', className)} aria-hidden="true" />;
}

function RailSection({ title, count, children, testId }) {
  return (
    <section className="border-b border-border/60 px-4 py-3 last:border-b-0" data-testid={testId}>
      <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {count != null && <span className="font-mono text-muted-foreground/75">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function Fact({ label, value, tone }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label}</dt>
      <dd className={cls('mt-0.5 truncate text-xs font-semibold', tone ? TONE_TEXT[tone] : 'text-foreground')} title={String(value)}>{value}</dd>
    </div>
  );
}

// ── Pipeline ──────────────────────────────────────────────────────────────

export function RunPipeline({ steps = [], activeKey, onSelect }) {
  const scrollerRef = useRef(null);
  const runningKey = steps.find((step) => stepVisualState(step) === 'running')?.key;
  useEffect(() => {
    // Keep the step that is running in view while a long pipeline fills in.
    if (!runningKey || !scrollerRef.current) return;
    const el = scrollerRef.current.querySelector(`[data-step-key="${String(runningKey).replace(/"/g, '')}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [runningKey]);
  if (!steps.length) return null;
  return (
    <div
      ref={scrollerRef}
      className="settings-scrollbar flex items-center gap-1 overflow-x-auto px-4 py-2"
      role="list"
      aria-label="Workflow pipeline"
      data-testid="run-pipeline"
    >
      {steps.map((step, index) => {
        const state = stepVisualState(step);
        const duration = formatDuration(step.durationMs);
        return (
          <React.Fragment key={step.key}>
            {index > 0 && (
              <ChevronRight
                className={cls('h-3.5 w-3.5 shrink-0', state === 'skipped' || state === 'pending' ? 'text-muted-foreground/40' : 'text-muted-foreground/75')}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              role="listitem"
              data-step-key={step.key}
              data-state={state}
              onClick={() => onSelect?.(step.key)}
              title={`${step.typeLabel}${step.name && step.name !== step.typeLabel ? `: ${step.name}` : ''} — ${STATE_META[state].label}${duration ? ` · ${duration}` : ''}`}
              className={cls(
                'tp-focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                activeKey === step.key ? 'bg-primary/10 text-foreground ring-1 ring-primary/30' : 'hover:bg-muted',
                state === 'skipped' || state === 'pending' ? 'text-muted-foreground/75' : 'text-foreground/85',
              )}
            >
              <StepIcon state={state} className="h-3.5 w-3.5" />
              <span className="max-w-[160px] truncate font-medium">{step.name || step.typeLabel}</span>
              {duration && <span className="font-mono text-[10px] text-muted-foreground/75">{duration}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── E-mail ────────────────────────────────────────────────────────────────

function EmailFrame({ html, device }) {
  const frameRef = useRef(null);
  const [height, setHeight] = useState(520);
  const srcDoc = useMemo(() => sanitizeHtml(html), [html]);
  const fit = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const body = doc?.body;
      if (!body) return;
      // The body's own extent (plus its margins), not the document's, which
      // never reads smaller than the frame it sits in.
      const style = doc.defaultView?.getComputedStyle?.(body);
      const margins = (parseFloat(style?.marginTop) || 0) + (parseFloat(style?.marginBottom) || 0);
      const next = Math.ceil(body.getBoundingClientRect().height + margins);
      if (next > 0) setHeight(Math.min(Math.max(next + 4, 160), 6000));
    } catch { /* opaque frame: keep the default height */ }
  };
  useEffect(() => {
    // Re-measure when the device width changes the e-mail's wrapping.
    const handle = window.setTimeout(fit, 60);
    return () => window.clearTimeout(handle);
  }, [device, srcDoc]);
  return (
    <iframe
      ref={frameRef}
      title="Rendered email"
      // Same-origin so the page can measure its height; no scripts run.
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={fit}
      style={{ height }}
      className={cls(
        'tp-light mx-auto block rounded-md border border-border bg-card shadow-subtle transition-[width] duration-200',
        device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full max-w-[760px]',
      )}
      data-testid="run-email-frame"
    />
  );
}

function recipientText(values) {
  return (values || []).length ? values.join(', ') : 'None';
}

function EmailBlock({ email, recipients, emptyText, pending }) {
  const [device, setDevice] = useState('desktop');
  const [view, setView] = useState('rendered');
  const hasBody = Boolean(email?.html || email?.text);
  return (
    <section className="px-5 py-4" data-testid="run-email">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            E-mail
          </div>
          <div className="mt-1 text-base font-semibold leading-snug text-foreground [text-wrap:balance]">
            {email?.subject || (pending ? 'Waiting for the run…' : 'No e-mail rendered')}
          </div>
          {!(pending && !email) && (
            <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
              {[['To', recipients?.to], ['Cc', recipients?.cc], ['Bcc', recipients?.bcc]]
                .filter(([label, values]) => label === 'To' || (values || []).length > 0)
                .map(([label, values]) => (
                  <React.Fragment key={label}>
                    <dt className="font-semibold text-muted-foreground">{label}</dt>
                    <dd className={cls('min-w-0 break-words', label === 'To' && !(values || []).length ? 'text-amber-700 dark:text-amber-200' : 'text-foreground/85')}>
                      {recipientText(values)}
                    </dd>
                  </React.Fragment>
                ))}
            </dl>
          )}
        </div>
        {hasBody && (
          <div className="flex shrink-0 items-center gap-1">
            {email?.html && email?.text && (
              <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label="E-mail view">
                {[['rendered', 'Rendered'], ['text', 'Plain text']].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setView(value)}
                    aria-pressed={view === value}
                    className={cls('tp-focus-ring rounded px-2 py-1 text-[11px] font-semibold', view === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {email?.html && view === 'rendered' && (
              <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label="E-mail width">
                {[['desktop', Monitor, 'Desktop width'], ['mobile', Smartphone, 'Phone width']].map(([value, Icon, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDevice(value)}
                    aria-pressed={device === value}
                    aria-label={label}
                    title={label}
                    className={cls('tp-focus-ring rounded p-1', device === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-3 rounded-lg bg-muted/60 p-3 sm:p-4">
        {!hasBody && (
          <div className="flex min-h-[160px] items-center justify-center gap-2 text-sm text-muted-foreground">
            {pending && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {pending ? 'The e-mail appears here when the run reaches it.' : (emptyText || 'This run did not render an e-mail.')}
          </div>
        )}
        {hasBody && view === 'rendered' && email.html && <EmailFrame html={email.html} device={device} />}
        {hasBody && (view === 'text' || !email.html) && (
          <pre className="mx-auto max-w-[760px] whitespace-pre-wrap tp-light rounded-md border border-border bg-card p-4 font-sans text-sm leading-6 text-foreground shadow-subtle">{email.text}</pre>
        )}
      </div>
    </section>
  );
}

// ── LLM output ────────────────────────────────────────────────────────────

function guardSummary(llm) {
  const guard = llm?.guard;
  if (!guard) return null;
  const repaired = guard.repairedIssues || [];
  const auditOnly = guard.auditOnlyIssues || [];
  const describe = (issues) => issues.map((issue) => issue.beforeAfterSummary || issue.message || issue.ruleId || issue.id).filter(Boolean).join('; ');
  if (guard.accepted === false) return { tone: 'red', label: 'Blocked', detail: (guard.issues || []).join('; ') || 'The guard blocked this output.' };
  if (repaired.length) return { tone: 'amber', label: 'Repaired', detail: describe(repaired) };
  if (auditOnly.length) return { tone: 'blue', label: 'Audit warning', detail: describe(auditOnly) };
  return { tone: 'emerald', label: 'Passed', detail: null };
}

function guardCheckStatus(guardPolicy, checks, { repairLabel = 'Repair + audit', auditLabel = null, fallback = null } = {}) {
  const has = (list) => (list || []).some((check) => checks.includes(check));
  if (has(guardPolicy.disabledChecks)) return 'Off';
  if (has(guardPolicy.repairChecks)) return repairLabel;
  if (has(guardPolicy.hardBlocks)) return 'Block';
  if (auditLabel && has(guardPolicy.auditOnlyChecks)) return auditLabel;
  return fallback;
}

function LlmOutputBlock({ diagnostic, index, total }) {
  const llm = diagnostic.llm || {};
  const email = diagnostic.email || llm.email || null;
  const tokens = llm.tokenDiagnostics || null;
  const promptPolicy = llm.promptPolicy || {};
  const guardPolicy = llm.guardPolicy || {};
  const guard = guardSummary(llm);
  const failed = llm.failed || diagnostic.status === 'failed';
  const toolCount = Array.isArray(llm.toolEvents) ? llm.toolEvents.length : 0;
  const duration = formatDuration(diagnostic.durationMs ?? llm.durationMs);
  const model = [llm.provider, llm.model].filter(Boolean).join(' · ');
  const toneGuard = guardCheckStatus(guardPolicy, ['emoji', 'playful_tone'], {
    repairLabel: `${guardPolicy.toneMode || 'professional'} · repair`,
    auditLabel: `${guardPolicy.toneMode || 'friendly'} · audit`,
    fallback: guardPolicy.toneMode || null,
  });
  const timingGuard = guardCheckStatus(guardPolicy, ['unsupported_timing_claims']);
  const alerts = [
    failed && { tone: 'red', text: llm.error || 'The LLM output did not pass validation.' },
    llm.tokenLimitHit && { tone: 'amber', text: llm.tokenLimitWarning || 'Generation reached the output token cap.' },
    !llm.tokenLimitHit && tokens?.nearTokenLimit && { tone: 'amber', text: `Used ${tokens.outputLimitPercent}% of the output token cap.` },
    llm.fallbackUsed && { tone: 'amber', text: `Fallback provider used${llm.fallbackReason ? `: ${llm.fallbackReason}` : '.'}` },
    (llm.repairedFields || []).length > 0 && { tone: 'amber', text: `Repaired missing field${llm.repairedFields.length === 1 ? '' : 's'}: ${llm.repairedFields.join(', ')}.` },
    guard && guard.tone !== 'emerald' && guard.detail && { tone: guard.tone, text: `Guard ${guard.label.toLowerCase()}: ${guard.detail}` },
    diagnostic.toneOverrideText && { tone: 'blue', text: `Professional tone used — ${diagnostic.toneOverrideText}` },
  ].filter(Boolean);
  const wroteText = email?.text || '';
  const wroteHtml = !wroteText && email?.html ? email.html : '';

  return (
    <section className="border-t border-border/60 px-5 py-4" data-testid="run-llm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Bot className="h-4 w-4 text-violet-600 dark:text-violet-300" aria-hidden="true" />
        <h4 className="text-sm font-semibold text-foreground">
          LLM output{total > 1 ? ` ${index + 1} of ${total}` : ''}
        </h4>
        {diagnostic.name && <span className="truncate text-xs text-muted-foreground">{diagnostic.name}</span>}
        <span className={cls('ml-auto inline-flex items-center gap-1 text-xs font-semibold', failed ? TONE_TEXT.red : TONE_TEXT.emerald)}>
          {failed ? <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
          {failed ? 'Failed' : 'Completed'}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-2.5">
        <Fact label="Model" value={model || 'Not recorded'} />
        <Fact label="Time" value={duration} />
        <Fact
          label="Output tokens"
          value={tokens ? `${tokens.outputTokens || 0}${tokens.requestedMaxTokens ? ` / ${tokens.requestedMaxTokens}` : ''}` : null}
          tone={llm.tokenLimitHit ? 'amber' : null}
        />
        <Fact label="Tool calls" value={toolCount} />
        <Fact label="Guard" value={guard?.label} tone={guard?.tone === 'emerald' ? null : guard?.tone} />
        <Fact label="Prompt" value={promptPolicy.source || promptPolicy.customSystemPromptUsed !== undefined ? (promptPolicy.customSystemPromptUsed ? 'Custom' : 'Default') : null} />
        <Fact label="Prompt source" value={promptPolicy.source} />
        <Fact label="Tone guard" value={toneGuard} />
        <Fact label="Timing claims" value={timingGuard} />
        <Fact label="Output mode" value={llm.outputMode || null} />
        <Fact label="Promoted to e-mail" value={llm.promotedToEmail === false ? 'No' : (llm.outputMode ? 'Yes' : null)} />
        <Fact label="Fallback" value={llm.fallbackUsed ? 'Used' : null} tone="amber" />
      </dl>

      {alerts.length > 0 && (
        <ul className="mt-3 space-y-1">
          {alerts.map((alert, alertIndex) => (
            <li key={alertIndex} className={cls('flex gap-1.5 text-xs leading-5', TONE_TEXT[alert.tone])}>
              <ToneIcon tone={alert.tone} />
              <span>{alert.text}</span>
            </li>
          ))}
        </ul>
      )}

      {(email?.subject || wroteText || wroteHtml) && (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What it wrote</div>
          {email?.subject && <div className="mt-1 text-sm font-semibold text-foreground">{email.subject}</div>}
          {wroteText && (
            <div className="mt-1.5 max-w-[72ch] whitespace-pre-wrap text-sm leading-6 text-foreground/85">{wroteText}</div>
          )}
          {wroteHtml && (
            <div className="mt-1.5 max-w-[72ch] text-sm leading-6 text-foreground/85" dangerouslySetInnerHTML={{ __html: sanitizeHtml(wroteHtml) }} />
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        {diagnostic.prompt && (
          <details className="group rounded-md border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-semibold text-foreground/85">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              Prompt sent
            </summary>
            <pre className="settings-scrollbar max-h-[50vh] overflow-auto whitespace-pre-wrap border-t border-border/60 bg-muted/50 p-3 text-[11px] leading-5 text-foreground/85">{diagnostic.prompt}</pre>
          </details>
        )}
        {(llm.raw || diagnostic.rawOutput) && (
          <details className="group rounded-md border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-semibold text-foreground/85">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              Raw output
            </summary>
            <pre className="settings-scrollbar max-h-[50vh] overflow-auto bg-slate-950 p-3 text-[11px] leading-5 text-white/90 dark:ring-1 dark:ring-white/10">{formatJson(llm.raw || diagnostic.rawOutput)}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

function ToolCalls({ tools }) {
  if (!tools?.length) return null;
  return (
    <section className="border-t border-border/60 px-5 py-4" data-testid="run-tools">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Wrench className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Tool calls
        <span className="font-mono text-xs text-muted-foreground">{tools.length}</span>
      </h4>
      <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border">
        {tools.map((tool, index) => (
          <li key={`${tool.name}-${index}`}>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                <StepIcon state={tool.status === 'failed' ? 'failed' : 'done'} className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate font-mono font-semibold text-foreground/85">{tool.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(tool.durationMs)}</span>
              </summary>
              <div className="grid gap-2 border-t border-border/60 p-2 lg:grid-cols-2">
                {[['Input', tool.input], ['Output', tool.output]].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
                    <pre className="settings-scrollbar max-h-64 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-5 text-white/90 dark:ring-1 dark:ring-white/10">{formatJson(value) || '—'}</pre>
                  </div>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceBlock({ context, signalLabel }) {
  if (!context) return null;
  return (
    <section className="border-t border-border/60 px-5 py-4" data-testid="run-evidence">
      <h4 className="text-sm font-semibold text-foreground">Evidence the LLM saw</h4>
      <dl className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-2.5">
        <Fact label="Mode" value={context.mode || 'Not recorded'} />
        <Fact label="Signal" value={signalLabel ? signalLabel(context.signalLevel || 'none') : context.signalLevel} />
        <Fact label="Thread entries" value={context.threadEntryCount || 0} />
        <Fact label="Redactions" value={context.redactionCount || 0} />
        <Fact label="Context hash" value={context.contextHash} />
      </dl>
      {context.signalRationale && (
        <p className="mt-2 max-w-[80ch] text-xs leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground/85">
            Signal confidence {context.signalConfidence || 'unknown'}
            {Number.isFinite(Number(context.signalConfidenceScore)) ? ` (${context.signalConfidenceScore})` : ''}:
          </span>{' '}
          {context.signalRationale}
          {context.signalCounts && (
            <span className="block text-muted-foreground/75">
              Similar {context.signalCounts.similarTickets || 0} · open strong {context.signalCounts.openStrongSimilarTickets || 0} · requesters {context.signalCounts.distinctRequesters || 0} · departments {context.signalCounts.distinctDepartments || 0}
            </span>
          )}
        </p>
      )}
      {(context.allowedPublicPhrases || []).length > 0 && (
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Allowed wording: {context.allowedPublicPhrases.join('; ')}</p>
      )}
    </section>
  );
}

// ── Rail ──────────────────────────────────────────────────────────────────

function StepChecklist({ steps, openKey, onToggle }) {
  return (
    <ol className="-mx-1.5 space-y-0.5" data-testid="run-steps">
      {steps.map((step) => {
        const state = stepVisualState(step);
        const open = openKey === step.key;
        const canOpen = state !== 'skipped' && state !== 'pending';
        return (
          <li key={step.key} id={`run-step-${step.key}`} data-state={state}>
            <button
              type="button"
              onClick={() => canOpen && onToggle(open ? null : step.key)}
              aria-expanded={canOpen ? open : undefined}
              disabled={!canOpen}
              className={cls(
                'tp-focus-ring flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left',
                canOpen ? 'hover:bg-muted' : 'cursor-default',
                open && 'bg-muted',
              )}
            >
              <StepIcon state={state} className="mt-0.5 h-3.5 w-3.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={cls('min-w-0 flex-1 truncate text-xs font-semibold', state === 'skipped' || state === 'pending' ? 'text-muted-foreground/75' : 'text-foreground/85')}>
                    {step.name || step.typeLabel}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/75">
                    {state === 'skipped' ? 'not reached' : formatDuration(step.durationMs) || ''}
                  </span>
                </span>
                {(step.issue?.detail || step.summary) && state !== 'skipped' && state !== 'pending' && (
                  <span className={cls('mt-0.5 block text-[11px] leading-4', step.issue ? TONE_TEXT[step.issue.tone] : 'text-muted-foreground', !open && 'line-clamp-2')}>
                    {step.issue?.detail || step.summary}
                  </span>
                )}
              </span>
              {canOpen && <ChevronDown className={cls('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/75 transition-transform', open && 'rotate-180')} aria-hidden="true" />}
            </button>
            {open && (
              <div className="ml-6 mt-1 space-y-1.5 pb-1.5">
                {step.name && step.name !== step.typeLabel && (
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/75">{step.typeLabel} · {step.nodeId}</div>
                )}
                {step.error && <div className="text-[11px] text-red-700 dark:text-red-200">{step.error}</div>}
                {step.hasPayload ? (
                  [['Input', step.input], ['Output', step.output]].map(([label, value]) => (
                    <div key={label}>
                      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
                      <pre className="settings-scrollbar max-h-56 overflow-auto rounded bg-slate-950 p-2 text-[10px] leading-4 text-white/90 dark:ring-1 dark:ring-white/10">{formatJson(value) || '—'}</pre>
                    </div>
                  ))
                ) : (
                  <div className="text-[11px] text-muted-foreground">Input and output arrive when the run finishes.</div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Checklist({ items }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-2 text-xs">
          <ToneIcon tone={item.tone} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-foreground/85">{item.label}</span>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">{item.state}</span>
            </span>
            {item.detail && <span className="mt-0.5 block leading-4 text-muted-foreground">{item.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function actionBlockItems(diagnostics) {
  return [
    ['publicStatus', 'Public status'],
    ['raiseUrgency', 'Raise urgency'],
    ['afterHoursSupport', 'After-hours support'],
  ]
    .map(([key, label]) => ({ key, label, diagnostic: diagnostics?.[key] }))
    .filter((item) => item.diagnostic?.requested)
    .map(({ key, label, diagnostic }) => {
      const applied = diagnostic.applied && !diagnostic.skipped;
      const extra = key === 'afterHoursSupport' && diagnostic.hasActiveContact
        ? ` Active contact${diagnostic.phoneVerified ? ' with verified phone' : ''}${diagnostic.rotationLabel ? ` (${diagnostic.rotationLabel})` : ''}.`
        : '';
      return {
        key,
        label,
        tone: diagnostic.skipped ? 'amber' : diagnostic.forced || diagnostic.warning ? 'blue' : applied ? 'emerald' : 'gray',
        state: diagnostic.skipped ? 'Skipped' : diagnostic.forced ? 'Shown for test' : applied ? 'Shown' : 'Checked',
        detail: `${diagnostic.reason || diagnostic.warning || (diagnostic.forced && diagnostic.liveWouldSkipReason ? `A live send would skip it: ${diagnostic.liveWouldSkipReason}` : '') || ''}${extra}`.trim() || null,
      };
    });
}

function brandingItems(branding) {
  return [
    ['header', 'Header'],
    ['footer', 'Footer / sign-off'],
  ]
    .map(([key, label]) => ({ key, label, diagnostic: branding?.[key] }))
    .filter((item) => item.diagnostic?.requested)
    .map(({ key, label, diagnostic }) => ({
      key,
      label,
      tone: diagnostic.applied ? (diagnostic.fallback ? 'blue' : 'emerald') : 'amber',
      state: diagnostic.applied ? (diagnostic.fallback ? 'Default used' : 'Applied') : 'Skipped',
      detail: [diagnostic.blockName || diagnostic.reason || (diagnostic.applied ? 'Workspace default' : null), diagnostic.warning].filter(Boolean).join(' · ') || null,
    }));
}

function RoutingLine({ routing }) {
  if (!routing) return null;
  const ok = routing.wouldRunSelectedWorkflow;
  const ruleMissed = routing.ownRule?.present && routing.ownRule.matched === false;
  const headline = ok
    ? 'This ticket matches this workflow'
    : ruleMissed
      ? (routing.ignoredRouting ? 'Previewed anyway: the routing rule does not match this ticket' : 'The routing rule does not match this ticket')
      : routing.fallbackWorkflowId
        ? 'This ticket falls back to the default variant'
        : 'This ticket is routed to a different variant';
  return (
    <div className="flex items-start gap-2 text-xs">
      <ToneIcon tone={ok ? 'emerald' : 'amber'} />
      <div className="min-w-0">
        <div className="font-semibold text-foreground/85">{headline}</div>
        {routing.reason && <div className="mt-0.5 leading-4 text-muted-foreground">{routing.reason}</div>}
        {((routing.selectedWorkflowIds || []).length > 0 || routing.fallbackWorkflowId) && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/75">
            {(routing.selectedWorkflowIds || []).map((id) => `selected #${id}`).join(' · ')}
            {routing.fallbackWorkflowId ? `${(routing.selectedWorkflowIds || []).length ? ' · ' : ''}fallback #${routing.fallbackWorkflowId}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * QA 10-20 #8: the preview honours the routing rule. A ticket it does not
 * match stops here, the way a live run would, with what the rule wanted and
 * what this ticket has; "Preview it anyway" shows the e-mail regardless.
 */
function SkippedByRouting({ skipped, onRunAnyway, running }) {
  return (
    <section className="border-b border-border/60 px-5 py-4" data-testid="run-skipped" role="status">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5 text-sm">
          <p className="font-semibold text-foreground">Skipped: this ticket does not match the workflow&rsquo;s routing rule</p>
          <p className="text-muted-foreground">A live ticket like this one would not run this workflow, so the preview stops here.</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {skipped.ruleText && (
              <>
                <dt className="text-muted-foreground">Rule</dt>
                <dd className="font-medium text-foreground/85">{skipped.ruleText}</dd>
              </>
            )}
            {(skipped.fields || []).map((field) => (
              <React.Fragment key={field.label}>
                <dt className="text-muted-foreground">{field.label} on this ticket</dt>
                <dd className="font-mono font-semibold text-foreground/85">{field.value === null || field.value === undefined || field.value === '' ? 'empty' : String(field.value)}</dd>
              </React.Fragment>
            ))}
            {skipped.goesTo && (
              <>
                <dt className="text-muted-foreground">Runs instead</dt>
                <dd className="font-medium text-foreground/85">{skipped.goesTo}</dd>
              </>
            )}
          </dl>
          {onRunAnyway && (
            <button
              type="button"
              onClick={onRunAnyway}
              disabled={running}
              className="tp-focus-ring mt-1 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-semibold text-foreground/85 hover:bg-muted disabled:opacity-50"
            >
              Preview it anyway
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Summary line ──────────────────────────────────────────────────────────

function CopyId({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        } catch { setCopied(false); }
      }}
      className="tp-focus-ring inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copy audit ID"
    >
      <Clipboard className="h-3 w-3" aria-hidden="true" />
      {copied ? 'Copied' : value}
    </button>
  );
}

const RUN_STATE_TEXT = {
  skipped: { state: 'warn', label: 'Skipped by routing' },
  running: { state: 'running', label: 'Running' },
  queued: { state: 'running', label: 'Queued' },
  waiting: { state: 'pending', label: 'Waiting' },
  completed: { state: 'done', label: 'Completed' },
  failed: { state: 'failed', label: 'Failed' },
};

function RunSummary({ summary, onSendTest, testSending, canSendTest }) {
  if (!summary) return null;
  const runState = RUN_STATE_TEXT[summary.status] || { state: 'pending', label: summary.status || 'Not run' };
  const state = runState.state === 'done' && summary.issueTone === 'amber' ? 'warn' : runState.state;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" data-testid="run-summary">
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <StepIcon state={state} />
        {summary.issueTone === 'amber' && runState.state === 'done' ? 'Completed with notes' : runState.label}
      </span>
      {summary.ref && <span className="font-mono text-xs font-semibold text-muted-foreground">{summary.ref}</span>}
      {summary.subject && <span className="min-w-0 max-w-[48ch] truncate text-sm text-foreground/85" title={summary.subject}>{summary.subject}</span>}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {(summary.facts || []).filter(Boolean).map((fact) => (
          <span key={fact} className="whitespace-nowrap">{fact}</span>
        ))}
        {summary.badges}
        <CopyId value={summary.auditId} />
      </span>
      {onSendTest && (
        <button
          type="button"
          onClick={onSendTest}
          disabled={!canSendTest || testSending}
          className="tp-focus-ring ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-subtle hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          title={canSendTest ? 'Send this e-mail only to you' : 'No e-mail was rendered'}
        >
          {testSending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          Send test to me
        </button>
      )}
    </div>
  );
}

// ── The view ──────────────────────────────────────────────────────────────

/**
 * model: {
 *   summary: { status, ref, subject, auditId, facts: string[], badges, issueTone },
 *   steps: [{ key, nodeId, nodeType, typeLabel, name, status, durationMs, summary, issue, error, input, output, hasPayload }],
 *   email, recipients, pendingEmail,
 *   llm: diagnostics (+ name, toneOverrideText), tools, context,
 *   issues: [{ tone, title, detail }],
 *   actionLinks, branding, routing,
 *   health: { degraded, label, fallbackSummary, reasons }, warnings: [],
 *   eventContext, emptyEmailText, loadingDetail
 * }
 */
export default function RunResultView({
  model,
  onSendTest,
  testSending = false,
  testResult = null,
  signalLabel,
  running = false,
  // 'xl' where the view shares the screen (Audit's list beside it).
  wideAt = 'lg',
  className = '',
  // Preview only: run again with the routing rule ignored (QA 10-20 #8).
  onRunAnyway = null,
}) {
  const [openStep, setOpenStep] = useState(null);
  const wideXl = wideAt === 'xl';
  const steps = model?.steps || [];
  const issues = model?.issues || [];
  const actionItems = actionBlockItems(model?.actionLinks);
  const brandItems = brandingItems(model?.branding);
  const healthReasons = model?.health?.degraded ? (model.health.reasons || []) : [];
  const warnings = model?.warnings || [];
  const canSendTest = Boolean(model?.email && (model.email.html || model.email.text));
  const doneCount = steps.filter((step) => ['done', 'warn'].includes(stepVisualState(step))).length;
  const reachedCount = steps.filter((step) => !['skipped', 'pending'].includes(stepVisualState(step))).length;

  const selectStep = (key) => {
    setOpenStep(key);
    window.requestAnimationFrame(() => {
      document.getElementById(`run-step-${key}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
  };

  return (
    <div className={cls('flex min-h-0 flex-1 flex-col', className)} data-testid="run-result">
      <div className="shrink-0 border-b border-border/60">
        <RunSummary summary={model?.summary} onSendTest={onSendTest} testSending={testSending} canSendTest={canSendTest && !running} />
        {testResult && (
          <div className={cls('flex items-center gap-1.5 px-4 pb-2 text-xs font-semibold', testResult.type === 'error' ? TONE_TEXT.red : TONE_TEXT.emerald)} role="status">
            <ToneIcon tone={testResult.type === 'error' ? 'red' : 'emerald'} />
            {testResult.text}
          </div>
        )}
        <RunPipeline steps={steps} activeKey={openStep} onSelect={selectStep} />
      </div>

      <div
        className={cls(
          'grid min-h-0 flex-1',
          wideXl
            ? 'overflow-y-auto xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:overflow-hidden'
            // QA 10-20 #6: on a wide screen the checks rail takes a fair share instead of 360px.
            : 'overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_minmax(360px,30%)]',
        )}
      >
        <div className={cls('settings-scrollbar min-w-0', wideXl ? 'xl:min-h-0 xl:overflow-y-auto' : 'lg:min-h-0 lg:overflow-y-auto')} data-testid="run-main">
          {model?.loadingDetail && (
            <div className="flex items-center gap-2 px-5 pt-3 text-xs text-muted-foreground" role="status">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading run details
            </div>
          )}
          {model?.skipped && <SkippedByRouting skipped={model.skipped} onRunAnyway={onRunAnyway} running={running} />}
          {/* A run stopped by routing has no e-mail to show. */}
          {!model?.skipped && (
            <EmailBlock
              email={model?.email}
              recipients={model?.recipients}
              emptyText={model?.emptyEmailText}
              pending={running || model?.pendingEmail}
            />
          )}
          {(model?.llm || []).map((diagnostic, index) => (
            <LlmOutputBlock key={`${diagnostic.outputKey || diagnostic.nodeId || 'llm'}-${index}`} diagnostic={diagnostic} index={index} total={model.llm.length} />
          ))}
          {running && !(model?.llm || []).length && steps.some((step) => step.nodeType === 'llm_generate') && (
            <section className="flex items-center gap-2 border-t border-border/60 px-5 py-4 text-sm text-muted-foreground">
              <Bot className="h-4 w-4 text-violet-600 dark:text-violet-300" aria-hidden="true" />
              The LLM output appears here when its step finishes.
            </section>
          )}
          <ToolCalls tools={model?.tools} />
          <EvidenceBlock context={model?.context} signalLabel={signalLabel} />
        </div>

        <aside
          className={cls(
            'settings-scrollbar min-w-0 border-t border-border/60 bg-muted/20',
            wideXl ? 'xl:min-h-0 xl:overflow-y-auto xl:border-l xl:border-t-0' : 'lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0',
          )}
          data-testid="run-rail"
        >
          <RailSection title="Issues" count={issues.length || null} testId="run-issues">
            {issues.length === 0 ? (
              <div className={cls('flex items-center gap-1.5 text-xs', running ? 'text-muted-foreground' : TONE_TEXT.emerald)}>
                {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                {running ? 'Checking as the run goes' : 'Nothing to fix'}
              </div>
            ) : (
              <ul className="space-y-2">
                {issues.map((issue, index) => (
                  <li key={`${issue.title}-${index}`} className="flex gap-2 text-xs">
                    <ToneIcon tone={issue.tone} />
                    <span className="min-w-0">
                      <span className={cls('block font-semibold', TONE_TEXT[issue.tone] || 'text-foreground')}>{issue.title}</span>
                      {issue.detail && <span className="mt-0.5 block leading-4 text-muted-foreground">{issue.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </RailSection>

          {steps.length > 0 && (
            <RailSection title="Steps" count={`${doneCount}/${reachedCount || steps.length}`}>
              <StepChecklist steps={steps} openKey={openStep} onToggle={setOpenStep} />
            </RailSection>
          )}

          {actionItems.length > 0 && (
            <RailSection title="Action blocks">
              <Checklist items={actionItems} />
            </RailSection>
          )}

          {brandItems.length > 0 && (
            <RailSection title="Branding">
              <Checklist items={brandItems} />
            </RailSection>
          )}

          {model?.routing && (
            <RailSection title="Routing">
              <RoutingLine routing={model.routing} />
            </RailSection>
          )}

          {(warnings.length > 0 || healthReasons.length > 0 || model?.health?.fallbackSummary) && (
            <RailSection title={model?.health?.degraded ? `${model.health.label || 'Run health'}` : 'Run warnings'}>
              <ul className="space-y-1.5 text-xs">
                {model?.health?.fallbackSummary && (
                  <li className="flex gap-2"><ToneIcon tone="amber" /><span className="leading-4 text-muted-foreground"><span className="font-semibold text-foreground/85">Fallback:</span> {model.health.fallbackSummary.reason || model.health.fallbackSummary.type}</span></li>
                )}
                {healthReasons.map((reason, index) => (
                  <li key={`h-${index}`} className="flex gap-2">
                    <ToneIcon tone="amber" />
                    <span className="leading-4 text-muted-foreground">
                      <span className="font-semibold text-foreground/85">{reason.type || 'reason'}:</span> {reason.message || 'Review this run before live sends.'}
                      {reason.ruleIds?.length > 0 && <span> Rules: {reason.ruleIds.join(', ')}.</span>}
                    </span>
                  </li>
                ))}
                {warnings.map((warning, index) => (
                  <li key={`w-${index}`} className="flex gap-2">
                    <ToneIcon tone="amber" />
                    <span className="leading-4 text-muted-foreground">
                      <span className="font-semibold text-foreground/85">{warning.type || 'warning'}:</span> {warning.message || 'Review this run before enabling live sends.'}
                      {warning.templateFallbackUsed && <span> Template fallback was used.</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </RailSection>
          )}

          {model?.eventContext && (
            <RailSection title="Event context">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-foreground/85">
                  <Code className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Redacted context the run saw
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <pre className="settings-scrollbar mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[10px] leading-4 text-white/90 dark:ring-1 dark:ring-white/10">{formatJson(model.eventContext)}</pre>
              </details>
            </RailSection>
          )}
        </aside>
      </div>
    </div>
  );
}
