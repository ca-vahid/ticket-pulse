import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Image as ImageIcon, Inbox, LayoutGrid, List, Loader2, MessageSquare, Paperclip, Send, StickyNote, Upload } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { formatBytes, formatDayTime } from './ticketUi';

/**
 * Attachments tab (30 Sep 2026): every file on the ticket in one place,
 * filtered by where it came from — the requester's messages (incl. the
 * original request), agent replies, internal notes, files uploaded straight
 * onto the ticket. Grid (image thumbnails) or list; click previews, the icon
 * downloads, "Show in conversation" jumps to the message it came with.
 */
const isImage = (a) => /^image\//i.test(a?.contentType || '') || /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(a?.fileName || '');
const ext = (name) => (String(name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase();

const FILTERS = [
  { key: 'all', label: 'All', Icon: Paperclip },
  { key: 'requester', label: 'From the requester', Icon: Inbox },
  { key: 'reply', label: 'Agent replies', Icon: Send },
  { key: 'note', label: 'Internal notes', Icon: StickyNote },
  { key: 'upload', label: 'Uploaded to the ticket', Icon: Upload },
];
function personName(value, nameForEmail) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (!v.includes('@')) return v;
  const known = nameForEmail?.(v);
  if (known && !String(known).includes('@')) return known;
  return v.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
const KIND_WORD = { requester: 'Requester', reply: 'Agent reply', note: 'Internal note', upload: 'Uploaded' };

/** Where a file came from, using the thread entry it arrived with. */
export function attachmentKind(a, entryById) {
  if (!a.threadEntryId) return a.source === 'email' ? 'requester' : 'upload';
  const e = entryById.get(a.threadEntryId);
  if (!e) return a.source === 'email' ? 'requester' : 'upload';
  if (e.isPrivate === true || e.eventType === 'note' || e.eventType === 'private_note') return 'note';
  const agent = e.authorType === 'agent';
  const incoming = !agent && (e.incoming === true || e.authorType === 'requester');
  return incoming ? 'requester' : 'reply';
}

function Thumb({ a, url }) {
  if (isImage(a)) {
    return url
      ? <img src={url} alt={a.fileName} loading="lazy" className="h-full w-full object-cover" />
      : <ImageIcon className="h-6 w-6 text-muted-foreground/50" aria-hidden="true" />;
  }
  return (
    <span className="flex flex-col items-center gap-1">
      <FileText className="h-7 w-7 text-muted-foreground/70" aria-hidden="true" />
      <span className="text-[10px] font-bold tracking-wide text-muted-foreground">{ext(a.fileName)}</span>
    </span>
  );
}

export default function TicketAttachmentsTab({
  ticketId, attachments = [], entries = [], onPreview, onDownload, onJumpToEntry, canUpload = false, onUpload, uploading = false, nameForEmail = null,
}) {
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState(() => { try { return localStorage.getItem('tp_attach_view') || 'grid'; } catch { return 'grid'; } });
  const [urls, setUrls] = useState({});

  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const rows = useMemo(() => attachments.map((a) => {
    const e = a.threadEntryId ? entryById.get(a.threadEntryId) : null;
    return {
      a,
      kind: attachmentKind(a, entryById),
      // A person, never a bare address (uploads store the uploader's e-mail).
      who: e?.actorName || personName(a.uploadedBy, nameForEmail),
      at: e?.occurredAt || a.createdAt,
      entryId: e?.id || null,
    };
  }).sort((x, y) => new Date(y.at) - new Date(x.at)), [attachments, entryById, nameForEmail]);
  const counts = useMemo(() => {
    const c = { all: rows.length, requester: 0, reply: 0, note: 0, upload: 0 };
    for (const r of rows) c[r.kind] += 1;
    return c;
  }, [rows]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);

  // Thumbnails for images on screen (object URLs, revoked on change).
  useEffect(() => {
    if (view !== 'grid') return undefined;
    let alive = true;
    const made = [];
    shown.filter((r) => isImage(r.a) && !urls[r.a.id]).slice(0, 40).forEach(({ a }) => {
      ticketsAPI.attachmentObjectUrl(ticketId, a.id)
        .then((res) => {
          if (!alive) { URL.revokeObjectURL(res.url); return; }
          made.push(res.url);
          setUrls((u) => ({ ...u, [a.id]: res.url }));
        })
        .catch(() => {});
    });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per visible set; urls is the cache
  }, [ticketId, view, filter, attachments]);
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setViewSaved = (v) => { setView(v); try { localStorage.setItem('tp_attach_view', v); } catch { /* private window */ } };

  return (
    <section className="tp-card rounded-xl p-4 sm:p-5" aria-labelledby="attachments-tab-heading" data-testid="ticket-attachments-tab">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="attachments-tab-heading" className="flex items-center gap-2 text-base font-bold text-foreground">
          <Paperclip className="h-4 w-4 text-blue-500" aria-hidden="true" /> Attachments
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="View">
            {[['grid', LayoutGrid, 'Grid'], ['list', List, 'List']].map(([k, Icon, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} aria-label={label} title={label} onClick={() => setViewSaved(k)}
                className={`tp-focus-ring px-2 py-1.5 ${view === k ? 'bg-muted text-foreground' : 'bg-card text-muted-foreground hover:text-foreground'} ${k === 'list' ? 'border-l border-input' : ''}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
          {canUpload && (
            <label className={`tp-focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 ${uploading ? 'pointer-events-none opacity-60' : ''}`}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
              Upload
              <input type="file" multiple className="sr-only" onChange={(e) => { onUpload?.(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </div>
      </div>

      {/* Where from — only the sources this ticket has, plus All. */}
      <div className="mt-3 flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Filter attachments">
        {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map(({ key, label, Icon }) => {
          const on = filter === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setFilter(key)}
              className={`tp-focus-ring -mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-semibold ${on ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
              <span className="text-xs font-normal text-muted-foreground">{counts[key]}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm italic text-muted-foreground">
          {rows.length === 0 ? 'No attachments on this ticket yet.' : 'No attachments from this source.'}
        </p>
      ) : view === 'grid' ? (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {shown.map(({ a, kind, who, at, entryId }) => (
            <li key={a.id} className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
              <button type="button" onClick={() => onPreview?.(a)} title={`Preview ${a.fileName}`}
                className="tp-focus-ring flex h-28 items-center justify-center overflow-hidden bg-muted/50 transition-colors hover:bg-muted">
                <Thumb a={a} url={urls[a.id]} />
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-2.5">
                <span className="truncate text-xs font-semibold text-foreground" title={a.fileName}>{a.fileName}</span>
                <span className="truncate text-[11px] text-muted-foreground">{KIND_WORD[kind]}{who ? ` · ${who}` : ''}</span>
                <span className="text-[11px] text-muted-foreground/75">{formatDayTime(at)} · {formatBytes(a.sizeBytes)}</span>
                <span className="mt-1 flex items-center gap-2">
                  {entryId && (
                    <button type="button" onClick={() => onJumpToEntry?.(entryId)} title="Show in conversation" className="tp-focus-ring inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-primary hover:underline">
                      <MessageSquare className="h-3 w-3" aria-hidden="true" /> Go to message
                    </button>
                  )}
                  <button type="button" onClick={() => onDownload?.(a)} aria-label={`Download ${a.fileName}`} title="Download" className="tp-focus-ring ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {shown.map(({ a, kind, who, at, entryId }) => (
            <li key={a.id} className="flex items-center gap-3 py-2">
              {isImage(a) ? <ImageIcon className="h-4 w-4 flex-none text-muted-foreground/75" aria-hidden="true" /> : <Paperclip className="h-4 w-4 flex-none text-muted-foreground/75" aria-hidden="true" />}
              <button type="button" onClick={() => onPreview?.(a)} className="tp-focus-ring min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:text-primary" title={`Preview ${a.fileName}`}>{a.fileName}</button>
              <span className="hidden flex-none text-xs text-muted-foreground sm:inline">{KIND_WORD[kind]}{who ? ` · ${who}` : ''}</span>
              <span className="hidden flex-none text-xs text-muted-foreground/75 md:inline">{formatDayTime(at)}</span>
              <span className="w-16 flex-none text-right text-xs text-muted-foreground/75">{formatBytes(a.sizeBytes)}</span>
              {entryId
                ? <button type="button" onClick={() => onJumpToEntry?.(entryId)} title="Show in conversation" aria-label="Show in conversation" className="tp-focus-ring flex-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><MessageSquare className="h-3.5 w-3.5" aria-hidden="true" /></button>
                : <span className="w-[22px] flex-none" />}
              <button type="button" onClick={() => onDownload?.(a)} aria-label={`Download ${a.fileName}`} title="Download" className="tp-focus-ring flex-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Download className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
