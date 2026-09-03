import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, Building2, Check, ChevronDown, Clock, Loader2, MapPin,
  Paperclip, Send, Sparkles, Ticket, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { ticketsAPI } from '../services/api';
import CcChips from '../components/tickets/CcChips';
import RichTextEditor, { isRichContent, sanitizeRichHtml } from '../components/tickets/RichTextEditor';
import StagedFileChip from '../components/tickets/StagedFileChip';
import ImageMarkupModal from '../components/tickets/ImageMarkupModal';
import AutofillModal, { matchByName } from '../components/tickets/AutofillModal';
import { PRIORITY_LABELS, SOURCE_OPTIONS, initials } from '../components/tickets/ticketUi';
import RequesterTypeahead, { EMAIL_RE, toPickedRequester } from '../components/tickets/RequesterTypeahead';
import { useTicketTypes } from '../hooks/useTicketTypes';

const MAX_FILES = 5;
const MAX_FILE_MB = 100;

// Selected-state classes per registry color token (Tailwind needs literals).
const TYPE_SELECTED_CLASSES = {
  slate: 'bg-slate-600 text-white border-slate-600',
  orange: 'bg-orange-500 text-white border-orange-500',
  violet: 'bg-violet-600 text-white border-violet-600',
  red: 'bg-red-600 text-white border-red-600',
  blue: 'bg-blue-600 text-white border-blue-600',
  emerald: 'bg-emerald-600 text-white border-emerald-600',
  amber: 'bg-amber-500 text-white border-amber-500',
  cyan: 'bg-cyan-600 text-white border-cyan-600',
  pink: 'bg-pink-600 text-white border-pink-600',
};

const pad2 = (n) => String(n).padStart(2, '0');
const toLocalDatetimeInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain narrative → paragraphs (blank line = new <p>, single newline = <br>). */
const narrativeToHtml = (text) => String(text || '')
  .trim()
  .split(/\n{2,}/)
  .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
  .join('');

/**
 * Autofill's category hint may arrive as "Hardware" or "Hardware > Laptop"
 * (also "/", "›", "→" separators). Resolve it against the workspace tree,
 * case-insensitively; returns null when the top level has no match.
 */
const resolveCategoryHint = (hint, tree) => {
  if (!hint || !Array.isArray(tree) || !tree.length) return null;
  // Split on the explicit hierarchy separators first; only treat "/" as a
  // separator when the hint carries none of them ("AI / SaaS Licensing" and
  // "Laptop / Desktop …" are single subcategory NAMES, not levels).
  const raw = String(hint);
  const parts = (/[>›→»]/.test(raw) ? raw.split(/\s*[>›→»]\s*/) : raw.split(/\s*\/\s*/)).map((p) => p.trim()).filter(Boolean);
  const topName = matchByName(parts[0], tree.map((c) => c.name));
  const top = topName ? tree.find((c) => c.name === topName) : null;
  if (!top) return null;
  const subName = parts.length > 1 ? matchByName(parts[parts.length - 1], (top.subcategories || []).map((s) => s.name)) : null;
  const sub = subName ? (top.subcategories || []).find((s) => s.name === subName) : null;
  return { categoryId: String(top.id), subcategoryId: sub ? String(sub.id) : '' };
};

/**
 * Type the text into the requester typeahead exactly as a person would — it
 * owns its query state and exposes only focus() — so its debounced search
 * opens with the candidates for the agent to confirm. (Follow-up: expose a
 * setQuery on the typeahead's imperative handle and drop this.)
 */
const typeIntoRequesterSearch = (inputId, text) => {
  const input = document.getElementById(inputId);
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, text); else input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  return true;
};

/**
 * Full-page composer for creating a native (TP-born) ticket — its own route
 * (`/tickets/new`) with a two-column layout: the form on the left, and a live
 * assignment + requester-context rail on the right. Requester comes from a
 * typeahead over known requesters + the Entra directory (free-typed emails
 * still work), and a picked person is enriched with their photo, org details,
 * and helpdesk history.
 */
