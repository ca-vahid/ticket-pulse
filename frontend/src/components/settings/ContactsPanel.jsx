import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle, BookUser, CheckCircle2, Loader, PenLine, Plus, Search, Trash2, X,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';

/**
 * Settings → Contacts (QA 11-26 item 2, workspace admins).
 *
 * People outside the directory that this workspace wants to pick as
 * requesters or recipients. Each contact is a known requester linked to this
 * workspace (the server finds them by e-mail or creates them); they then show
 * in the requester, Cc and recipient pickers here, marked "Contact".
 * The e-mail is who the contact is: to change it, remove and add again.
 * Remove asks in the row first (no browser confirm()).
 */

export const CONTACT_EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

const EMPTY_FORM = { name: '', email: '', phone: '', jobTitle: '', note: '' };

const FIELD = 'tp-focus-ring w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/75 disabled:bg-muted/50 disabled:text-muted-foreground';
const PRIMARY_BUTTON = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60';
const QUIET_BUTTON = 'tp-focus-ring rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground';

/** Client-side checks, mirrored by the server. Returns { field: message }. */
export function validateContactForm(form, { isEdit = false } = {}) {
  const errors = {};
  if (!String(form.name || '').trim()) errors.name = 'Enter a name.';
  if (!isEdit) {
    const email = String(form.email || '').trim();
    if (!email) errors.email = 'Enter an e-mail address.';
    else if (!CONTACT_EMAIL_RE.test(email)) errors.email = 'That does not look like an e-mail address (name@example.com).';
  }
  return errors;
}

const FRESHSERVICE_LOCK = 'FreshService keeps this person’s name, phone and job title.';

/** The server's reason (detailsLocked); an older server only says managedByFreshService. */
function lockReasonFor(contact) {
  if (contact?.detailsLocked) return contact.detailsLocked;
  return contact?.managedByFreshService ? FRESHSERVICE_LOCK : null;
}

