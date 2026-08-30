import { useEffect, useState } from 'react';
import { Paperclip, Pencil, Trash2, X } from 'lucide-react';
import { formatBytes } from './ticketUi';

/**
 * A staged (not-yet-sent) attachment in a composer. Images show a thumbnail
 * with a delete corner button; other files show the paperclip + name chip.
 * When `onEdit` is provided and the file is an image, clicking the thumbnail
 * opens the markup/crop editor (a pencil affordance appears on hover).
 * Renders an <li> — use inside a <ul>.
 */
export default function StagedFileChip({ file, onRemove, onEdit, storedOnly }) {
  const isImage = (file.type || '').startsWith('image/');
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!isImage) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  const editable = isImage && typeof onEdit === 'function';

  if (isImage) {
    return (
      <li className="relative group/att">
        {editable ? (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${file.name}`}
            className="tp-focus-ring block rounded-lg"
          >
            <img src={preview} alt={file.name} title={`${file.name} · ${formatBytes(file.size)} — click to edit`} className="h-20 w-20 object-cover rounded-lg border border-border" />
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-slate-900/0 group-hover/att:bg-slate-900/35 transition-colors opacity-0 group-hover/att:opacity-100">
              <Pencil className="w-4 h-4 text-white drop-shadow" aria-hidden="true" />
            </span>
          </button>
        ) : (
          <img src={preview} alt={file.name} title={`${file.name} · ${formatBytes(file.size)}`} className="h-20 w-20 object-cover rounded-lg border border-border" />
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="tp-focus-ring absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-card border border-border shadow-sm text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 hover:border-red-200 dark:hover:border-red-500/30"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        {storedOnly && (
          <span className="absolute inset-x-0 bottom-0 text-[9px] font-medium text-center text-amber-800 dark:text-amber-200 bg-amber-100/90 dark:bg-amber-500/15 rounded-b-lg py-0.5" title="Over 3 MB — stored on the ticket but too big to email">stored only</span>
        )}
      </li>
    );
  }
  return (
    <li className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground self-start">
      <Paperclip className="w-3 h-3 text-muted-foreground/75" aria-hidden="true" />
      <span className="max-w-[180px] truncate">{file.name}</span>
      <span className="text-muted-foreground/75">{formatBytes(file.size)}</span>
      {storedOnly && <span className="text-amber-600 dark:text-amber-300" title="Over 3 MB — stored on the ticket but too big to email">stored only</span>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="tp-focus-ring rounded p-0.5 text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15"
      >
        <Trash2 className="w-3 h-3" aria-hidden="true" />
      </button>
    </li>
  );
}
