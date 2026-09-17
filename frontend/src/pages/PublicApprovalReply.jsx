import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, CheckCircle2, CircleAlert, Clock, Link2Off, Moon, Send, Sun } from 'lucide-react';
import RichTextEditor, { isRichContent } from '../components/tickets/RichTextEditor';
import ApprovalThread from '../components/tickets/ApprovalThread';
import { publicApprovalAPI } from '../services/api';
import { usePublicTheme } from './publicApproval/usePublicTheme';
import { classifyLoadError } from './publicApproval/approvalMeta';

/**
 * Approvals v3 — the requester's / agent's reply page (/approval-reply/:token).
 * A personal link from a question e-mail: the question, the part of the
 * conversation this person may see, a mail-sized editor, Send. Same
 * server path as replying to the e-mail itself.
 */

function unwrapBody(res) {
  if (res && typeof res === 'object' && res.data && typeof res.data === 'object' && !('question' in res) && !('status' in res)) return res.data;
  return res;
}

const BRAND_MARK_CLASS = 'grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-primary to-violet-600 text-[12px] font-bold text-white shadow-subtle';

function Shell({ subtitle, theme, onToggleTheme, children }) {
  const dark = theme === 'dark';
  return (
    <div className="tp-approval-backdrop min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[860px] px-5 pb-16 pt-7">
        <header className="mb-[18px] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className={BRAND_MARK_CLASS} aria-hidden="true">TP</div>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold text-foreground">Ticket Pulse</p>
              <p className="text-xs text-muted-foreground">{subtitle || 'Approval question'}</p>
            </div>
          </div>
          <button type="button" onClick={onToggleTheme} aria-pressed={dark} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            {dark ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5" aria-hidden="true" />}
            {dark ? 'Light' : 'Dark'}
          </button>
        </header>
        <main id="approval-reply-main">{children}</main>
      </div>
    </div>
  );
}

function MessageCard({ icon: Icon, tone = 'muted', title, children }) {
  const toneClass = tone === 'danger' ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-200' : tone === 'warn' ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-200' : tone === 'ok' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-muted text-muted-foreground';
  return (
    <div className="tp-card mx-auto max-w-lg rounded-2xl px-6 py-10 text-center shadow-soft motion-on:animate-fadeIn" role="status">
      <span className={`mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full ${toneClass}`}><Icon className="h-6 w-6" aria-hidden="true" /></span>
      <h1 className="text-lg font-bold text-foreground">{title}</h1>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export default function PublicApprovalReply() {
  const { token } = useParams();
  const { theme, isDark, toggle } = usePublicTheme();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bodyText, setBodyText] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const editorRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    publicApprovalAPI.replyView(token)
      .then((res) => { if (!cancelled) { setData(unwrapBody(res)); setLoadError(null); } })
      .catch((err) => { if (!cancelled) setLoadError(classifyLoadError(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const send = useCallback(async () => {
    const text = bodyText.trim();
    if (!text) { setError('Type your answer first.'); editorRef.current?.focus(); return; }
    setSending(true); setError(null);
    try {
      const res = unwrapBody(await publicApprovalAPI.replySend(token, { bodyText: text, bodyHtml: text && isRichContent(bodyHtml) ? bodyHtml : null })) || {};
      setSent(res.message || { bodyText: text });
      setData((prev) => (prev && res.message ? { ...prev, thread: [...(prev.thread || []), res.message] } : prev));
      setBodyText(''); setBodyHtml('');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not send your answer. Try again.');
    } finally {
      setSending(false);
    }
  }, [bodyText, bodyHtml, token]);

  if (isLoading) {
    return (
      <Shell theme={theme} onToggleTheme={toggle}>
        <div className="tp-card rounded-2xl p-6 shadow-soft" aria-busy="true" aria-label="Loading">
          <div className="h-5 w-56 rounded bg-muted motion-on:animate-pulse" />
          <div className="mt-3 h-3 w-3/4 rounded bg-muted motion-on:animate-pulse" />
          <div className="mt-6 h-40 rounded-xl bg-muted motion-on:animate-pulse" />
        </div>
      </Shell>
    );
  }

  if (loadError || !data?.question) {
    const kind = loadError?.kind || 'error';
    return (
      <Shell theme={theme} onToggleTheme={toggle}>
        {kind === 'invalid' ? (
          <MessageCard icon={Link2Off} title="This reply link isn't valid">
            <p>The link may have been trimmed by your mail client, or the question no longer exists.</p>
            <p className="mt-1">You can always answer by replying to the e-mail itself.</p>
          </MessageCard>
        ) : kind === 'expired' ? (
          <MessageCard icon={Clock} tone="warn" title="This reply link has expired">
            <p>Reply to the e-mail instead, or ask the approver to send the question again.</p>
          </MessageCard>
        ) : (
          <MessageCard icon={CircleAlert} tone="danger" title="We couldn't load this question">
            <p>{loadError?.message || 'Something went wrong on our side.'}</p>
            <button type="button" onClick={() => window.location.reload()} className="tp-focus-ring mt-3 rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted">Try again</button>
          </MessageCard>
        )}
      </Shell>
    );
  }

  const { question, thread = [], ticket = {}, recipient = {}, approval = {}, participants = null } = data;
  const closed = approval.status && !['pending', 'info_requested'].includes(approval.status);
  const asker = question.author?.name || question.author?.email || 'The approver';
  const subtitle = ticket.displayRef ? `${ticket.displayRef}${approval.category ? ` · ${approval.category}` : ''}` : 'Approval question';
  const approvalShim = { requestNote: null, requestNoteHtml: null, escalationLog: [], clarificationLog: [] };

  return (
    <Shell subtitle={subtitle} theme={theme} onToggleTheme={toggle}>
      <article className="tp-card rounded-2xl border-t-4 border-t-violet-400 shadow-soft motion-on:animate-fadeIn" aria-labelledby="reply-title">
        <header className="border-b border-border px-5 py-5 min-[800px]:px-[26px]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-700 dark:text-violet-200">
            {question.audience === 'internal' ? 'Question to the approvers / agent' : 'Question for you'}
          </p>
          <h1 id="reply-title" className="mt-1 text-2xl font-bold leading-tight tracking-[-0.01em] text-foreground">{ticket.subject || 'Approval question'}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            <span className="font-semibold text-foreground">{asker}</span> asked
            {recipient.name ? <> <span className="font-semibold text-foreground">{recipient.name}</span></> : ' you'}
            {question.createdAt ? ` on ${new Date(question.createdAt).toLocaleString()}` : ''}
            {ticket.displayRef ? <> · <span className="font-mono">{ticket.displayRef}</span></> : null}
          </p>
        </header>

        <div className="px-5 py-5 min-[800px]:px-[26px]">
          <ApprovalThread
            approval={approvalShim}
            messages={thread}
            people={participants ? [participants.requester, participants.agent, ...(participants.approvers || [])].filter(Boolean) : []}
            viewerEmail={recipient.email || null}
            viewerRole={recipient.role || null}
            isDark={isDark}
            showTitle
            title="The conversation so far"
          />

          {sent ? (
            <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100" role="status" tabIndex={-1}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-200/70 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100"><CheckCircle2 className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <p className="text-base font-bold leading-snug">Your answer is on the request</p>
                <p className="mt-1 text-sm opacity-80">{asker} and everyone on the request have been told by e-mail. You can close this page, or add more below.</p>
              </div>
            </div>
          ) : closed ? (
            <p className="mt-5 rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">This request has already been {approval.status}. You can still reply — your note is kept on the ticket.</p>
          ) : null}

          <section aria-labelledby="reply-heading" className="mt-5">
            <h2 id="reply-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Your answer</h2>
            <RichTextEditor
              ref={editorRef}
              value={bodyHtml}
              onChange={({ html, text }) => { setBodyHtml(html); setBodyText(text); if (error) setError(null); }}
              placeholder={`Answer ${asker.split(' ')[0]} here — it lands on the approval request and everyone on it is told.`}
              ariaLabel="Your answer"
              minHeight={260}
              className="border-input bg-background"
            />
            {error && (
              <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-200"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={send} disabled={sending} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-violet-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                {sending ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                {sending ? 'Sending…' : 'Send answer'}
              </button>
              <p className="text-xs text-muted-foreground">
                Goes to {asker}{participants ? ` and ${question.audience === 'internal' ? 'the approvers / agent' : 'everyone on the request'}` : ''}. Replying to the e-mail works the same way.
              </p>
            </div>
          </section>
        </div>
      </article>
    </Shell>
  );
}
