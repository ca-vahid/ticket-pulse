import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Paperclip } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import AttachmentPreviewModal from '../tickets/AttachmentPreviewModal';
import { cleanNoteText } from '../../utils/noteText';
import { briefDescription, splitImageRefs } from '../../utils/approvalBrief';

/**
 * Option A of the approval row (Vahid, 7 Oct 2026): what is being asked, in
 * full size, and enough of the ticket to decide without opening it — the
 * description, the facts an approver weighs, and the pictures. The ticket is
 * read on demand when a row opens (once per page visit).
 */

const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const cache = new Map(); // ticketId → Promise<ticket>

const isImage = (a) => /^image\//i.test(a?.contentType || a?.mimeType || '')
  || /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(a?.fileName || '');

function useApprovalTicket(ticketId, enabled = true) {
  const [state, setState] = useState({ ticket: null, error: null, loading: Boolean(enabled && ticketId) });
  useEffect(() => {
    if (!enabled || !ticketId) return undefined;
    let alive = true;
    if (!cache.has(ticketId)) {
      cache.set(ticketId, ticketsAPI.get(ticketId, { reconcile: false }).then((res) => res?.data || res).catch((err) => { cache.delete(ticketId); throw err; }));
    }
    setState((s) => ({ ...s, loading: true }));
    cache.get(ticketId)
      .then((ticket) => { if (alive) setState({ ticket, error: null, loading: false }); })
      .catch((error) => { if (alive) setState({ ticket: null, error, loading: false }); });
    return () => { alive = false; };
  }, [ticketId, enabled]);
  return state;
}

function Thumb({ ticketId, attachment, onOpen, size = 'h-14 w-20' }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    let made = null;
    ticketsAPI.attachmentObjectUrl(ticketId, attachment.id)
      .then((res) => { if (alive) { made = res.url; setUrl(res.url); } else URL.revokeObjectURL(res.url); })
      .catch(() => {});
    return () => { alive = false; if (made) setTimeout(() => URL.revokeObjectURL(made), 300); };
  }, [ticketId, attachment.id]);
  return (
    <button
      type="button"
      onClick={() => onOpen(attachment)}
      title={`Preview ${attachment.fileName}`}
      className={`tp-focus-ring ${size} flex-shrink-0 overflow-hidden rounded-md border border-border bg-muted/60 hover:border-primary/50`}
    >
      {url ? <img src={url} alt={attachment.fileName} className="h-full w-full object-cover" /> : <span className="sr-only">{attachment.fileName}</span>}
    </button>
  );
}

function Fact({ label, children }) {
  if (!children) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-[12.5px] text-foreground/90 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

export default function ApprovalTicketBrief({ approval: a, note: noteOverride = null, noteLabel = null, backState = null }) {
  const { ticket, error, loading } = useApprovalTicket(a.ticketId);
  const [preview, setPreview] = useState(null);
  const [moreDesc, setMoreDesc] = useState(false);

  const request = useMemo(() => splitImageRefs(cleanNoteText(noteOverride ?? a.requestNote ?? '')), [noteOverride, a.requestNote]);
  const attachments = useMemo(() => ticket?.attachments || [], [ticket]);
  const noteImages = useMemo(() => {
    const want = new Set(request.names.map((n) => n.toLowerCase()));
    return attachments.filter((x) => want.has(String(x.fileName || '').toLowerCase()));
  }, [attachments, request.names]);
  const otherImages = useMemo(() => attachments.filter((x) => isImage(x) && !noteImages.includes(x)), [attachments, noteImages]);
  const otherFiles = useMemo(() => attachments.filter((x) => !isImage(x)), [attachments]);
  const description = useMemo(() => briefDescription(ticket), [ticket]);
  const longDesc = description.length > 360 || description.split('\n').length > 5;

  const asker = firstName(a.requestedByName) || 'The agent';
  const category = [ticket?.internalCategory?.name, ticket?.internalSubcategory?.name].filter(Boolean).join(' › ') || ticket?.category || null;
  const requester = ticket?.requester;
  const requesterBits = [requester?.jobTitle, requester?.entraOfficeLocation || requester?.entraCity].filter(Boolean).join(', ');
  const ticketLink = `/tickets/${a.ticketId}`;

  return (
    <div className="min-w-0 space-y-4" data-testid="approval-brief">
      {(request.text || noteImages.length > 0 || request.names.length > 0) && (
        <div className="rounded-r-lg border-l-[3px] border-amber-500 bg-amber-50 px-4 py-3 dark:bg-amber-500/10">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">{noteLabel || `What ${asker} is asking`}</div>
          {request.text && <p className="whitespace-pre-line text-[15px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{request.text}</p>}
          {noteImages.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {noteImages.map((x) => <Thumb key={x.id} ticketId={a.ticketId} attachment={x} onOpen={setPreview} />)}
            </div>
          )}
          {noteImages.length === 0 && request.names.length > 0 && (
            <p className="mt-1.5 text-[12px] text-muted-foreground">{request.names.length === 1 ? '1 picture' : `${request.names.length} pictures`} attached on the ticket</p>
          )}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          About the ticket
          <Link to={ticketLink} state={backState || undefined} className="tp-focus-ring ml-auto inline-flex items-center gap-1 rounded text-[12px] font-medium normal-case tracking-normal text-primary hover:underline">
            Open {a.displayRef || 'the ticket'} <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        {loading && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading the ticket">
            <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        )}
        {error && !loading && (
          <p className="text-[13px] text-muted-foreground">The ticket could not be loaded here. <Link to={ticketLink} state={backState || undefined} className="tp-focus-ring rounded text-primary hover:underline">Open it</Link> to read it.</p>
        )}
        {ticket && (
          <>
            {description ? (
              <>
                <p className={`whitespace-pre-line text-[13.5px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere] ${longDesc && !moreDesc ? 'line-clamp-5' : ''}`} data-testid="approval-brief-description">{description}</p>
                {longDesc && (
                  <button type="button" onClick={() => setMoreDesc((v) => !v)} className="tp-focus-ring mt-1 rounded text-[12px] font-medium text-primary hover:underline">
                    {moreDesc ? 'Show less' : 'Read the whole description'}
                  </button>
                )}
              </>
            ) : <p className="text-[13px] text-muted-foreground">No description on the ticket.</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              <Fact label="Type">{ticket.ticketType}</Fact>
              <Fact label="Category">{category}</Fact>
              <Fact label="Priority · status">{[PRIORITY[ticket.priority], ticket.status].filter(Boolean).join(' · ')}</Fact>
              <Fact label="Agent">{ticket.assignedTech?.name || 'Unassigned'}</Fact>
              <Fact label="Requester">{[requester?.name, requesterBits].filter(Boolean).join(' — ')}</Fact>
              <Fact label="Amount">{a.amountLabel || null}</Fact>
            </dl>
            {(otherImages.length > 0 || otherFiles.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                {otherImages.slice(0, 4).map((x) => <Thumb key={x.id} ticketId={a.ticketId} attachment={x} onOpen={setPreview} size="h-10 w-14" />)}
                <span className="inline-flex items-center gap-1">
                  <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                  {[otherImages.length && `${otherImages.length} picture${otherImages.length === 1 ? '' : 's'}`, otherFiles.length && `${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {preview && (
        <AttachmentPreviewModal
          ticketId={a.ticketId}
          attachment={preview}
          items={[...noteImages, ...otherImages]}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