export default function TicketCreate() {
  const navigate = useNavigate();

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [descriptionText, setDescriptionText] = useState('');
  const [priority, setPriority] = useState(2);
  // Per-workspace type registry: options, default, and pill colors all come
  // from Settings → Ticket Ops → Ticket types ('Case' for Accounting, …).
  const { activeTypes, defaultType } = useTicketTypes();
  const [ticketType, setTicketType] = useState(null);
  useEffect(() => {
    if (ticketType === null && defaultType) setTicketType(defaultType.name);
  }, [ticketType, defaultType]);
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [source, setSource] = useState(103); // arrival channel (QA 07-10 #7); Agent = logged in app
  const [tagIds, setTagIds] = useState([]); // gap plan 2 P1.3
  // Workspace custom fields (FR 08-05 #1 Phase 1c) — same intake surface the
  // public API offers, for parity. Collapsed by default; hidden when the
  // workspace has no definitions.
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [customFieldValues, setCustomFieldValues] = useState({});
  // assignMode / aiClassify / notifyRequester / source / group start from the
  // WORKSPACE's form config (meta.form, Mega 08-23 Phase TF) once meta lands —
  // these useState values are only the pre-meta fallback and match the config
  // service's own defaults ('none' is both; the old resetForm 'ai' was a bug).
  const [assignMode, setAssignMode] = useState('none'); // ai | me | pick | none
  const [assignTechId, setAssignTechId] = useState('');
  const [aiClassify, setAiClassify] = useState(true); // AI classifies + assesses priority/type (independent of assignment)
  const [cc, setCc] = useState([]);
  const [notifyRequester, setNotifyRequester] = useState(true);
  const [fieldErrors, setFieldErrors] = useState({}); // key → message (required validation)
  const [createTemplates, setCreateTemplates] = useState([]);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [editFile, setEditFile] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStep, setSaveStep] = useState(null);
  const [error, setError] = useState(null);
  const [successNote, setSuccessNote] = useState(null);
  const [submitMenuOpen, setSubmitMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  // Repeat pattern: the picked first date/time anchors it (its weekday /
  // day-of-month / month) — no extra pickers needed (QA 07-13 #2).
  const [scheduleRepeat, setScheduleRepeat] = useState('none');
  const fileInputRef = useRef(null);
  const pasteCountRef = useRef(0);

  // ---- Autofill (Mega 08-31 Phase AF) ----
  // touchedRef remembers which fields the AGENT set by hand (or via a
  // template) so an autofill apply never clobbers them — it only fills gaps.
  // A field cleared back to empty is untouched again.
  const [autofillOpen, setAutofillOpen] = useState(false);
  const [autofillNotice, setAutofillNotice] = useState(null);
  // Autofill v2: the intake run that filled this form, so the create call
  // can link it (AI & Routing shows what the model proposed vs what stuck).
  const [intakeRunId, setIntakeRunId] = useState(null);
  const touchedRef = useRef(new Set());
  const markTouched = (key, filled = true) => {
    if (filled) touchedRef.current.add(key); else touchedRef.current.delete(key);
  };

  // ---- Requester typeahead (shared RequesterTypeahead, Phase ET3) ----
  const [requester, setRequester] = useState(null); // {id?, name, email, hint, jobTitle, department, location, fromDirectory}
  const [rqQuery, setRqQuery] = useState(''); // typed text — a bare valid email is accepted without a pick
  const [rqEnrich, setRqEnrich] = useState({ photo: null, stats: null }); // Entra photo + history for the rail card
  const rqRef = useRef(null);

  useEffect(() => {
    ticketsAPI.meta()
      .then((res) => setMeta(res.data))
      .catch((err) => setMetaError(err.response?.data?.message || 'Could not load ticket options'));
    ticketsAPI.createTemplates()
      .then((res) => setCreateTemplates(res?.data || []))
      .catch(() => setCreateTemplates([]));
    ticketsAPI.customFieldDefinitions()
      .then((res) => setCustomFieldDefs(res?.data || []))
      .catch(() => setCustomFieldDefs([]));
  }, []);

  // Pre-fill the form from a saved preset. Only fields the template SETS are
  // touched — everything the agent already typed elsewhere is left alone.
  // The picker can be used BEFORE meta lands (templates are a tiny query;
  // meta is the slow one), so remember the pick: the one-time config seed
  // below re-applies it after seeding priority/type (QA 08-26 #2).
  const appliedTemplateRef = useRef(null);
  const applyCreateTemplate = (templateId) => {
    const template = createTemplates.find((t) => t.id === templateId);
    if (!template) return;
    appliedTemplateRef.current = template;
    // A template is the agent's deliberate pick — autofill treats its fields
    // as touched too.
    if (template.subject) { setSubject(template.subject); markTouched('subject'); }
    if (template.description) {
      const html = isRichContent(template.description)
        ? template.description
        : `<p>${String(template.description).replace(/\n/g, '<br>')}</p>`;
      setDescription(html);
      setDescriptionText(String(template.description));
      markTouched('description');
    }
    if (template.priority) { setPriority(template.priority); markTouched('priority'); }
    if (template.ticketType) { setTicketType(template.ticketType); markTouched('type'); }
    if (template.internalCategoryId) { setCategoryId(String(template.internalCategoryId)); markTouched('category'); }
    if (template.internalSubcategoryId) setSubcategoryId(String(template.internalSubcategoryId));
  };

  /**
   * Land the reviewed autofill proposals on the form (Phase AF). Mirrors
   * applyCreateTemplate's "only touch what's SET" rule PLUS never overwrites a
   * field the agent already filled. Requester is resolved through the real
   * search: auto-picked ONLY on a single exact-email match, otherwise the
   * typeahead opens pre-filled for the agent to confirm — a fuzzy name is
   * never silently turned into a person.
   */
  const applyAutofill = async ({ result, meta: runMeta, selected, sourceHtml, sourceText, files: dumpFiles }) => {
    const touched = touchedRef.current;
    const want = (key) => Boolean(selected?.[key]) && !touched.has(key);
    const notices = [];

    if (runMeta?.runId != null && Number.isFinite(Number(runMeta.runId))) setIntakeRunId(Number(runMeta.runId));

    if (want('subject') && result.subject) {
      setSubject(String(result.subject).trim().slice(0, 500));
    }

    // v2: the server builds the structured description (Request / details /
    // Next step / Discussed with) as HTML + plain text; the v1 narrative
    // string is still honoured for older responses.
    const structuredHtml = typeof result.descriptionHtml === 'string' && result.descriptionHtml.trim() ? sanitizeRichHtml(result.descriptionHtml) : '';
    const structuredText = typeof result.descriptionText === 'string' ? result.descriptionText.trim() : '';
    const legacyNarrative = typeof result.description === 'string' ? result.description.trim() : '';
    if (want('description') && (structuredHtml || structuredText || legacyNarrative)) {
      const narrativeHtml = structuredHtml || narrativeToHtml(structuredText || legacyNarrative);
      const narrativeText = structuredText || legacyNarrative || String(result.description?.request || '').trim();
      const dump = sourceHtml ? sanitizeRichHtml(sourceHtml) : '';
      const dumpHasContent = Boolean((sourceText || '').trim()) || /<img\b/i.test(dump);
      // AF3: when the only text in the paste was the agent's own note (detected and
      // applied as instructions), label the dump honestly instead of "source material".
      const notesOnlyDump = Boolean(result.technicianNotes)
        && String(sourceText || '').replace(/\[Image:[^\]]*\]/gi, '').trim() === String(result.technicianNotes).trim();
      const dumpLabel = notesOnlyDump ? 'Your notes to the AI (applied above)' : 'Source material (pasted)';
      // No <hr>/<details> — neither is in the composer's sanitizer allow-list;
      // a spaced bold heading survives edit/re-sanitize round-trips.
      const html = narrativeHtml + (dumpHasContent
        ? `<p><br></p><p><strong>— ${dumpLabel} —</strong></p><div>${dump}</div>`
        : '');
      setDescription(html);
      setDescriptionText(dumpHasContent ? `${narrativeText}\n\n— ${dumpLabel} —\n${sourceText || ''}` : narrativeText);
    }

    // Assignee (v2): only a clean technician match reaches here (the modal
    // never ticks an ambiguous one). Lands as an explicit "Assign to…" pick —
    // AI assignment stays off, exactly as if the agent had chosen them.
    // (Guarded here too, not just by the modal's locked row: an explicit
    // "me" / picked member is never overwritten.)
    const assigneeLocked = assignMode === 'me' || (assignMode === 'pick' && Boolean(assignTechId));
    if (want('assignee') && !assigneeLocked && result.assigneeMatch?.status === 'matched' && result.assigneeMatch.technician?.id != null) {
      const tech = result.assigneeMatch.technician;
      const known = (meta?.technicians || []).some((t) => String(t.id) === String(tech.id));
      if (known) {
        setAssignMode('pick');
        setAssignTechId(String(tech.id));
      } else {
        notices.push(`${tech.name || 'The named member'} isn’t on this workspace’s member list — choose the assignee under Assignment.`);
      }
    }

    let classified = false;
    if (want('priority')) {
      const p = Number(result.priorityHint);
      if (p >= 1 && p <= 4) {
        setPriority(p);
        classified = true;
        // AF3: a priority the agent stated in their notes is theirs — pin it so
        // nothing later (templates, AI assessment) can quietly downgrade it.
        if (result.priorityFrom === 'notes') markTouched('priority');
      }
    }
    if (want('type') && result.typeHint) {
      const name = matchByName(result.typeHint, activeTypes.map((t) => t.name));
      if (name) { setTicketType(name); classified = true; }
    }
    if (want('category') && result.categoryHint) {
      const hit = resolveCategoryHint(result.categoryHint, meta?.categoryTree);
      if (hit) { setCategoryId(hit.categoryId); setSubcategoryId(hit.subcategoryId); classified = true; }
    }
    if (classified && aiClassify) {
      setAiClassify(false);
      notices.push('AI classification turned off so your accepted values stick — turn it back on if you’d rather let AI decide.');
    }

    // Screenshots ride along as normal staged attachments (originals, not
    // the shrunk copies the AI saw).
    const originals = Array.from(dumpFiles || []);
    if (originals.length) {
      const room = Math.max(0, MAX_FILES - files.length);
      if (originals.length > room) {
        notices.push(room === 0
          ? `The form already holds ${MAX_FILES} files — none of the ${originals.length} screenshots were attached.`
          : `Only ${room} of ${originals.length} screenshots attached — the form holds ${MAX_FILES} files.`);
      }
      addFiles(originals);
    }

    setAutofillOpen(false);
    setAutofillNotice(notices.length ? notices.join(' ') : null);

    // Requester last: it may hand focus to the typeahead.
    const requesterHint = String(result.requesterNameOrEmail || '').trim();
    const rqMatch = result.requesterMatch && typeof result.requesterMatch === 'object' ? result.requesterMatch : null;
    if (want('requester') && !requester && !rqQuery.trim() && rqMatch?.status === 'matched' && rqMatch.candidate?.email) {
      // v2: the server already resolved the person — select them the same
      // way the typeahead's own pick does (known requester → id; directory
      // hit → id-less Entra person, created with the ticket).
      const c = rqMatch.candidate;
      const fromDirectory = c.source === 'directory' || c.requesterId == null;
      setRequester(toPickedRequester({
        id: fromDirectory ? null : c.requesterId,
        name: c.name || String(c.email).split('@')[0],
        email: String(c.email).toLowerCase(),
        jobTitle: c.jobTitle || null,
        department: c.department || null,
      }, fromDirectory));
    } else if (want('requester') && !requester && !rqQuery.trim() && rqMatch?.status === 'ambiguous') {
      // Several people fit — open the search pre-filled and let the agent pick.
      const seed = requesterHint || rqMatch.candidate?.name || rqMatch.candidates?.[0]?.name || '';
      if (seed) setTimeout(() => typeIntoRequesterSearch('tc-requester', seed), 0);
    } else if (want('requester') && requesterHint && !requester && !rqQuery.trim()) {
      let picked = null;
      try {
        const res = await ticketsAPI.requesterSearch(requesterHint);
        const known = (res?.data?.requesters || []).filter((p) => String(p.email || '').toLowerCase() === requesterHint.toLowerCase());
        const directory = (res?.data?.directory || []).filter((p) => String(p.email || '').toLowerCase() === requesterHint.toLowerCase());
        if (known.length === 1) picked = toPickedRequester(known[0], false);
        else if (known.length === 0 && directory.length === 1) picked = toPickedRequester(directory[0], true);
      } catch { /* fall through to the typeahead */ }
      if (picked) setRequester(picked);
      else setTimeout(() => typeIntoRequesterSearch('tc-requester', requesterHint), 0);
    }
  };

  useEffect(() => { rqRef.current?.focus(); }, [meta]);

  const typedEmailOk = EMAIL_RE.test(rqQuery.trim());
  const requesterReady = Boolean(requester) || typedEmailOk;

  const addFiles = (picked) => {
    setError(null);
    const incoming = Array.from(picked || []);
    const tooBig = incoming.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (tooBig) { setError(`"${tooBig.name}" is over ${MAX_FILE_MB} MB`); return; }
    setFiles((prev) => {
      const merged = [...prev];
      for (const file of incoming) {
        if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
      }
      return merged.slice(0, MAX_FILES);
    });
  };

  const subcategories = useMemo(() => {
    const top = (meta?.categoryTree || []).find((c) => String(c.id) === String(categoryId));
    return top?.subcategories || [];
  }, [meta, categoryId]);

  const canTakeMyself = Boolean(meta?.actor?.technicianId);

  // ---- Workspace form config (Mega 08-23 Phase TF) ----
  // meta.form drives visibility, required-ness, and initial values for the
  // built-in blocks. TP composer only — FS-owned forms are untouched.
  const form = meta?.form || null;
  const formFields = useMemo(() => new Map((form?.fields || []).map((f) => [f.key, f])), [form]);
  const fieldVisible = (key) => !formFields.size || formFields.get(key)?.visible !== false;
  const fieldRequired = (key) => formFields.get(key)?.required === true;

  /** The config's initial values (used at first meta load AND by resetForm). */
  const formDefaults = () => {
    const groupDefault = form?.defaultGroup || null;
    // Only preselect a default group that actually exists in this workspace's
    // pickable groups — a stale id must not render a blank select.
    let groupValue = '';
    if (groupDefault?.kind === 'fs' && (meta?.groups || []).some((g) => g.origin !== 'local' && String(g.freshserviceId) === String(groupDefault.id))) {
      groupValue = `fs:${groupDefault.id}`;
    } else if (groupDefault?.kind === 'internal' && (meta?.groups || []).some((g) => g.origin === 'local' && String(g.id) === String(groupDefault.id))) {
      groupValue = `int:${groupDefault.id}`;
    }
    return {
      priority: Number(formFields.get('priority')?.defaultValue) || 2,
      ticketType: formFields.get('type')?.defaultValue || defaultType?.name || null,
      source: form?.defaultSource ?? 103,
      groupId: groupValue,
      notifyRequester: form?.defaults?.notifyRequester !== false,
      aiClassify: form?.defaults?.aiClassify !== false,
      assignMode: form?.defaults?.assignMode === 'ai' ? 'ai' : 'none',
    };
  };

  /** Custom-field defaults (Phase TF): defaultValue prefills, coerced per type. */
  const customFieldDefaultValues = () => {
    const values = {};
    for (const def of customFieldDefs) {
      if (def.defaultValue === null || def.defaultValue === undefined || def.defaultValue === '') continue;
      values[def.key] = def.type === 'boolean' ? String(def.defaultValue) === 'true'
        : def.type === 'number' ? Number(def.defaultValue)
          : String(def.defaultValue);
    }
    return values;
  };
  const hasRequiredCustomFields = customFieldDefs.some((d) => d.isRequiredOnCreate === true);

  // One-time init once meta (and defs) have landed: seed the form from the
  // workspace config instead of the hardcoded fallbacks above.
  const formInitRef = useRef(false);
  useEffect(() => {
    if (!meta || formInitRef.current) return;
    formInitRef.current = true;
    const d = formDefaults();
    setPriority(d.priority);
    if (d.ticketType) setTicketType(d.ticketType);
    setSource(d.source);
    setGroupId(d.groupId);
    setNotifyRequester(d.notifyRequester);
    setAiClassify(d.aiClassify);
    setAssignMode(d.assignMode);
    // A template picked before meta landed wins over the config defaults
    // for the fields it sets (the seed above would otherwise clobber them).
    const picked = appliedTemplateRef.current;
    if (picked?.priority) setPriority(picked.priority);
    if (picked?.ticketType) setTicketType(picked.ticketType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);
  const cfInitRef = useRef(false);
  useEffect(() => {
    if (!customFieldDefs.length || cfInitRef.current) return;
    cfInitRef.current = true;
    const defaults = customFieldDefaultValues();
    if (Object.keys(defaults).length) setCustomFieldValues((prev) => ({ ...defaults, ...prev }));
    // Required custom fields must be visible, not buried in a collapsed section.
    if (customFieldDefs.some((d) => d.isRequiredOnCreate === true)) setCustomFieldsOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customFieldDefs]);

  const goBack = () => navigate('/tickets');

  const resetForm = () => {
    // Back to the WORKSPACE's configured defaults (Phase TF) — the same
    // values the form opened with, killing the old 'none'-on-mount vs
    // 'ai'-on-reset inconsistency.
    const d = formDefaults();
    setSubject('');
    setDescription('');
    setDescriptionText('');
    setPriority(d.priority);
    setTicketType(d.ticketType);
    setCategoryId('');
    setSubcategoryId('');
    setGroupId(d.groupId);
    setSource(d.source);
    setTagIds([]);
    setAssignMode(d.assignMode);
    setAssignTechId('');
    setCc([]);
    setNotifyRequester(d.notifyRequester);
    setCustomFieldValues(customFieldDefaultValues());
    setCustomFieldsOpen(hasRequiredCustomFields);
    setFieldErrors({});
    setFiles([]);
    setRequester(null);
    setRqQuery('');
    touchedRef.current = new Set();
    setAutofillNotice(null);
    setIntakeRunId(null);
    setTimeout(() => rqRef.current?.focus(), 0);
  };

  // What autofill must leave alone right now (shown as "kept as is" rows).
  const autofillLocked = () => {
    const keys = Array.from(touchedRef.current);
    if (requester || rqQuery.trim()) keys.push('requester');
    // An explicit assignment choice ("me", or a picked member) is the agent's.
    if (assignMode === 'me' || (assignMode === 'pick' && assignTechId)) keys.push('assignee');
    return keys;
  };

  /**
   * Required-field validation (Phase TF): visible required built-ins +
   * required custom fields. Returns {key → message}; empty object = OK.
   * Category/subcategory are skipped when the AI will classify (they're the
   * model's to fill — mirrors the server's enforcement rule).
   */
  const validateRequired = () => {
    const errors = {};
    const need = (key, ok, message) => {
      if (fieldVisible(key) && fieldRequired(key) && !ok) errors[key] = message;
    };
    need('description', Boolean(descriptionText.trim()), 'A description is required');
    if (!aiDecides) {
      need('category', Boolean(categoryId), 'Pick a category');
      if (subcategories.length > 0) need('subcategory', Boolean(subcategoryId), 'Pick a subcategory');
    }
    need('group', Boolean(groupId), 'Pick a group');
    need('tags', tagIds.length > 0, 'Pick at least one tag');
    need('cc', cc.length > 0, 'Add at least one additional requester');
    need('attachments', files.length > 0, 'Attach at least one file');
    for (const def of customFieldDefs) {
      if (def.isRequiredOnCreate !== true) continue;
      const v = customFieldValues[def.key];
      if (v === '' || v === null || v === undefined) errors[`cf:${def.key}`] = `${def.label} is required`;
    }
    return errors;
  };

  /** afterAction: 'open' navigates to the new ticket, 'new' resets, 'resolve' resolves then navigates, 'schedule' queues. */
  const submit = async (e, afterAction = 'open') => {
    e?.preventDefault?.();
    setSubmitMenuOpen(false);
    setError(null);
    setSuccessNote(null);
    // Required gate (Phase TF) — inline errors under each block + a summary.
    const requiredErrors = validateRequired();
    setFieldErrors(requiredErrors);
    if (Object.keys(requiredErrors).length > 0) {
      if (Object.keys(requiredErrors).some((k) => k.startsWith('cf:'))) setCustomFieldsOpen(true);
      setError('This workspace requires a few more fields — see the highlighted ones below.');
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        subject: subject.trim(),
        description: descriptionText.trim()
          ? (isRichContent(description) ? description : descriptionText.trim())
          : null,
        priority: Number(priority),
        ticketType,
        requesterId: requester?.id || null,
        requesterEmail: requester?.email || (typedEmailOk ? rqQuery.trim() : null),
        requesterName: requester?.name || null,
        internalCategoryId: categoryId ? Number(categoryId) : null,
        internalSubcategoryId: subcategoryId ? Number(subcategoryId) : null,
        groupId: groupId.startsWith('fs:') ? Number(groupId.slice(3)) : null,
        internalGroupId: groupId.startsWith('int:') ? Number(groupId.slice(4)) : null,
        // AI, decoupled from assignment: 'ai' assignment runs the FULL pipeline
        // (which classifies + assesses too); otherwise aiClassify runs an
        // assessment-only pass that never touches the assignee.
        runAiTriage: assignMode === 'ai',
        aiClassifyOnly: aiClassify && assignMode !== 'ai',
        notifyRequester,
        ccEmails: cc,
        tagIds,
        source: Number(source),
      };
      // Only send custom fields that were actually filled in.
      const filledCustomFields = Object.fromEntries(
        Object.entries(customFieldValues).filter(([, v]) => v !== '' && v !== null && v !== undefined),
      );
      if (Object.keys(filledCustomFields).length > 0) payload.customFields = filledCustomFields;
      if (assignMode === 'me' && canTakeMyself) payload.assignedTechId = meta.actor.technicianId;
      if (assignMode === 'pick' && assignTechId) payload.assignedTechId = Number(assignTechId);

      if (afterAction === 'schedule') {
        if (!scheduleAt) throw new Error('Pick a date and time to schedule for');
        setSaveStep('Scheduling…');
        const schedRes = await ticketsAPI.scheduleCreate(payload, new Date(scheduleAt).toISOString(), { recurrence: scheduleRepeat });
        // Files stage against the schedule and attach when it activates (P2).
        // Repeating schedules skip staged files (they'd only reach the first
        // spawn) — the composer hides the hint for them.
        if (scheduleRepeat === 'none' && files.length > 0 && schedRes.data?.id) {
          setSaveStep(`Staging ${files.length} file${files.length === 1 ? '' : 's'}…`);
          try {
            await ticketsAPI.uploadScheduledAttachments(schedRes.data.id, files);
          } catch (uploadErr) {
            console.warn('Staged attachment upload failed:', uploadErr);
          }
        }
        setIsSaving(false);
        setSaveStep(null);
        setSuccessNote(scheduleRepeat === 'none'
          ? `Scheduled for ${new Date(scheduleAt).toLocaleString()} — it gets its TP number (and any attachments) at activation`
          : `Repeating ${scheduleRepeat} — first ticket ${new Date(scheduleAt).toLocaleString()}, then every ${scheduleRepeat === 'weekly' ? 'week' : scheduleRepeat === 'monthly' ? 'month' : 'year'} at the same local time`);
        setScheduleOpen(false);
        setScheduleAt('');
        setScheduleRepeat('none');
        resetForm();
        return;
      }

      setSaveStep('Creating ticket…');
      // Link the Autofill run (v2) so the ticket's AI & Routing tab can show
      // what was proposed vs what the agent kept.
      const res = await ticketsAPI.create(intakeRunId != null ? { ...payload, intakeRunId } : payload);
      const created = res.data;

      if (files.length > 0) {
        setSaveStep(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
        try {
          await ticketsAPI.uploadAttachments(created.id, files);
        } catch (uploadErr) {
          console.warn('Attachment upload failed after create:', uploadErr);
        }
      }

      if (cc.length > 0) {
        try {
          localStorage.setItem(`tp_ticket_draft_${created.id}`, JSON.stringify({ body: '', cc, mode: 'reply', savedAt: Date.now() }));
        } catch { /* no-op */ }
      }

      if (afterAction === 'resolve') {
        setSaveStep('Resolving…');
        try { await ticketsAPI.setStatus(created.id, 'Resolved'); } catch { /* shown on detail */ }
      }

      if (afterAction === 'new') {
        setIsSaving(false);
        setSaveStep(null);
        setSuccessNote(`${created.displayRef} created`);
        resetForm();
        return;
      }
      navigate(`/tickets/${created.id}`);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to create ticket');
      setIsSaving(false);
      setSaveStep(null);
    }
  };

  const fieldClass = 'tp-focus-ring w-full text-sm bg-card border border-input rounded-lg px-3 py-2.5 text-foreground placeholder:text-muted-foreground/75';
  const labelClass = 'block text-sm font-semibold text-foreground/85 mb-1.5';
  const submitDisabled = isSaving || !subject.trim() || !requesterReady || (assignMode === 'pick' && !assignTechId);

  const ticketingOn = meta ? meta.nativeTicketingEnabled : true;
  // When AI will classify, category/subcategory/priority/type are AI-owned —
  // grey the manual controls so it's clear you don't need to set them.
  const aiDecides = aiClassify || assignMode === 'ai';

  if (metaError) {
    return (
      <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
        <AppHeader activePage="tickets" />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" aria-hidden="true" />
          <p className="text-foreground/85 font-medium">{metaError}</p>
          <button onClick={goBack} className="mt-4 tp-focus-ring px-4 py-2 text-sm font-medium rounded-lg bg-card border border-border hover:bg-muted/50">Back to tickets</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="tickets" />

      {/* pb clears the sticky action bar + the mobile tab bar under it (QA 07-06 #11).
          md band (iPad): a little extra so the last field never hides behind the bar. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 pb-44 md:pb-32 lg:pb-5">
        {/* Header / breadcrumb */}
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={goBack}
            aria-label="Back to tickets"
            className="tp-focus-ring p-2 rounded-lg text-muted-foreground bg-card/70 border border-card/70 shadow-subtle hover:text-foreground/85 hover:bg-card"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground/75 font-medium">
              <button onClick={goBack} className="tp-focus-ring rounded hover:text-muted-foreground">Tickets</button>
              <span aria-hidden="true">/</span>
              <span className="text-muted-foreground">New</span>
            </div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Ticket className="w-5 h-5 text-blue-600 dark:text-blue-300" aria-hidden="true" />
              New ticket
            </h1>
          </div>
        </div>

        {!ticketingOn && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-xl text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            Native ticketing is off for this workspace — the ticket will still be created in Ticket Pulse.
          </div>
        )}

        {successNote && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-xl text-sm text-emerald-800 dark:text-emerald-200" role="status">
            <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            {successNote} — ready for the next one.
          </div>
        )}

        {!meta ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground/75">
            <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
          </div>
        ) : (
          <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
            {/* ---- Main column ---- */}
            <div className="lg:col-span-2 space-y-5">
              <div className="tp-card rounded-2xl p-5 space-y-5">
                {/* Requester */}
                <div className="relative">
                  <label htmlFor="tc-requester" className={labelClass}>Requester <span className="text-red-500">*</span></label>
                  <RequesterTypeahead
                    ref={rqRef}
                    inputId="tc-requester"
                    value={requester}
                    onChange={setRequester}
                    onQueryChange={setRqQuery}
                    onEnrich={setRqEnrich}
                    fieldClass={fieldClass}
                  />
                  {fieldVisible('cc') && (
                    <div className="mt-3" data-testid="also-for-block">
                      {/* "Also for" = additional requesters (Phase MR3, QA 08-26 #3):
                          stored as the ticket's ccEmails — every reply to the
                          requester reaches them, and the FS copy carries them. */}
                      <div className="flex items-baseline justify-between gap-2 mb-1">
                        <span className="text-xs font-semibold text-muted-foreground">
                          Also for <span className="font-normal text-muted-foreground/75">(additional requesters{fieldRequired('cc') ? ', required' : ''})</span>
                        </span>
                        <span className="text-[11px] text-muted-foreground/75">They receive every reply to the requester</span>
                      </div>
                      <CcChips
                        value={cc}
                        onChange={setCc}
                        prefix="Also for"
                        label="Also for (additional requesters)"
                        placeholder={`Add additional requesters by name or email…${fieldRequired('cc') ? ' (required)' : ''}`}
                      />
                      {fieldErrors.cc && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.cc}</p>}
                    </div>
                  )}
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={!notifyRequester}
                      onChange={(e) => setNotifyRequester(!e.target.checked)}
                      className="tp-focus-ring rounded border-input text-blue-600 dark:text-blue-300"
                    />
                    Don’t email the requester about this ticket
                  </label>
                </div>

                {/* Starting points: a saved template and/or Autofill from a
                    paste (Phase AF). Autofill only PROPOSES — the agent
                    reviews per field and applies; user-typed fields are
                    never overwritten. */}
                <div className={`flex gap-3 ${createTemplates.length > 0 ? 'flex-col sm:flex-row sm:items-end' : 'flex-col sm:flex-row sm:items-center sm:justify-between'}`}>
                  {createTemplates.length > 0 ? (
                    <div className="min-w-0 flex-1">
                      <label htmlFor="tc-template" className={labelClass}>Start from a template</label>
                      <select
                        id="tc-template"
                        value=""
                        onChange={(e) => applyCreateTemplate(Number(e.target.value))}
                        className={fieldClass}
                      >
                        <option value="">Choose a template… (optional)</option>
                        {createTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground min-w-0">
                      Got a Teams chat, an email or screenshots? Let AI draft the fields — you review every one.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setAutofillOpen(true)}
                    disabled={!meta}
                    title="Paste a chat, email or screenshots — AI proposes subject, description, requester, category, priority and type for you to review"
                    className="tp-focus-ring inline-flex items-center justify-center gap-1.5 flex-shrink-0 rounded-lg border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 px-3 py-2.5 text-sm font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20 disabled:opacity-50 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" aria-hidden="true" />
                    Autofill
                  </button>
                </div>

                {autofillNotice && (
                  <div className="flex items-start gap-2 -mt-1 px-3 py-2 rounded-lg bg-indigo-50/70 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-[11px] text-indigo-700 dark:text-indigo-200" role="status" data-testid="autofill-notice">
                    <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span className="flex-1">{autofillNotice}</span>
                    <button type="button" onClick={() => setAutofillNotice(null)} aria-label="Dismiss" className="tp-focus-ring rounded p-0.5 hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20">
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                )}

                <div>
                  <label htmlFor="tc-subject" className={labelClass}>Subject <span className="text-red-500">*</span></label>
                  <input
                    id="tc-subject"
                    type="text"
                    required
                    minLength={3}
                    maxLength={500}
                    value={subject}
                    onChange={(e) => { setSubject(e.target.value); markTouched('subject', Boolean(e.target.value.trim())); }}
                    placeholder="Short summary of the issue or request"
                    className={fieldClass}
                  />
                </div>

                {fieldVisible('description') && (
                  <div>
                    <span className={labelClass}>Description{fieldRequired('description') && <span className="text-red-500"> *</span>}</span>
                    <RichTextEditor
                      value={description}
                      onChange={({ html, text }) => { setDescription(html); setDescriptionText(text); markTouched('description', Boolean(text.trim())); }}
                      placeholder="What happened, where, since when, error messages…"
                      ariaLabel="Description"
                      minHeight={240}
                      onImagePaste={(file) => {
                        const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
                        const name = `pasted-image-${++pasteCountRef.current}.${ext}`;
                        addFiles([new File([file], name, { type: file.type || 'image/png' })]);
                        return name;
                      }}
                    />
                    {fieldErrors.description && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.description}</p>}
                  </div>
                )}

                {/* Attachments — staged files sit up top (prominent), add-zone below */}
                {fieldVisible('attachments') && (
                  <div>
                    <span className={labelClass}>Attachments{fieldRequired('attachments') && <span className="text-red-500"> *</span>}{files.length > 0 ? ` (${files.length})` : ''}</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                      className="sr-only"
                      aria-label="Choose files to attach"
                    />
                    {files.length > 0 && (
                      <ul className="mb-2 flex flex-wrap gap-2.5 items-start">
                        {files.map((file) => (
                          <StagedFileChip
                            key={`${file.name}-${file.size}`}
                            file={file}
                            onRemove={() => setFiles((prev) => prev.filter((f) => f !== file))}
                            onEdit={() => setEditFile(file)}
                          />
                        ))}
                      </ul>
                    )}
                    <div
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                      className={`rounded-xl border-2 border-dashed text-center transition-colors ${files.length > 0 ? 'px-3 py-3' : 'px-3 py-5'} ${
                        dragOver ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-muted/20'
                      }`}
                    >
                      <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                        <Paperclip className={`w-4 h-4 ${dragOver ? 'text-blue-500' : 'text-muted-foreground/50'}`} aria-hidden="true" />
                      Drag files here, paste a screenshot into the description, or{' '}
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={files.length >= MAX_FILES}
                          className="tp-focus-ring rounded font-semibold text-blue-600 dark:text-blue-300 hover:underline disabled:opacity-50"
                        >
                        browse
                        </button>
                      </p>
                      <p className="text-[10px] text-muted-foreground/75 mt-0.5">{files.length}/{MAX_FILES} · up to {MAX_FILE_MB} MB each</p>
                    </div>
                    {fieldErrors.attachments && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.attachments}</p>}
                  </div>
                )}
              </div>

              {/* Classification card — category/subcategory/priority/type are
                  AI-owned when triage is on. Field blocks render per the
                  workspace form config (Phase TF); the card disappears when
                  every one of its fields is hidden. */}
              {['type', 'priority', 'category', 'subcategory', 'source', 'group'].some(fieldVisible) && (
                <div className="tp-card rounded-2xl p-5 space-y-5">
                  {aiDecides && (
                    <div className="flex items-start gap-2 -mt-1 px-3 py-2 rounded-lg bg-indigo-50/70 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-[11px] text-indigo-700 dark:text-indigo-200">
                      <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    AI will set category, subcategory, priority and type on create. Turn off “Classify &amp; assess with AI” to set them yourself.
                    </div>
                  )}
                  {(fieldVisible('type') || fieldVisible('priority')) && (
                    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity ${aiDecides ? 'opacity-50' : ''}`}>
                      {fieldVisible('type') && (
                        <div>
                          <span className={labelClass}>Type</span>
                          {activeTypes.length > 4 ? (
                            <select
                              value={ticketType ?? ''}
                              disabled={aiDecides}
                              onChange={(e) => { setTicketType(e.target.value); markTouched('type'); }}
                              aria-label="Ticket type"
                              className="tp-focus-ring w-full rounded-lg border border-border bg-card px-2 py-2 text-xs font-semibold text-muted-foreground disabled:cursor-not-allowed"
                            >
                              {activeTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                            </select>
                          ) : (
                            <div
                              role="group"
                              aria-label="Ticket type"
                              className={`grid gap-1.5 ${['grid-cols-1', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-2'][activeTypes.length] || 'grid-cols-2'}`}
                            >
                              {activeTypes.map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  disabled={aiDecides}
                                  onClick={() => { setTicketType(t.name); markTouched('type'); }}
                                  aria-pressed={ticketType === t.name}
                                  title={t.description || undefined}
                                  className={`tp-focus-ring px-2 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:cursor-not-allowed ${
                                    ticketType === t.name
                                      ? (TYPE_SELECTED_CLASSES[t.color] || TYPE_SELECTED_CLASSES.slate)
                                      : 'bg-card text-muted-foreground border-border hover:border-input'
                                  }`}
                                >
                                  {t.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {fieldVisible('priority') && (
                        <div>
                          <span className={labelClass}>Priority</span>
                          <div role="group" aria-label="Priority" className="grid grid-cols-4 gap-1.5">
                            {[1, 2, 3, 4].map((p) => (
                              <button
                                key={p}
                                type="button"
                                disabled={aiDecides}
                                onClick={() => { setPriority(p); markTouched('priority'); }}
                                aria-pressed={priority === p}
                                className={`tp-focus-ring px-2 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:cursor-not-allowed ${
                                  priority === p
                                    ? p === 4 ? 'bg-red-600 text-white border-red-600'
                                      : p === 3 ? 'bg-amber-500 text-white border-amber-500'
                                        : p === 2 ? 'bg-emerald-600 text-white border-emerald-600'
                                          : 'bg-blue-500 text-white border-blue-500'
                                    : 'bg-card text-muted-foreground border-border hover:border-input'
                                }`}
                              >
                                {PRIORITY_LABELS[p]}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(fieldVisible('category') || fieldVisible('subcategory')) && (
                    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity ${aiDecides ? 'opacity-50' : ''}`}>
                      {fieldVisible('category') && (
                        <div>
                          <label htmlFor="tc-category" className={labelClass}>Category{fieldRequired('category') && <span className="text-red-500"> *</span>}</label>
                          <select
                            id="tc-category"
                            value={categoryId}
                            disabled={aiDecides}
                            onChange={(e) => { setCategoryId(e.target.value); setSubcategoryId(''); markTouched('category', Boolean(e.target.value)); }}
                            className={`${fieldClass} disabled:bg-muted/50 disabled:text-muted-foreground/75 disabled:cursor-not-allowed`}
                          >
                            <option value="">{aiDecides ? 'AI will choose' : 'Choose a category'}</option>
                            {(() => {
                              // Scope by the chosen FS group (gap plan P2.3); unmapped
                              // categories stay visible everywhere.
                              const tree = meta?.categoryTree || [];
                              const links = meta?.categoryGroupLinks || [];
                              const gid = groupId.startsWith('fs:') ? groupId.slice(3) : null;
                              if (!links.length || !gid) return tree.map((c) => <option key={c.id} value={c.id}>{c.name}</option>);
                              const mapped = new Set(links.map((l) => l.categoryId));
                              const allowed = new Set(links.filter((l) => l.groupId === gid).map((l) => l.categoryId));
                              return tree
                                .filter((c) => !mapped.has(c.id) || allowed.has(c.id) || String(c.id) === categoryId)
                                .map((c) => <option key={c.id} value={c.id}>{c.name}</option>);
                            })()}
                          </select>
                          {fieldErrors.category && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.category}</p>}
                        </div>
                      )}
                      {fieldVisible('subcategory') && (
                        <div>
                          <label htmlFor="tc-subcategory" className={labelClass}>Subcategory{fieldRequired('subcategory') && <span className="text-red-500"> *</span>}</label>
                          <select
                            id="tc-subcategory"
                            value={subcategoryId}
                            onChange={(e) => setSubcategoryId(e.target.value)}
                            disabled={aiDecides || !categoryId || subcategories.length === 0}
                            className={`${fieldClass} disabled:bg-muted/50 disabled:text-muted-foreground/75 disabled:cursor-not-allowed`}
                          >
                            <option value="">{aiDecides ? 'AI will choose' : '—'}</option>
                            {subcategories.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                          {fieldErrors.subcategory && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.subcategory}</p>}
                        </div>
                      )}
                    </div>
                  )}

                  {fieldVisible('source') && (
                    <div>
                      <label htmlFor="tc-source" className={labelClass}>Source</label>
                      <select id="tc-source" value={source} onChange={(e) => setSource(Number(e.target.value))} className={fieldClass}>
                        {SOURCE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-[11px] text-muted-foreground/75">How the request reached you — phone call, walk-up, Teams message…</p>
                    </div>
                  )}

                  {fieldVisible('group') && (meta?.groups?.length || 0) > 0 && (
                    <div>
                      <label htmlFor="tc-group" className={labelClass}>Group{fieldRequired('group') && <span className="text-red-500"> *</span>}</label>
                      <select id="tc-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} className={fieldClass}>
                        <option value="">No group</option>
                        {meta.groups.some((g) => g.origin === 'local') && (
                          <optgroup label="Internal groups">
                            {meta.groups.filter((g) => g.origin === 'local').map((g) => (
                              <option key={`int-${g.id}`} value={`int:${g.id}`}>{g.name}</option>
                            ))}
                          </optgroup>
                        )}
                        {meta.groups.some((g) => g.origin !== 'local') && (
                          <optgroup label="FreshService groups">
                            {meta.groups.filter((g) => g.origin !== 'local').map((g) => (
                              <option key={`fs-${g.id}`} value={`fs:${g.freshserviceId}`}>{g.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      {form?.defaultGroup && groupId === (form.defaultGroup.kind === 'fs' ? `fs:${form.defaultGroup.id}` : `int:${form.defaultGroup.id}`) && (
                        <p className="mt-1 text-[11px] text-muted-foreground/75">Preselected — this workspace&apos;s default group for new tickets.</p>
                      )}
                      {fieldErrors.group && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.group}</p>}
                    </div>
                  )}
                </div>
              )}

              {/* Tags at creation (gap plan 2 P1.3). Impact/Urgency removed
                  from the form per QA 07-13 #5 — still editable on the detail
                  sidebar for the rare ticket that needs them. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {fieldVisible('tags') && (meta?.tags?.length || 0) > 0 && (
                  <div>
                    <span className={labelClass}>Tags{fieldRequired('tags') && <span className="text-red-500"> *</span>}</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {meta.tags.map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => setTagIds((prev) => (prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))}
                          aria-pressed={tagIds.includes(tag.id)}
                          className={`tp-focus-ring px-2 py-0.5 rounded-full border text-[11px] font-medium transition-colors ${
                            tagIds.includes(tag.id)
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-card text-muted-foreground border-border hover:border-blue-300 dark:hover:border-blue-500/40'
                          }`}
                        >
                          {tag.name}
                        </button>
                      ))}
                    </div>
                    {fieldErrors.tags && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors.tags}</p>}
                  </div>
                )}
              </div>

              {/* Custom fields (FR 08-05 #1 Phase 1c) — the workspace's own
                  intake metadata, mirroring what API senders can set at create.
                  Collapsed by default; absent when nothing is defined. */}
              {customFieldDefs.length > 0 && (
                <div className="tp-card rounded-2xl p-5">
                  <button
                    type="button"
                    onClick={() => setCustomFieldsOpen((v) => !v)}
                    aria-expanded={customFieldsOpen}
                    className="tp-focus-ring w-full flex items-center gap-2 text-left"
                  >
                    <span className="text-sm font-semibold text-foreground/85">Custom fields</span>
                    <span className="text-[11px] text-muted-foreground/75">
                      {Object.values(customFieldValues).filter((v) => v !== '' && v !== null && v !== undefined).length > 0
                        ? `${Object.values(customFieldValues).filter((v) => v !== '' && v !== null && v !== undefined).length} set`
                        : (hasRequiredCustomFields ? 'some required' : 'optional')}
                    </span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground/75 ml-auto transition-transform ${customFieldsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  {customFieldsOpen && (
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {customFieldDefs.map((def) => {
                        const value = customFieldValues[def.key] ?? '';
                        const set = (v) => setCustomFieldValues((prev) => ({ ...prev, [def.key]: v }));
                        return (
                          <div key={def.key}>
                            <label htmlFor={`tc-cf-${def.key}`} className={labelClass}>
                              {def.label}
                              {def.isRequiredOnCreate === true && <span className="text-red-500"> *</span>}
                            </label>
                            {def.type === 'select' ? (
                              <select id={`tc-cf-${def.key}`} value={value} onChange={(e) => set(e.target.value)} className={fieldClass}>
                                <option value="">—</option>
                                {(def.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                              </select>
                            ) : def.type === 'boolean' ? (
                              <select id={`tc-cf-${def.key}`} value={String(value)} onChange={(e) => set(e.target.value === '' ? '' : e.target.value === 'true')} className={fieldClass}>
                                <option value="">—</option>
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            ) : (
                              <input
                                id={`tc-cf-${def.key}`}
                                type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                                value={value}
                                onChange={(e) => set(def.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
                                className={fieldClass}
                              />
                            )}
                            {fieldErrors[`cf:${def.key}`] && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{fieldErrors[`cf:${def.key}`]}</p>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-xl" role="alert">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
                </div>
              )}
            </div>

            {/* ---- Right rail ---- */}
            <div className="lg:sticky lg:top-4 space-y-5">
              {/* Requester context */}
              {requester && (
                <div className="tp-card rounded-2xl p-4">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/75 mb-2.5">Requester</p>
                  <div className="flex items-center gap-3">
                    {rqEnrich.photo ? (
                      <img src={rqEnrich.photo} alt="" className="h-11 w-11 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <span className="h-11 w-11 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200 inline-flex items-center justify-center text-sm font-semibold flex-shrink-0">
                        {initials(requester.name)}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">{requester.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{requester.email}</p>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    {requester.jobTitle && (
                      <div className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /><span className="truncate">{requester.jobTitle}{requester.department ? ` · ${requester.department}` : ''}</span></div>
                    )}
                    {requester.location && (
                      <div className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /><span className="truncate">{requester.location}</span></div>
                    )}
                    {rqEnrich.stats && (rqEnrich.stats.total ?? rqEnrich.stats.totalTickets) != null && (
                      <div className="flex items-center gap-1.5 text-muted-foreground"><Ticket className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /><span>{rqEnrich.stats.total ?? rqEnrich.stats.totalTickets} previous ticket{(rqEnrich.stats.total ?? rqEnrich.stats.totalTickets) === 1 ? '' : 's'}</span></div>
                    )}
                  </dl>
                  {requester.fromDirectory && (
                    <p className="mt-2.5 text-[11px] text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/15 rounded-lg px-2 py-1.5">New to Ticket Pulse — created from the Entra directory with this ticket.</p>
                  )}
                </div>
              )}

              {/* AI on this ticket — assessment, independent of assignment */}
              <div className="tp-card rounded-2xl p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/75 mb-2.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-500" aria-hidden="true" /> AI on this ticket
                </p>
                <label className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${(aiClassify || assignMode === 'ai') ? 'border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/50 dark:bg-indigo-500/10' : 'border-border bg-card hover:border-indigo-200 dark:hover:border-indigo-500/30'} ${assignMode === 'ai' ? 'opacity-70' : ''}`}>
                  <input
                    type="checkbox"
                    checked={aiClassify || assignMode === 'ai'}
                    disabled={assignMode === 'ai'}
                    onChange={(e) => setAiClassify(e.target.checked)}
                    className="tp-focus-ring mt-0.5 rounded border-input text-indigo-600 dark:text-indigo-300"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground/85">Classify &amp; assess with AI</span>
                    <span className="block text-[11px] text-muted-foreground">Sets category · subcategory · priority · incident/request — leaves the assignee alone.</span>
                  </span>
                </label>
                {assignMode === 'ai' && (
                  <p className="mt-1.5 text-[11px] text-indigo-600 dark:text-indigo-300">Included automatically with AI assignment below.</p>
                )}
              </div>

              {/* Assignment */}
              <div className="tp-card rounded-2xl p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/75 mb-2.5">Assignment</p>
                <div className="space-y-1.5">
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'ai' ? 'border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-500/10' : 'border-border bg-card hover:border-blue-200 dark:hover:border-blue-500/30'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'ai'} onChange={() => setAssignMode('ai')} className="tp-focus-ring" />
                    <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
                    <span className="text-sm text-foreground/85">AI recommends an assignee</span>
                  </label>
                  {canTakeMyself && (
                    <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'me' ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:border-blue-200 dark:hover:border-blue-500/30'}`}>
                      <input type="radio" name="tc-assign" checked={assignMode === 'me'} onChange={() => setAssignMode('me')} className="tp-focus-ring" />
                      <span className="text-sm text-foreground/85">Assign to me</span>
                    </label>
                  )}
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'pick' ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:border-blue-200 dark:hover:border-blue-500/30'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'pick'} onChange={() => setAssignMode('pick')} className="tp-focus-ring" />
                    <span className="text-sm text-foreground/85">Assign to…</span>
                    <select
                      value={assignTechId}
                      onChange={(e) => { setAssignTechId(e.target.value); setAssignMode('pick'); }}
                      onClick={() => setAssignMode('pick')}
                      aria-label="Member to assign"
                      className="tp-focus-ring ml-auto text-sm bg-card border border-input rounded-lg px-2 py-1 text-foreground/85 max-w-[8rem]"
                    >
                      <option value="">Choose…</option>
                      {(meta?.technicians || []).map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'none' ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:border-blue-200 dark:hover:border-blue-500/30'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'none'} onChange={() => setAssignMode('none')} className="tp-focus-ring" />
                    <span className="text-sm text-foreground/85">Leave unassigned</span>
                  </label>
                </div>
              </div>

              {/* Create actions — on mobile the sticky bottom bar owns this, so hide here */}
              <div className="tp-card rounded-2xl p-4 hidden lg:block">
                {scheduleOpen && (
                  <div className="mb-3 p-2.5 rounded-lg border border-violet-200 dark:border-violet-500/30 bg-violet-50/50 dark:bg-violet-500/10">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">Schedule for later</span>
                      <button
                        onClick={() => { setScheduleOpen(false); setScheduleAt(''); setScheduleRepeat('none'); }}
                        type="button"
                        aria-label="Cancel scheduling"
                        className="tp-focus-ring p-1 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-card"
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                    <input
                      type="datetime-local"
                      value={scheduleAt}
                      min={toLocalDatetimeInput(new Date(Date.now() + 5 * 60 * 1000))}
                      onChange={(e) => setScheduleAt(e.target.value)}
                      aria-label="Schedule ticket for"
                      className="tp-focus-ring w-full text-sm bg-card border border-input rounded-lg px-2.5 py-2 text-foreground/85"
                    />
                    <select
                      value={scheduleRepeat}
                      onChange={(e) => setScheduleRepeat(e.target.value)}
                      aria-label="Repeat"
                      title="Repeats at the picked time — weekly on that weekday, monthly on that day, yearly on that date"
                      className="tp-focus-ring w-full mt-2 text-sm bg-card border border-input rounded-lg px-2 py-2 text-foreground/85"
                    >
                      <option value="none">One time</option>
                      <option value="weekly">Repeat weekly</option>
                      <option value="monthly">Repeat monthly</option>
                      <option value="yearly">Repeat yearly</option>
                    </select>
                  </div>
                )}
                <div className="flex">
                  {scheduleOpen ? (
                    <button
                      onClick={(e) => submit(e, 'schedule')}
                      disabled={submitDisabled || !scheduleAt}
                      className="tp-focus-ring flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-violet-600 text-white text-sm font-semibold rounded-lg shadow-subtle hover:bg-violet-700 disabled:opacity-50 transition-colors"
                    >
                      {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Clock className="w-4 h-4" aria-hidden="true" />}
                      {isSaving ? (saveStep || 'Scheduling…') : (scheduleAt ? 'Schedule ticket' : 'Pick a date to schedule')}
                    </button>
                  ) : (
                    <button
                      onClick={(e) => submit(e, 'open')}
                      disabled={submitDisabled}
                      className="tp-focus-ring flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-l-lg shadow-subtle hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
                      {isSaving ? (saveStep || 'Creating…') : 'Create ticket'}
                    </button>
                  )}
                  {!scheduleOpen && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setSubmitMenuOpen((v) => !v)}
                        disabled={submitDisabled}
                        aria-label="More create options"
                        aria-expanded={submitMenuOpen}
                        className="tp-focus-ring h-full px-2 py-2.5 bg-primary text-primary-foreground rounded-r-lg border-l border-blue-500/60 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        <ChevronDown className="w-4 h-4" aria-hidden="true" />
                      </button>
                      {submitMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 w-56 tp-card rounded-lg shadow-soft p-1 animate-scaleIn z-20" role="menu">
                          <button
                            onClick={(e) => submit(e, 'new')}
                            role="menuitem"
                            className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-muted-foreground hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-700 dark:hover:text-blue-200"
                          >
                          Create & start another
                          </button>
                          <button
                            onClick={(e) => submit(e, 'resolve')}
                            role="menuitem"
                            className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-muted-foreground hover:bg-emerald-50 dark:hover:bg-emerald-500/15 hover:text-emerald-700 dark:hover:text-emerald-200"
                          >
                          Create & resolve (walk-up log)
                          </button>
                          <button
                            onClick={() => { setScheduleOpen(true); setSubmitMenuOpen(false); }}
                            role="menuitem"
                            className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-muted-foreground hover:bg-violet-50 dark:hover:bg-violet-500/15 hover:text-violet-700 dark:hover:text-violet-200 flex items-center gap-2"
                          >
                            <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Schedule for later…
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={goBack} type="button" className="tp-focus-ring w-full mt-2 px-4 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50">
                  Cancel
                </button>
                <p className="mt-3 text-[11px] text-muted-foreground/75 leading-relaxed">Born in Ticket Pulse — mirrored to FreshService as a fallback copy.</p>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Sticky mobile action bar — Create is otherwise buried at the bottom of a
          long scroll. Under md it sits ABOVE the bottom tab bar (QA 07-06 #11).
          md band (iPad, QA 08-04 #4): the old `md:pb-safe` collapsed to 0px
          padding when env(safe-area-inset-bottom) was 0, and left Cancel under
          the home indicator when it wasn't — pb now floors at 12px and grows
          with the inset. z-50 keeps the bar above page content/overlays. */}
      {meta && (
        <div className="lg:hidden fixed bottom-[calc(48px+env(safe-area-inset-bottom))] md:bottom-0 inset-x-0 z-50 bg-card/95 backdrop-blur border-t border-border px-4 pt-3 pb-3 md:pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center gap-2 shadow-[0_-4px_16px_-8px_rgba(15,23,42,0.25)] dark:shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.6)]">
          <button
            type="button"
            onClick={goBack}
            className="tp-focus-ring px-4 min-h-[44px] text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={(e) => submit(e, 'open')}
            disabled={submitDisabled}
            className="tp-focus-ring flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 bg-primary text-primary-foreground text-sm font-semibold rounded-lg shadow-subtle hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
            {isSaving ? (saveStep || 'Creating…') : 'Create ticket'}
          </button>
        </div>
      )}

      {editFile && (
        <ImageMarkupModal
          file={editFile}
          onCancel={() => setEditFile(null)}
          onSave={(edited) => {
            setFiles((prev) => prev.map((f) => (f === editFile ? edited : f)));
            setEditFile(null);
          }}
        />
      )}

      {/* Autofill (Phase AF) — mounted only once meta is here so category/type
          hints always have a vocabulary to resolve against. */}
      {meta && autofillOpen && (
        <AutofillModal
          open
          onClose={() => setAutofillOpen(false)}
          onApply={applyAutofill}
          lockedFields={autofillLocked()}
          categoryNames={(meta.categoryTree || []).flatMap((c) => [c.name, ...((c.subcategories || []).map((sc) => `${c.name} > ${sc.name}`))])}
          typeNames={activeTypes.map((t) => t.name)}
        />
      )}

      <MobileTabBar />
    </div>
  );
}
