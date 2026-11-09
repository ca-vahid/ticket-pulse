import { useMemo, useState } from 'react';
import { ImageOff, Paperclip } from 'lucide-react';
import { LinkedText, SafeHtml, formatBytes } from '../ticketUi';
import { prepareEmailHtml } from './prepareEmailHtml';

const formatDate = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function HeaderRow({ label, children }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground/85">{children}</dd>
    </>
  );
}

/**
 * An attached e-mail, read like a mail client (QA 11-06 #3): subject, the
 * From / To / Cc / Date block, the message's own attachments (names and sizes
 * only) and the body. The sender's HTML goes through SafeHtml (DOMPurify, no
 * <style>/<script>/forms) and sits in a white well in both themes, the
 * mail-client convention the ticket thread also follows.
 */
export default function EmailView({ email }) {
  const { subject, from, to = [], cc = [], date, html, text, attachments = [] } = email;
  const [showImages, setShowImages] = useState(false);
  const body = useMemo(() => prepareEmailHtml(html, { showImages }), [html, showImages]);
  return (
    <div data-preview-scroll data-testid="email-preview" className="settings-scrollbar h-full w-full overflow-auto overscroll-contain bg-card">
      <header className="px-5 pb-3 pt-4 sm:px-6">
        <h2 className="text-base font-semibold leading-snug text-foreground">{subject || '(no subject)'}</h2>
        <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <HeaderRow label="From">{from || '(unknown sender)'}</HeaderRow>
          {to.length > 0 && <HeaderRow label="To">{to.join('; ')}</HeaderRow>}
          {cc.length > 0 && <HeaderRow label="Cc">{cc.join('; ')}</HeaderRow>}
          {date && <HeaderRow label="Date">{formatDate(date)}</HeaderRow>}
        </dl>
        {attachments.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2.5">
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label="Attachments in this e-mail">
              {attachments.map((a, i) => (
                <li key={`${a.name}-${i}`} className="flex min-w-0 items-center gap-1.5 text-foreground/85">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
                  <span className="truncate">{a.name}</span>
                  {a.size > 0 && <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(a.size)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>
      <div className="border-t border-border/60 bg-muted/50 p-2 sm:p-3">
        {body.blocked > 0 && !showImages && (
          <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground" data-testid="email-images-blocked">
            <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{body.blocked === 1 ? '1 picture from the internet is hidden' : `${body.blocked} pictures from the internet are hidden`}, so the sender can&apos;t tell this e-mail was opened.</span>
            <button type="button" onClick={() => setShowImages(true)} className="tp-focus-ring rounded font-semibold text-primary hover:underline">Show pictures</button>
          </p>
        )}
        <div className="tp-light rounded-md bg-card px-5 py-4 text-foreground shadow-subtle sm:px-6">
          {html
            ? <SafeHtml html={body.html} isDark={false} />
            : text
              ? <LinkedText text={text} className="text-sm text-foreground/85" />
              : <p className="text-sm text-muted-foreground">This e-mail has no message text.</p>}
        </div>
      </div>
    </div>
  );
}
