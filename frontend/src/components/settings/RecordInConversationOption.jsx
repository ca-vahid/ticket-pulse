/**
 * Mail Workflows → Send e-mail step → "Record this e-mail in the ticket's
 * conversation" (QA 10-13 item 14). Off unless ticked; a saved workflow
 * without the field is off.
 */
export default function RecordInConversationOption({ value, onChange, disabled = false }) {
  const checked = value === true;
  return (
    <div className="flex items-start gap-2.5 py-1">
      <input
        id="wf-record-in-conversation"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="tp-focus-ring mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
      />
      <div className="min-w-0 text-sm">
        <label htmlFor="wf-record-in-conversation" className="font-medium text-foreground">
          Record this e-mail in the ticket&rsquo;s conversation
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          After it is sent, the ticket shows the subject, who it went to and the text: as a reply when the requester is among the recipients, otherwise as an internal note. Not recorded in Shadow.
        </p>
      </div>
    </div>
  );
}
