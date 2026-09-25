import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { settingsAPI, ticketsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  AlertCircle, ArrowRight, AtSign, BadgeDollarSign, Ban, Check, CheckCircle2, Laptop, Layers, Loader, Lock, Pencil, Plus, Power, PowerOff, Search, Stamp, Trash2, UserPlus, X,
} from 'lucide-react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The shared axios error interceptor rethrows an enhanced Error carrying
// `.status` (the raw axios `.response.status` never reaches callers) — accept
// both shapes so a mocked axios error in tests behaves like the real one.
const isForbidden = (err) => err?.status === 403 || err?.response?.status === 403;

function initials(name) {
  return (name || '?').split(/[\s@.]+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function Avatar({ name, photoUrl, size = 'h-6 w-6' }) {
  return (
    <span className={`${size} rounded-full bg-muted overflow-hidden inline-flex items-center justify-center shrink-0`}>
      {photoUrl
        ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
        : <span className="text-[9px] font-semibold text-muted-foreground">{initials(name)}</span>}
    </span>
  );
}

/**
 * Approval-manager picker — workspace members first, then the Entra directory
 * for anyone else (admins/coordinators who aren't technicians — QA 07-06 #7).
 * Approvals key on EMAIL: any picked person can decide via the emailed magic
 * link, and in-app if they can sign in. When directory access is locked
 * (genuine 403 — QA 08-17 #7) the picker stays usable: members still match
 * and a fully-typed email can always be added via the free-text row.
 */
function MemberPicker({ members, exclude = [], onPick, directoryLocked = false, onDirectoryLocked }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [directoryResults, setDirectoryResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [lockInfoOpen, setLockInfoOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) { setOpen(false); setLockInfoOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const memberResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members || [])
      .filter((m) => m.isActive !== false && m.email && !exclude.includes(m.email.toLowerCase()))
      .filter((m) => !q || (m.name || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, query, exclude]);

  // Directory search (debounced) surfaces people who aren't workspace members.
  // Skipped entirely while locked — no point firing requests that will 403.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || directoryLocked) { setDirectoryResults([]); return undefined; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await settingsAPI.searchDirectory(q);
        const memberEmails = new Set((members || []).map((m) => String(m.email || '').toLowerCase()));
        setDirectoryResults((res.data || [])
          .filter((p) => p.mail && !memberEmails.has(p.mail.toLowerCase()) && !exclude.includes(p.mail.toLowerCase()))
          .slice(0, 5));
      } catch (err) {
        setDirectoryResults([]);
        // A genuine 403 flips the whole panel into the locked-directory UX.
        if (isForbidden(err)) onDirectoryLocked?.();
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, members, exclude, directoryLocked, onDirectoryLocked]);

  const pick = (email) => { onPick(String(email).toLowerCase()); setQuery(''); setDirectoryResults([]); setOpen(false); };

  // Free-text escape hatch: approvals key on email, so a fully-typed address
  // is always addable — with or without directory access.
  const typedEmail = query.trim().toLowerCase();
  const typedEmailAddable = EMAIL_RE.test(typedEmail)
    && !exclude.includes(typedEmail)
    && !memberResults.some((m) => m.email.toLowerCase() === typedEmail)
    && !directoryResults.some((p) => (p.mail || '').toLowerCase() === typedEmail);

  const row = (key, name, email, badge, photoUrl) => (
    <button
      key={key}
      type="button"
      onClick={() => pick(email)}
      className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-blue-50 dark:hover:bg-blue-500/15 tp-focus-ring"
    >
      <Avatar name={name} photoUrl={photoUrl} size="h-9 w-9" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground truncate">{name || email}</span>
        <span className="block text-xs text-muted-foreground truncate">{email}</span>
      </span>
      {badge && <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{badge}</span>}
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-300 shrink-0"><UserPlus className="w-3.5 h-3.5" /> Add</span>
    </button>
  );

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${directoryLocked ? 'text-muted-foreground/50' : 'text-muted-foreground/75'}`} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={directoryLocked
            ? 'Add an approval manager — search members and technicians, or type an email address…'
            : 'Add an approval manager — search members, technicians or the directory…'}
          className={`w-full pl-10 py-2.5 border border-input rounded-lg text-sm tp-focus-ring ${
            directoryLocked ? 'pr-10 bg-muted/50 text-muted-foreground placeholder:text-muted-foreground/75' : 'pr-3'
          }`}
        />
        {directoryLocked && (
          <button
            type="button"
            aria-label="Directory search unavailable — details"
            aria-expanded={lockInfoOpen}
            onClick={() => setLockInfoOpen((v) => !v)}
            onMouseEnter={() => setLockInfoOpen(true)}
            onMouseLeave={() => setLockInfoOpen(false)}
            className="tp-focus-ring absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-amber-500 hover:text-amber-600 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/15"
          >
            <Lock className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
        {directoryLocked && lockInfoOpen && (
          <div role="tooltip" className="absolute right-0 top-full mt-1.5 z-40 w-72 tp-card rounded-lg shadow-soft p-3 text-xs text-muted-foreground animate-scaleIn">
            <p className="flex items-start gap-1.5">
              <Lock className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" aria-hidden="true" />
              <span><strong className="text-foreground">Directory search needs admin access</strong> — you can still search workspace members, or type an email address to add anyone.</span>
            </p>
          </div>
        )}
      </div>
      {open && (
        <div className="absolute z-30 mt-1 w-full tp-card rounded-xl shadow-soft p-1.5 max-h-72 overflow-y-auto settings-scrollbar animate-scaleIn">
          {memberResults.map((m) => row(`m-${m.email}`, m.name, m.email, null, m.photoUrl))}
          {directoryResults.length > 0 && (
            <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">Directory</p>
          )}
          {directoryResults.map((p) => row(`d-${p.mail}`, p.displayName, p.mail, 'directory', p.photoUrl))}
          {typedEmailAddable && (
            <button
              type="button"
              onClick={() => pick(typedEmail)}
              className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-blue-50 dark:hover:bg-blue-500/15 tp-focus-ring"
            >
              <span className="h-9 w-9 rounded-full bg-blue-50 dark:bg-blue-500/15 border border-blue-100 dark:border-blue-500/20 inline-flex items-center justify-center shrink-0">
                <AtSign className="w-4 h-4 text-blue-500" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground truncate">Use this email address</span>
                <span className="block text-xs text-muted-foreground truncate">{typedEmail}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-300 shrink-0"><UserPlus className="w-3.5 h-3.5" /> Add</span>
            </button>
          )}
          {searching && <p className="px-3 py-2 text-xs text-muted-foreground/75">Searching directory…</p>}
          {!searching && memberResults.length === 0 && directoryResults.length === 0 && !typedEmailAddable && (
            <div className="px-3 py-4 text-sm text-muted-foreground/75">
              {query.trim().length >= 2
                ? `No one matches “${query}”.`
                : directoryLocked
                  ? 'Search workspace members, or type a full email address to add anyone.'
                  : 'Type at least 2 characters to search the directory.'}
              <span className="block text-[11px] mt-0.5">Anyone with an email can approve via the emailed link; members and admins can also decide in-app.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Enriched manager chip: avatar + display name (falls back to email). */
function ManagerChip({ email, member, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 text-xs text-blue-900 dark:text-blue-200">
      <Avatar name={member?.name || email} photoUrl={member?.photoUrl} size="h-5 w-5" />
      <span className="truncate max-w-[180px]">{member?.name || email}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${email}`} className="tp-focus-ring rounded-full p-0.5 hover:bg-blue-100 dark:hover:bg-blue-500/20 text-blue-500">
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** Read view: avatar + name, no pill (Vahid's taste, 18 Sep 2026). The address is one hover away. */
function PersonName({ email, member, showEmails = false }) {
  // Unknown to the member list → a readable name from the address ("Susan Manager"),
  // unless names could not be loaded at all, when the address itself is the honest label.
  const name = member?.name || (showEmails ? email : String(email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-foreground/85" title={email}>
      <Avatar name={name} photoUrl={member?.photoUrl} size="h-5 w-5" />
      <span className="truncate max-w-[180px] font-medium">{name}</span>
    </span>
  );
}

const MAX_TIERS = 3;
const emptyTier = (i) => ({ name: `Tier ${i + 1}`, managerEmails: [], limit: '' });
const emptyForm = { name: '', description: '', hasAmount: false, amountCurrency: 'CAD', gatesHardware: false, tiers: [emptyTier(0)] };

/** Category row → editable form shape (pre-v2 rows become a single tier). */
function formFromCategory(c) {
  const tiers = Array.isArray(c.tiers) && c.tiers.length
    ? c.tiers.map((t, i) => ({ name: t.name || `Tier ${i + 1}`, managerEmails: t.managerEmails || [], limit: t.limit === null || t.limit === undefined ? '' : String(t.limit) }))
    : [{ name: 'Tier 1', managerEmails: c.managerEmails || [], limit: '' }];
  return { name: c.name, description: c.description || '', hasAmount: c.hasAmount === true, amountCurrency: c.amountCurrency || 'CAD', gatesHardware: c.gatesHardware === true, tiers };
}

/** Form shape → API payload (tier 1 also mirrored to managerEmails for pre-v2 readers). */
function payloadFromForm(form) {
  const tiers = form.tiers.map((t, i) => ({
    name: (t.name || '').trim() || `Tier ${i + 1}`,
    managerEmails: t.managerEmails,
    limit: form.hasAmount && i < form.tiers.length - 1 && String(t.limit).trim() !== '' ? Number(String(t.limit).replace(/[^0-9.]/g, '')) : null,
  }));
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    managerEmails: tiers[0].managerEmails,
    tiers,
    hasAmount: form.hasAmount === true,
    gatesHardware: form.gatesHardware === true,
    amountCurrency: (form.amountCurrency || 'CAD').trim().toUpperCase(),
  };
}

const chainOf = (c) => (Array.isArray(c.tiers) && c.tiers.length ? c.tiers : [{ name: 'Tier 1', managerEmails: c.managerEmails || [], limit: null }]);
const money = (n, cur) => {
  if (n === null || n === undefined || n === '') return null;
  try { return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur || 'CAD' }).format(Number(n)); } catch { return `${cur || 'CAD'} ${n}`; }
};