const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function formatDay(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// `lockReason`: why this workspace may not change the person's name / phone /
// job title (FreshService owns them, or other workspaces see the same person —
// requesters are shared). Null = editable.
function ContactForm({ initial, isEdit, lockReason = null, saving, serverError, onCancel, onSubmit }) {
  const lockedDetails = Boolean(lockReason);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const baseId = useId();
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((errs) => ({ ...errs, [key]: undefined }));
  };

  const submit = (e) => {
    e.preventDefault();
    const found = validateContactForm(form, { isEdit });
    setErrors(found);
    if (Object.keys(found).length) return;
    // FreshService keeps a synced person's details: send the note only.
    if (lockedDetails) { onSubmit({ note: form.note.trim() }); return; }
    onSubmit({
      name: form.name.trim(),
      ...(isEdit ? {} : { email: form.email.trim().toLowerCase() }),
      phone: form.phone.trim(),
      jobTitle: form.jobTitle.trim(),
      note: form.note.trim(),
    });
  };

  const field = (key, label, { required = false, type = 'text', placeholder = '', disabled = false, inputRef, autoComplete = 'off', maxLength = 255 } = {}) => {
    const id = `${baseId}-${key}`;
    const errId = `${id}-error`;
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-semibold text-foreground/85">
          {label}{required ? <span className="text-muted-foreground"> (required)</span> : <span className="font-normal text-muted-foreground"> (optional)</span>}
        </label>
        <input
          id={id}
          ref={inputRef}
          type={type}
          value={form[key]}
          onChange={set(key)}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          autoComplete={autoComplete}
          aria-invalid={errors[key] ? true : undefined}
          aria-describedby={errors[key] ? errId : undefined}
          className={`${FIELD} ${errors[key] ? 'border-red-400 dark:border-red-500/60' : ''}`}
        />
        {errors[key] && <p id={errId} className="mt-1 text-xs text-red-600 dark:text-red-300">{errors[key]}</p>}
      </div>
    );
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={isEdit ? `Edit ${initial.name}` : 'Add a contact'}
      className="tp-card space-y-3 rounded-xl p-4 animate-fadeIn"
      data-testid="contact-form"
    >
      <div className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${initial.name}` : 'Add a contact'}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('name', 'Name', { required: true, placeholder: 'Avery Stone', disabled: lockedDetails, inputRef: isEdit ? undefined : firstRef })}
        {isEdit ? (
          <div>
            <span className="mb-1 block text-xs font-semibold text-foreground/85">E-mail</span>
            <p className="py-2 text-sm text-foreground">{initial.email}</p>
            <p className="text-[11px] text-muted-foreground">To use a different address, remove this contact and add the new one.</p>
          </div>
        ) : field('email', 'E-mail', { required: true, type: 'email', placeholder: 'name@example.com', maxLength: 255 })}
        {field('phone', 'Phone', { type: 'tel', disabled: lockedDetails, maxLength: 50 })}
        {field('jobTitle', 'Job title', { disabled: lockedDetails })}
      </div>
      {field('note', 'Note', { placeholder: 'e.g. Account manager at our printer vendor', inputRef: isEdit ? firstRef : undefined })}
      {lockedDetails && (
        <p className="text-xs text-muted-foreground" data-testid="contact-lock-reason">{lockReason} You can change the note.</p>
      )}
      {serverError && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{serverError}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={QUIET_BUTTON}>Cancel</button>
        <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
          {saving && <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {isEdit ? 'Save changes' : 'Add contact'}
        </button>
      </div>
    </form>
  );
}

export default function ContactsPanel() {
  const { currentWorkspace } = useWorkspace();
  const [contacts, setContacts] = useState(null);
  const [total, setTotal] = useState(0);
  const [sandbox, setSandbox] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [query, setQuery] = useState('');
  // null | { mode: 'add' } | { mode: 'edit', contact }
  const [formState, setFormState] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const confirmRef = useRef(null);
  const addButtonRef = useRef(null);

  // Debounce the search box into the server query.
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchQ.trim()), 250);
    return () => clearTimeout(t);
  }, [searchQ]);

  // Only the newest request may write the list: a slow answer for an older
  // search (or the previous workspace) arriving late is dropped.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true); setError(null);
    try {
      const res = await settingsAPI.getContacts(query);
      if (seq !== requestSeq.current) return;
      setContacts(res.data?.contacts || []);
      setTotal(res.data?.total ?? 0);
      setSandbox(Boolean(res.data?.sandbox));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err.response?.data?.message || err.message || 'Could not load contacts');
      setContacts([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  // A workspace switch closes any open form or confirmation.
  useEffect(() => { setFormState(null); setConfirmId(null); setNotice(null); }, [currentWorkspace?.id]);

  useEffect(() => { if (confirmId) confirmRef.current?.focus(); }, [confirmId]);

  const openAdd = () => { setFormState({ mode: 'add' }); setFormError(null); setConfirmId(null); setNotice(null); };
  const openEdit = (contact) => { setFormState({ mode: 'edit', contact }); setFormError(null); setConfirmId(null); setNotice(null); };
  const closeForm = () => { setFormState(null); setFormError(null); setTimeout(() => addButtonRef.current?.focus(), 0); };

  const submitForm = async (values) => {
    setSaving(true); setFormError(null);
    try {
      if (formState?.mode === 'edit') {
        await settingsAPI.updateContact(formState.contact.id, values);
        setNotice(`${values.name || formState.contact.name} saved.`);
      } else {
        const res = await settingsAPI.addContact(values);
        setNotice(res.data?.message || `${values.name} added.`);
      }
      setFormState(null);
      await load();
    } catch (err) {
      setFormError(err.response?.data?.message || err.message || 'Could not save the contact');
    } finally {
      setSaving(false);
    }
  };

  const removeContact = async (contact) => {
    setRemovingId(contact.id); setError(null);
    try {
      await settingsAPI.removeContact(contact.id);
      setNotice(`${contact.name} removed from this workspace's contacts.`);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not remove the contact');
    } finally {
      setRemovingId(null);
    }
  };

  const rows = contacts || [];
  const canEdit = !sandbox;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-blue-100 p-2 dark:bg-blue-500/20">
          <BookUser className="h-5 w-5 text-blue-600 dark:text-blue-300" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Workspace contacts</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            People outside the directory you want to pick as requesters or recipients in this workspace.
          </p>
        </div>
      </div>

      {sandbox && (
        <p className="text-sm text-muted-foreground">This is an integration sandbox, so its contacts can be viewed but not changed.</p>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span>
        </div>
      )}
      <div role="status" aria-live="polite">
        {notice && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="tp-focus-ring rounded p-0.5 hover:bg-emerald-100 dark:hover:bg-emerald-500/20">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search name or e-mail…"
            aria-label="Search contacts"
            className="tp-focus-ring w-full rounded-lg border border-input bg-card py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/75"
          />
        </div>
        {canEdit && formState?.mode !== 'add' && (
          <button type="button" ref={addButtonRef} onClick={openAdd} className={`${PRIMARY_BUTTON} sm:ml-auto`}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add contact
          </button>
        )}
      </div>

      {formState && (
        <ContactForm
          key={formState.mode === 'edit' ? `edit-${formState.contact.id}` : 'add'}
          isEdit={formState.mode === 'edit'}
          initial={formState.mode === 'edit'
            ? {
              name: formState.contact.name || '',
              email: formState.contact.email || '',
              phone: formState.contact.phone || '',
              jobTitle: formState.contact.jobTitle || '',
              note: formState.contact.note || '',
            }
            : EMPTY_FORM}
          lockReason={formState.mode === 'edit' ? lockReasonFor(formState.contact) : null}
          saving={saving}
          serverError={formError}
          onCancel={closeForm}
          onSubmit={submitForm}
        />
      )}

      {loading && contacts === null ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground/75">
          <Loader className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Loading contacts…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center" data-testid="contacts-empty">
          {query ? (
            <p className="text-sm text-muted-foreground">No contacts match &ldquo;{query}&rdquo;.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">No contacts yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add someone who is not in the directory, like a vendor or a client, and they can be picked on tickets here.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="tp-card overflow-hidden rounded-xl">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Contacts in this workspace</caption>
            <thead className="border-b border-border text-xs font-semibold text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">Contact</th>
                <th scope="col" className="hidden px-3 py-2 md:table-cell">Note</th>
                <th scope="col" className="hidden px-3 py-2 lg:table-cell">Added</th>
                {canEdit && <th scope="col" className="px-3 py-2 text-right"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((c) => {
                const details = [c.email, c.jobTitle, c.phone].filter(Boolean).join(' · ');
                const confirming = confirmId === c.id;
                return [
                  <tr key={c.id} className="align-top hover:bg-muted/35">
                    <td className="px-3 py-2.5">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground" aria-hidden="true">
                          {initialsOf(c.name)}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{c.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{details}</div>
                          {c.note && <div className="mt-0.5 text-xs text-muted-foreground md:hidden">{c.note}</div>}
                          {c.hiddenFromPickers && (
                            <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-200">Not shown in pickers: {c.hiddenFromPickers}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 text-foreground/85 md:table-cell">
                      {c.note || <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">
                      <div>{formatDay(c.addedAt)}</div>
                      {c.addedBy && <div className="truncate">by {c.addedBy}</div>}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => openEdit(c)}
                            aria-label={`Edit ${c.name}`}
                            title="Edit"
                            className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground"
                          >
                            <PenLine className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setConfirmId(c.id); setFormState(null); }}
                            aria-label={`Remove ${c.name}`}
                            aria-expanded={confirming}
                            title="Remove"
                            className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-red-600 dark:hover:text-red-300"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>,
                  confirming && (
                    <tr key={`${c.id}-confirm`} className="bg-muted/40">
                      <td colSpan={4} className="px-3 py-2.5">
                        <div role="group" aria-label={`Remove ${c.name}?`} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <p className="flex-1 text-sm text-foreground">
                            Remove <strong>{c.name}</strong> from this workspace&rsquo;s contacts? Tickets they are on stay as they are.
                          </p>
                          <button type="button" ref={confirmRef} onClick={() => setConfirmId(null)} className={QUIET_BUTTON}>Keep</button>
                          <button
                            type="button"
                            onClick={() => removeContact(c)}
                            disabled={removingId === c.id}
                            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
                          >
                            {removingId === c.id && <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />}
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
          {total > rows.length && !query && (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Showing {rows.length} of {total}. Search to find the rest.</p>
          )}
        </div>
      )}
    </div>
  );
}