function CategoryForm({ initial, members, memberByEmail, onCancel, onSave, saving, directoryLocked, onDirectoryLocked }) {
  const [form, setForm] = useState(initial || emptyForm);
  const setTier = (i, patch) => setForm((f) => ({ ...f, tiers: f.tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  const addEmail = (i, email) => setTier(i, { managerEmails: form.tiers[i].managerEmails.includes(email) ? form.tiers[i].managerEmails : [...form.tiers[i].managerEmails, email] });
  const removeEmail = (i, email) => setTier(i, { managerEmails: form.tiers[i].managerEmails.filter((x) => x !== email) });
  const addTier = () => setForm((f) => (f.tiers.length >= MAX_TIERS ? f : { ...f, tiers: [...f.tiers, emptyTier(f.tiers.length)] }));
  const removeTier = (i) => setForm((f) => ({ ...f, tiers: f.tiers.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, name: /^Tier \d$/.test(t.name) ? `Tier ${idx + 1}` : t.name })) }));

  const tierMissing = form.tiers.some((t) => t.managerEmails.length === 0);
  // Limits must climb tier by tier (the last tier has none).
  const limits = form.tiers.slice(0, -1).map((t) => (String(t.limit).trim() === '' ? null : Number(String(t.limit).replace(/[^0-9.]/g, ''))));
  const limitError = form.hasAmount && limits.some((l, i) => (l !== null && (!Number.isFinite(l) || l < 0)) || (i > 0 && l !== null && limits[i - 1] !== null && l <= limits[i - 1]));
  const canSave = form.name.trim().length >= 2 && !tierMissing && !limitError && !saving;

  return (
    <div className="tp-card p-4 border-blue-200 dark:border-blue-500/30 ring-1 ring-blue-100 dark:ring-blue-500/30 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Category name (e.g. Laptop purchase)"
          aria-label="Category name"
          className="w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
        />
        <input
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="Description (optional) — shown to the requester when picking"
          aria-label="Description"
          className="w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
        />
      </div>

      {/* Hardware toggle (Assetron, 24 Sep 2026) */}
      <label className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 cursor-pointer">
        <input type="checkbox" checked={form.gatesHardware === true} onChange={(e) => setForm((f) => ({ ...f, gatesHardware: e.target.checked }))} className="tp-focus-ring mt-0.5" aria-label="This category approves laptops" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85"><Laptop className="w-3.5 h-3.5 text-primary" aria-hidden="true" /> This category approves laptops</span>
          <span className="block text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            Requests may hold a new laptop in Assetron, assigned when approved. Assetron’s laptop check counts only approvals in these categories.
          </span>
        </span>
      </label>

      {/* Monetary toggle */}
      <label className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 cursor-pointer">
        <input type="checkbox" checked={form.hasAmount} onChange={(e) => setForm((f) => ({ ...f, hasAmount: e.target.checked }))} className="tp-focus-ring mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85"><BadgeDollarSign className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> This approval has an amount</span>
          <span className="block text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            Every request must state a total. Each tier can then carry a limit it may approve up to — an approval above the limit moves on to the next tier automatically.
          </span>
        </span>
        {form.hasAmount && (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground" onClick={(e) => e.preventDefault()}>
            Currency
            <input
              value={form.amountCurrency}
              onChange={(e) => setForm((f) => ({ ...f, amountCurrency: e.target.value.toUpperCase().slice(0, 3) }))}
              aria-label="Currency"
              className="tp-focus-ring w-16 rounded-lg border border-input bg-card px-2 py-1 text-xs font-semibold uppercase text-foreground"
            />
          </span>
        )}
      </label>

      {/* Tiers */}
      <div className="space-y-2.5">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Layers className="w-3.5 h-3.5" /> Approval tiers <span className="font-normal text-muted-foreground/75">— requests start at Tier 1; any approver there can decide, escalate to the next tier, or forward to anyone</span></p>
        {form.tiers.map((t, i) => {
          const last = i === form.tiers.length - 1;
          return (
            <div key={i} className="rounded-xl border border-border bg-card/60 p-3 space-y-2" aria-label={t.name || `Tier ${i + 1}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">{i + 1}</span>
                <input
                  value={t.name}
                  onChange={(e) => setTier(i, { name: e.target.value })}
                  aria-label={`Tier ${i + 1} name`}
                  placeholder={`Tier ${i + 1}`}
                  className="tp-focus-ring w-40 rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm font-semibold text-foreground"
                />
                {form.hasAmount && !last && (
                  <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                    may approve up to
                    <input
                      inputMode="decimal"
                      value={t.limit}
                      onChange={(e) => setTier(i, { limit: e.target.value })}
                      aria-label={`Tier ${i + 1} approval limit`}
                      placeholder="no limit"
                      className="tp-focus-ring w-28 rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm font-semibold tabular-nums text-foreground"
                    />
                    <span>{form.amountCurrency || 'CAD'}</span>
                  </label>
                )}
                {form.hasAmount && last && form.tiers.length > 1 && <span className="text-[11px] text-muted-foreground">final say — no limit</span>}
                {form.tiers.length > 1 && (
                  <button type="button" onClick={() => removeTier(i)} aria-label={`Remove ${t.name || `Tier ${i + 1}`}`} className="ml-auto tp-focus-ring p-1 rounded-md text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15">
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
              {t.managerEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.managerEmails.map((email) => (
                    <ManagerChip key={email} email={email} member={memberByEmail[email]} onRemove={() => removeEmail(i, email)} />
                  ))}
                </div>
              )}
              <MemberPicker members={members} exclude={t.managerEmails} onPick={(email) => addEmail(i, email)} directoryLocked={directoryLocked} onDirectoryLocked={onDirectoryLocked} />
              {t.managerEmails.length === 0 && <span className="text-[11px] text-amber-600 dark:text-amber-300">Add at least one approver to this tier</span>}
            </div>
          );
        })}
        {form.tiers.length < MAX_TIERS && (
          <button type="button" onClick={addTier} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-dashed border-input px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-blue-300">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add a tier {form.tiers.length === 1 ? '(e.g. Neville for what Vahid escalates)' : ''}
          </button>
        )}
        {limitError && <p role="alert" className="text-[11px] text-red-700 dark:text-red-200">Limits must be positive numbers and climb from tier to tier.</p>}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(payloadFromForm(form))}
          disabled={!canSave}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50 tp-focus-ring"
        >
          {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tp-focus-ring">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        {tierMissing && <span className="text-[11px] text-amber-600 dark:text-amber-300">Every tier needs at least one approver</span>}
      </div>
    </div>
  );
}

export default function ApprovalCategoriesPanel() {
  const { currentWorkspace } = useWorkspace();
  const [categories, setCategories] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  // QA 08-17 #7 — reviewer-safe lookups: a 403 on directory search greys the
  // picker with an amber note instead of the red error banner (red = real
  // failures only). Member lookup failing is likewise informational.
  const [directoryLocked, setDirectoryLocked] = useState(false);
  const [membersUnavailable, setMembersUnavailable] = useState(false);

  const memberByEmail = useMemo(() => {
    const map = {};
    for (const m of members) if (m.email) map[m.email.toLowerCase()] = m;
    return map;
  }, [members]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // The category list is the panel's core — only ITS failure is a real error.
    try {
      const cats = await settingsAPI.getApprovalCategories();
      setCategories(cats.data || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load approval categories');
      setLoading(false);
      return;
    }
    // Member names/avatars are best-effort enrichment via the reviewer-reachable
    // tickets meta (chips fall back to raw emails). Never blanks the categories.
    try {
      const meta = await ticketsAPI.meta();
      // QA 09-15 #8: read-only and reviewer members are not technicians, yet
      // any of them can be an approval manager (they may already decide
      // approvals addressed to them). Merge the workspace grants in, keyed by
      // e-mail, so Neville-the-observer is one click away.
      const techs = meta.data?.technicians || [];
      const seen = new Set(techs.map((t) => String(t.email || '').toLowerCase()));
      const extra = (meta.data?.members || [])
        .filter((m) => m.email && !seen.has(m.email))
        .map((m) => ({ id: `member:${m.email}`, name: m.name || m.email, email: m.email, photoUrl: m.photoUrl || null, role: m.role, isActive: true }));
      setMembers([...techs, ...extra]);
      setMembersUnavailable(false);
    } catch {
      setMembers([]);
      setMembersUnavailable(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  // Probe directory access once per workspace: q < 2 chars returns an empty
  // 200 AFTER the role gate, so a 403 here means "locked" without ever
  // hitting Entra. Lets the picker render pre-greyed instead of failing later.
  useEffect(() => {
    let cancelled = false;
    setDirectoryLocked(false);
    settingsAPI.searchDirectory('').catch((err) => {
      if (!cancelled && isForbidden(err)) setDirectoryLocked(true);
    });
    return () => { cancelled = true; };
  }, [currentWorkspace?.id]);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const create = async (form) => {
    setSaving(true); setError(null);
    try {
      await settingsAPI.createApprovalCategory(form);
      flash(`“${form.name.trim()}” created.`);
      setCreating(false);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setSaving(false); }
  };

  const saveEdit = async (id, form) => {
    setSaving(true); setError(null);
    try {
      await settingsAPI.updateApprovalCategory(id, form);
      flash('Category updated.');
      setEditingId(null);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setSaving(false); }
  };

  const toggleActive = async (c) => {
    setError(null);
    try {
      await settingsAPI.updateApprovalCategory(c.id, { isActive: !c.isActive });
      flash(`“${c.name}” ${c.isActive ? 'deactivated' : 'reactivated'}.`);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
  };

  const remove = async (c) => {
    setError(null);
    try {
      await settingsAPI.deleteApprovalCategory(c.id);
      flash(`“${c.name}” deleted.`);
      setConfirmDeleteId(null);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
  };

  return (
    <div className="space-y-3">
      {/* Small header: title + count, the action on the right, the explainer folded away. */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-500/15"><Stamp className="w-4 h-4 text-blue-600 dark:text-blue-300" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Approval categories
            {Array.isArray(categories) && categories.length > 0 && <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{categories.length}</span>}
          </h3>
          <p className="text-xs text-muted-foreground">What needs sign-off, and who signs it — tier by tier.</p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => { setCreating(true); setEditingId(null); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-semibold hover:bg-blue-700 tp-focus-ring"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New approval category
          </button>
        )}
      </div>
      <details className="group text-xs text-muted-foreground">
        <summary className="tp-focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded font-medium text-blue-700 hover:underline dark:text-blue-200 [&::-webkit-details-marker]:hidden">
          <ArrowRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true" /> How approvals work
        </summary>
        <p className="mt-1.5 max-w-3xl leading-relaxed">
          Define what needs sign-off (e.g. <strong>Laptop purchase</strong>) and which <strong>members</strong> approve it.
          On a ticket, a member requests approval by category and every Tier-1 manager is notified — <strong>any one</strong> can
          approve, reject, ask for more info, <strong>escalate</strong> to the next tier, or <strong>forward</strong> to anyone as the final approver.
          Monetary categories carry an amount; a tier limit sends bigger amounts up automatically. Approvals stay inside Ticket Pulse.
          Workspace <strong>reviewers</strong> and admins manage these here on the Approvals page — no admin needed.
        </p>
      </details>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-sm text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg text-sm text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /><span>{successMsg}</span>
        </div>
      )}
      {(directoryLocked || membersUnavailable) && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg text-sm text-amber-800 dark:text-amber-200">
          <Lock className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
          <span>
            {directoryLocked
              ? 'Directory search needs admin access — you can still add approval managers by typing their full email address.'
              : 'Member names could not be loaded right now — manager chips show email addresses, and you can still add managers by email.'}
          </span>
        </div>
      )}

      {creating && (
        <CategoryForm members={members} memberByEmail={memberByEmail} onCancel={() => setCreating(false)} onSave={create} saving={saving} directoryLocked={directoryLocked} onDirectoryLocked={() => setDirectoryLocked(true)} />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground/75"><Loader className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
      ) : (categories || []).length === 0 ? (
        <p className="text-sm text-muted-foreground/75 italic px-1">No approval categories yet. Create one above to enable ticket approvals.</p>
      ) : (
        <div className="space-y-1.5">
          {categories.map((c) => (
            editingId === c.id ? (
              <CategoryForm
                key={c.id}
                initial={formFromCategory(c)}
                members={members}
                memberByEmail={memberByEmail}
                onCancel={() => setEditingId(null)}
                onSave={(form) => saveEdit(c.id, form)}
                saving={saving}
                directoryLocked={directoryLocked}
                onDirectoryLocked={() => setDirectoryLocked(true)}
              />
            ) : (
              <div key={c.id} className={`group/cat relative rounded-lg border px-3.5 py-2.5 ${c.isActive ? 'border-border bg-card' : 'border-dashed border-input bg-muted/70'}`}>
                {!c.isActive && <span className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg bg-red-400" aria-hidden="true" />}
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    {/* Line 1: name · description, one line */}
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className={`text-sm font-semibold whitespace-nowrap ${c.isActive ? 'text-foreground' : 'text-muted-foreground'}`}>{c.name}</span>
                      {c.gatesHardware && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary whitespace-nowrap" title="Approves laptops (Assetron)">
                          <Laptop className="w-3 h-3" aria-hidden="true" /> laptops
                        </span>
                      )}
                      {c.hasAmount && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 whitespace-nowrap" title="Requests carry an amount">
                          <BadgeDollarSign className="w-3 h-3" aria-hidden="true" /> {c.amountCurrency || 'CAD'}
                        </span>
                      )}
                      {!c.isActive && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 dark:text-red-300 whitespace-nowrap"><Ban className="w-3 h-3" aria-hidden="true" /> Inactive</span>
                      )}
                      {c.description && <span className="truncate text-xs text-muted-foreground" title={c.description}>{c.description}</span>}
                    </div>
                    {/* Line 2: the approval chain — tier, its people, the next tier */}
                    {(c.managerEmails || []).length === 0 ? (
                      <p className="text-[11px] text-amber-600 dark:text-amber-300 mt-1">No approvers yet — add some so this can be used</p>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {chainOf(c).map((t, i, all) => (
                          <span key={i} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                            {i > 0 && <ArrowRight className="w-3 h-3 text-muted-foreground/50" aria-hidden="true" />}
                            {all.length > 1 && (
                              <span className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">
                                {t.name || `Tier ${i + 1}`}
                                {c.hasAmount && t.limit !== null && t.limit !== undefined ? <span className="font-normal text-muted-foreground/75"> · up to {money(t.limit, c.amountCurrency)}</span> : null}
                              </span>
                            )}
                            {(t.managerEmails || []).map((email) => (
                              <PersonName key={email} email={email} member={memberByEmail[email.toLowerCase()]} showEmails={membersUnavailable} />
                            ))}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 transition-opacity md:opacity-50 md:group-hover/cat:opacity-100 md:focus-within:opacity-100">
                    <button onClick={() => { setEditingId(c.id); setCreating(false); }} title="Edit" className="p-1.5 text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 rounded-lg tp-focus-ring"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => toggleActive(c)} title={c.isActive ? 'Deactivate' : 'Reactivate'} className={`p-1.5 rounded-lg tp-focus-ring ${c.isActive ? 'text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300' : 'text-emerald-600 dark:text-emerald-300 hover:text-emerald-700 dark:hover:text-emerald-200'}`}>
                      {c.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                    </button>
                    {confirmDeleteId === c.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button onClick={() => remove(c)} className="px-2 py-1 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 tp-focus-ring">Delete</button>
                        <button onClick={() => setConfirmDeleteId(null)} className="p-1 text-muted-foreground/75 hover:text-muted-foreground rounded tp-focus-ring"><X className="w-4 h-4" /></button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(c.id)} title="Delete" className="p-1.5 text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 rounded-lg tp-focus-ring"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
