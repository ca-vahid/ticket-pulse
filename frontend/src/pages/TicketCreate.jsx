import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, Building2, Check, ChevronDown, Clock, Loader2, MapPin,
  Paperclip, Search, Send, Sparkles, Ticket, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { ticketsAPI } from '../services/api';
import CcChips from '../components/tickets/CcChips';
import RichTextEditor, { isRichContent } from '../components/tickets/RichTextEditor';
import StagedFileChip from '../components/tickets/StagedFileChip';
import ImageMarkupModal from '../components/tickets/ImageMarkupModal';
import { PRIORITY_LABELS, SOURCE_OPTIONS, initials } from '../components/tickets/ticketUi';

const MAX_FILES = 5;
const MAX_FILE_MB = 100;
const TICKET_TYPES = ['Incident', 'Service Request'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad2 = (n) => String(n).padStart(2, '0');
const toLocalDatetimeInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

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
  const [ticketType, setTicketType] = useState('Incident');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [source, setSource] = useState(103); // arrival channel (QA 07-10 #7); Agent = logged in app
  const [tagIds, setTagIds] = useState([]); // gap plan 2 P1.3
  const [impact, setImpact] = useState('');
  const [urgency, setUrgency] = useState('');
  const [assignMode, setAssignMode] = useState('none'); // ai | me | pick | none
  const [assignTechId, setAssignTechId] = useState('');
  const [aiClassify, setAiClassify] = useState(true); // AI classifies + assesses priority/type (independent of assignment)
  const [cc, setCc] = useState([]);
  const [notifyRequester, setNotifyRequester] = useState(true);
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
  const fileInputRef = useRef(null);
  const pasteCountRef = useRef(0);

  // ---- Requester typeahead ----
  const [requester, setRequester] = useState(null); // {id?, name, email, hint, jobTitle, department, location, fromDirectory}
  const [rqQuery, setRqQuery] = useState('');
  const [rqResults, setRqResults] = useState(null);
  const [rqOpen, setRqOpen] = useState(false);
  const [rqLoading, setRqLoading] = useState(false);
  const [rqPhoto, setRqPhoto] = useState(null);
  const [rqStats, setRqStats] = useState(null);
  const rqRef = useRef(null);
  const rqInputRef = useRef(null);

  useEffect(() => {
    ticketsAPI.meta()
      .then((res) => setMeta(res.data))
      .catch((err) => setMetaError(err.response?.data?.message || 'Could not load ticket options'));
    ticketsAPI.createTemplates()
      .then((res) => setCreateTemplates(res?.data || []))
      .catch(() => setCreateTemplates([]));
  }, []);

  // Pre-fill the form from a saved preset. Only fields the template SETS are
  // touched — everything the agent already typed elsewhere is left alone.
  const applyCreateTemplate = (templateId) => {
    const template = createTemplates.find((t) => t.id === templateId);
    if (!template) return;
    if (template.subject) setSubject(template.subject);
    if (template.description) {
      const html = isRichContent(template.description)
        ? template.description
        : `<p>${String(template.description).replace(/\n/g, '<br>')}</p>`;
      setDescription(html);
      setDescriptionText(String(template.description));
    }
    if (template.priority) setPriority(template.priority);
    if (template.ticketType) setTicketType(template.ticketType);
    if (template.internalCategoryId) setCategoryId(String(template.internalCategoryId));
    if (template.internalSubcategoryId) setSubcategoryId(String(template.internalSubcategoryId));
  };

  useEffect(() => { rqInputRef.current?.focus(); }, [meta]);

  useEffect(() => {
    const q = rqQuery.trim();
    if (q.length < 2) { setRqResults(null); return undefined; }
    setRqLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await ticketsAPI.requesterSearch(q);
        setRqResults(res.data);
        setRqOpen(true);
      } catch { setRqResults(null); }
      setRqLoading(false);
    }, 300);
    return () => { clearTimeout(timer); setRqLoading(false); };
  }, [rqQuery]);

  useEffect(() => {
    const onDoc = (e) => { if (rqRef.current && !rqRef.current.contains(e.target)) setRqOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Enrich the picked requester: photo (Entra) + helpdesk history (known ones).
  useEffect(() => {
    setRqPhoto(null);
    setRqStats(null);
    if (!requester?.email) return;
    let alive = true;
    ticketsAPI.requesterPhoto(requester.email)
      .then((res) => { if (alive) setRqPhoto(res.data?.photo || null); })
      .catch(() => {});
    if (requester.id) {
      ticketsAPI.requesterStats(requester.id)
        .then((res) => { if (alive) setRqStats(res.data || null); })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [requester?.email, requester?.id]);

  const pickRequester = (person, fromDirectory = false) => {
    const location = person.entraOfficeLocation || person.entraCity || null;
    setRequester({
      id: fromDirectory ? null : person.id,
      name: person.name,
      email: person.email,
      jobTitle: person.jobTitle || null,
      department: person.department || null,
      location,
      hint: [person.jobTitle, location || person.department].filter(Boolean).join(' · '),
      fromDirectory,
    });
    setRqQuery('');
    setRqResults(null);
    setRqOpen(false);
  };

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

  const goBack = () => navigate('/tickets');

  const resetForm = () => {
    setSubject('');
    setDescription('');
    setDescriptionText('');
    setPriority(2);
    setTicketType('Incident');
    setCategoryId('');
    setSubcategoryId('');
    setGroupId('');
    setTagIds([]);
    setImpact('');
    setUrgency('');
    setAssignMode('ai');
    setAssignTechId('');
    setCc([]);
    setNotifyRequester(true);
    setFiles([]);
    setRequester(null);
    setRqQuery('');
    setTimeout(() => rqInputRef.current?.focus(), 0);
  };

  /** afterAction: 'open' navigates to the new ticket, 'new' resets, 'resolve' resolves then navigates, 'schedule' queues. */
  const submit = async (e, afterAction = 'open') => {
    e?.preventDefault?.();
    setSubmitMenuOpen(false);
    setError(null);
    setSuccessNote(null);
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
        impact: impact ? Number(impact) : null,
        urgency: urgency ? Number(urgency) : null,
        source: Number(source),
      };
      if (assignMode === 'me' && canTakeMyself) payload.assignedTechId = meta.actor.technicianId;
      if (assignMode === 'pick' && assignTechId) payload.assignedTechId = Number(assignTechId);

      if (afterAction === 'schedule') {
        if (!scheduleAt) throw new Error('Pick a date and time to schedule for');
        setSaveStep('Scheduling…');
        const schedRes = await ticketsAPI.scheduleCreate(payload, new Date(scheduleAt).toISOString());
        // Files stage against the schedule and attach when it activates (P2).
        if (files.length > 0 && schedRes.data?.id) {
          setSaveStep(`Staging ${files.length} file${files.length === 1 ? '' : 's'}…`);
          try {
            await ticketsAPI.uploadScheduledAttachments(schedRes.data.id, files);
          } catch (uploadErr) {
            console.warn('Staged attachment upload failed:', uploadErr);
          }
        }
        setIsSaving(false);
        setSaveStep(null);
        setSuccessNote(`Scheduled for ${new Date(scheduleAt).toLocaleString()} — it gets its TP number (and any attachments) at activation`);
        setScheduleOpen(false);
        setScheduleAt('');
        resetForm();
        return;
      }

      setSaveStep('Creating ticket…');
      const res = await ticketsAPI.create(payload);
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

  const fieldClass = 'tp-focus-ring w-full text-sm bg-white border border-input rounded-lg px-3 py-2.5 text-slate-800 placeholder:text-slate-400';
  const labelClass = 'block text-sm font-semibold text-slate-700 mb-1.5';
  const submitDisabled = isSaving || !subject.trim() || !requesterReady || (assignMode === 'pick' && !assignTechId);

  const ticketingOn = meta ? meta.nativeTicketingEnabled : true;
  // When AI will classify, category/subcategory/priority/type are AI-owned —
  // grey the manual controls so it's clear you don't need to set them.
  const aiDecides = aiClassify || assignMode === 'ai';

  if (metaError) {
    return (
      <div className="tp-tickets-backdrop min-h-screen md:pl-[20px]">
        <AppHeader activePage="tickets" />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" aria-hidden="true" />
          <p className="text-slate-700 font-medium">{metaError}</p>
          <button onClick={goBack} className="mt-4 tp-focus-ring px-4 py-2 text-sm font-medium rounded-lg bg-white border border-slate-200 hover:bg-slate-50">Back to tickets</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[20px]">
      <AppHeader activePage="tickets" />

      {/* pb clears the sticky action bar + the mobile tab bar under it (QA 07-06 #11) */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 pb-44 md:pb-28 lg:pb-5">
        {/* Header / breadcrumb */}
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={goBack}
            aria-label="Back to tickets"
            className="tp-focus-ring p-2 rounded-lg text-slate-500 bg-white/70 border border-white/70 shadow-subtle hover:text-slate-700 hover:bg-white"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
              <button onClick={goBack} className="tp-focus-ring rounded hover:text-slate-600">Tickets</button>
              <span aria-hidden="true">/</span>
              <span className="text-slate-500">New</span>
            </div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Ticket className="w-5 h-5 text-blue-600" aria-hidden="true" />
              New ticket
            </h1>
          </div>
        </div>

        {!ticketingOn && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            Native ticketing is off for this workspace — the ticket will still be created in Ticket Pulse.
          </div>
        )}

        {successNote && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800" role="status">
            <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            {successNote} — ready for the next one.
          </div>
        )}

        {!meta ? (
          <div className="flex items-center justify-center py-24 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
          </div>
        ) : (
          <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
            {/* ---- Main column ---- */}
            <div className="lg:col-span-2 space-y-5">
              <div className="tp-card rounded-2xl p-5 space-y-5">
                {/* Requester */}
                <div ref={rqRef} className="relative">
                  <label htmlFor="tc-requester" className={labelClass}>Requester <span className="text-red-500">*</span></label>
                  {requester ? (
                    <div className="flex items-center gap-3 px-3 py-2.5 bg-blue-50/60 border border-blue-200 rounded-xl">
                      {rqPhoto ? (
                        <img src={rqPhoto} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <span className="h-9 w-9 rounded-full bg-blue-100 text-blue-700 inline-flex items-center justify-center text-xs font-semibold flex-shrink-0">
                          {initials(requester.name)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-800 truncate">
                          {requester.name}
                          {requester.fromDirectory && <span className="ml-1.5 text-[10px] font-semibold text-violet-600 uppercase">Entra</span>}
                        </span>
                        <span className="block text-xs text-slate-500 truncate">{requester.email}{requester.hint ? ` · ${requester.hint}` : ''}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => { setRequester(null); setTimeout(() => rqInputRef.current?.focus(), 0); }}
                        aria-label="Clear requester"
                        className="tp-focus-ring p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white"
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="relative">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                        <input
                          id="tc-requester"
                          ref={rqInputRef}
                          type="text"
                          value={rqQuery}
                          onChange={(e) => setRqQuery(e.target.value)}
                          onFocus={() => { if (rqResults) setRqOpen(true); }}
                          placeholder="Search people by name or email…"
                          autoComplete="off"
                          role="combobox"
                          aria-expanded={rqOpen}
                          aria-autocomplete="list"
                          className={`${fieldClass} pl-9`}
                        />
                        {rqLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-300 absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true" />}
                      </div>
                      {typedEmailOk && !rqOpen && (
                        <p className="mt-1 text-[11px] text-emerald-600">New requester — “{rqQuery.trim()}” will be created with the ticket.</p>
                      )}
                      {rqOpen && rqResults && (rqResults.requesters.length > 0 || rqResults.directory.length > 0 || typedEmailOk) && (
                        <div className="absolute left-0 right-0 top-full mt-1 z-30 tp-card rounded-xl shadow-soft py-1 max-h-80 overflow-y-auto settings-scrollbar" role="listbox">
                          {rqResults.requesters.length > 0 && (
                            <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Requesters</p>
                          )}
                          {rqResults.requesters.map((p) => (
                            <button
                              key={`r-${p.id}`}
                              type="button"
                              role="option"
                              aria-selected="false"
                              onClick={() => pickRequester(p)}
                              className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center gap-2.5"
                            >
                              <span className="h-7 w-7 rounded-full bg-blue-50 text-blue-700 border border-blue-100 inline-flex items-center justify-center text-[10px] font-semibold flex-shrink-0">{initials(p.name)}</span>
                              <span className="min-w-0">
                                <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                                <span className="block text-xs text-slate-400 truncate">{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}</span>
                              </span>
                            </button>
                          ))}
                          {rqResults.directory.length > 0 && (
                            <p className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-400 flex items-center gap-1">
                              <Building2 className="w-3 h-3" aria-hidden="true" /> Entra directory
                            </p>
                          )}
                          {rqResults.directory.map((p) => (
                            <button
                              key={`d-${p.email}`}
                              type="button"
                              role="option"
                              aria-selected="false"
                              onClick={() => pickRequester(p, true)}
                              className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-violet-50 flex items-center gap-2.5"
                            >
                              <span className="h-7 w-7 rounded-full bg-violet-50 text-violet-700 border border-violet-100 inline-flex items-center justify-center text-[10px] font-semibold flex-shrink-0">{initials(p.name)}</span>
                              <span className="min-w-0">
                                <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                                <span className="block text-xs text-slate-400 truncate">{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}</span>
                              </span>
                            </button>
                          ))}
                          {typedEmailOk && (
                            <button
                              type="button"
                              role="option"
                              aria-selected="false"
                              onClick={() => pickRequester({ name: rqQuery.trim().split('@')[0], email: rqQuery.trim().toLowerCase() }, false)}
                              className="tp-focus-ring w-full text-left px-3 py-2 hover:bg-emerald-50 text-sm text-emerald-700 border-t border-slate-100 mt-1"
                            >
                              Use “{rqQuery.trim()}” as a new requester
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  <div className="mt-2">
                    <CcChips value={cc} onChange={setCc} placeholder="Cc colleagues on this ticket…" />
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={!notifyRequester}
                      onChange={(e) => setNotifyRequester(!e.target.checked)}
                      className="tp-focus-ring rounded border-slate-300 text-blue-600"
                    />
                    Don’t email the requester about this ticket
                  </label>
                </div>

                {createTemplates.length > 0 && (
                  <div>
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
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Short summary of the issue or request"
                    className={fieldClass}
                  />
                </div>

                <div>
                  <span className={labelClass}>Description</span>
                  <RichTextEditor
                    value={description}
                    onChange={({ html, text }) => { setDescription(html); setDescriptionText(text); }}
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
                </div>

                {/* Attachments — staged files sit up top (prominent), add-zone below */}
                <div>
                  <span className={labelClass}>Attachments{files.length > 0 ? ` (${files.length})` : ''}</span>
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
                      dragOver ? 'border-blue-400 bg-blue-50/60' : 'border-slate-200 bg-slate-50/40'
                    }`}
                  >
                    <p className="text-xs text-slate-500 inline-flex items-center gap-1.5">
                      <Paperclip className={`w-4 h-4 ${dragOver ? 'text-blue-500' : 'text-slate-300'}`} aria-hidden="true" />
                      Drag files here, paste a screenshot into the description, or{' '}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={files.length >= MAX_FILES}
                        className="tp-focus-ring rounded font-semibold text-blue-600 hover:underline disabled:opacity-50"
                      >
                        browse
                      </button>
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{files.length}/{MAX_FILES} · up to {MAX_FILE_MB} MB each</p>
                  </div>
                </div>
              </div>

              {/* Classification card — category/subcategory/priority/type are AI-owned when triage is on */}
              <div className="tp-card rounded-2xl p-5 space-y-5">
                {aiDecides && (
                  <div className="flex items-start gap-2 -mt-1 px-3 py-2 rounded-lg bg-indigo-50/70 border border-indigo-100 text-[11px] text-indigo-700">
                    <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    AI will set category, subcategory, priority and type on create. Turn off “Classify &amp; assess with AI” to set them yourself.
                  </div>
                )}
                <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity ${aiDecides ? 'opacity-50' : ''}`}>
                  <div>
                    <span className={labelClass}>Type</span>
                    <div role="group" aria-label="Ticket type" className="grid grid-cols-2 gap-1.5">
                      {TICKET_TYPES.map((t) => (
                        <button
                          key={t}
                          type="button"
                          disabled={aiDecides}
                          onClick={() => setTicketType(t)}
                          aria-pressed={ticketType === t}
                          className={`tp-focus-ring px-2 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:cursor-not-allowed ${
                            ticketType === t
                              ? t === 'Incident' ? 'bg-orange-500 text-white border-orange-500' : 'bg-violet-600 text-white border-violet-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className={labelClass}>Priority</span>
                    <div role="group" aria-label="Priority" className="grid grid-cols-4 gap-1.5">
                      {[1, 2, 3, 4].map((p) => (
                        <button
                          key={p}
                          type="button"
                          disabled={aiDecides}
                          onClick={() => setPriority(p)}
                          aria-pressed={priority === p}
                          className={`tp-focus-ring px-2 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:cursor-not-allowed ${
                            priority === p
                              ? p === 4 ? 'bg-red-600 text-white border-red-600'
                                : p === 3 ? 'bg-amber-500 text-white border-amber-500'
                                  : p === 2 ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-blue-500 text-white border-blue-500'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {PRIORITY_LABELS[p]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity ${aiDecides ? 'opacity-50' : ''}`}>
                  <div>
                    <label htmlFor="tc-category" className={labelClass}>Category</label>
                    <select
                      id="tc-category"
                      value={categoryId}
                      disabled={aiDecides}
                      onChange={(e) => { setCategoryId(e.target.value); setSubcategoryId(''); }}
                      className={`${fieldClass} disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed`}
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
                  </div>
                  <div>
                    <label htmlFor="tc-subcategory" className={labelClass}>Subcategory</label>
                    <select
                      id="tc-subcategory"
                      value={subcategoryId}
                      onChange={(e) => setSubcategoryId(e.target.value)}
                      disabled={aiDecides || !categoryId || subcategories.length === 0}
                      className={`${fieldClass} disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed`}
                    >
                      <option value="">{aiDecides ? 'AI will choose' : '—'}</option>
                      {subcategories.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="tc-source" className={labelClass}>Source</label>
                  <select id="tc-source" value={source} onChange={(e) => setSource(Number(e.target.value))} className={fieldClass}>
                    {SOURCE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-400">How the request reached you — phone call, walk-up, Teams message…</p>
                </div>

                {(meta?.groups?.length || 0) > 0 && (
                  <div>
                    <label htmlFor="tc-group" className={labelClass}>Group</label>
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
                  </div>
                )}
              </div>

              {/* Tags + impact/urgency at creation (gap plan 2 P1.3) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(meta?.tags?.length || 0) > 0 && (
                  <div>
                    <span className={labelClass}>Tags</span>
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
                              : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'
                          }`}
                        >
                          {tag.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="tc-impact" className={labelClass}>Impact</label>
                    <select id="tc-impact" value={impact} onChange={(e) => setImpact(e.target.value)} className={fieldClass}>
                      <option value="">—</option>
                      {[1, 2, 3].map((v) => <option key={v} value={v}>{['Low', 'Medium', 'High'][v - 1]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="tc-urgency" className={labelClass}>Urgency</label>
                    <select id="tc-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value)} className={fieldClass}>
                      <option value="">—</option>
                      {[1, 2, 3].map((v) => <option key={v} value={v}>{['Low', 'Medium', 'High'][v - 1]}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl" role="alert">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span className="text-sm text-red-800">{error}</span>
                </div>
              )}
            </div>

            {/* ---- Right rail ---- */}
            <div className="lg:sticky lg:top-4 space-y-5">
              {/* Requester context */}
              {requester && (
                <div className="tp-card rounded-2xl p-4">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2.5">Requester</p>
                  <div className="flex items-center gap-3">
                    {rqPhoto ? (
                      <img src={rqPhoto} alt="" className="h-11 w-11 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <span className="h-11 w-11 rounded-full bg-blue-100 text-blue-700 inline-flex items-center justify-center text-sm font-semibold flex-shrink-0">
                        {initials(requester.name)}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{requester.name}</p>
                      <p className="text-xs text-slate-500 truncate">{requester.email}</p>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    {requester.jobTitle && (
                      <div className="flex items-center gap-1.5 text-slate-600"><Building2 className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /><span className="truncate">{requester.jobTitle}{requester.department ? ` · ${requester.department}` : ''}</span></div>
                    )}
                    {requester.location && (
                      <div className="flex items-center gap-1.5 text-slate-600"><MapPin className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /><span className="truncate">{requester.location}</span></div>
                    )}
                    {rqStats && (rqStats.total ?? rqStats.totalTickets) != null && (
                      <div className="flex items-center gap-1.5 text-slate-600"><Ticket className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /><span>{rqStats.total ?? rqStats.totalTickets} previous ticket{(rqStats.total ?? rqStats.totalTickets) === 1 ? '' : 's'}</span></div>
                    )}
                  </dl>
                  {requester.fromDirectory && (
                    <p className="mt-2.5 text-[11px] text-violet-600 bg-violet-50 rounded-lg px-2 py-1.5">New to Ticket Pulse — created from the Entra directory with this ticket.</p>
                  )}
                </div>
              )}

              {/* AI on this ticket — assessment, independent of assignment */}
              <div className="tp-card rounded-2xl p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-500" aria-hidden="true" /> AI on this ticket
                </p>
                <label className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${(aiClassify || assignMode === 'ai') ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200 bg-white hover:border-indigo-200'} ${assignMode === 'ai' ? 'opacity-70' : ''}`}>
                  <input
                    type="checkbox"
                    checked={aiClassify || assignMode === 'ai'}
                    disabled={assignMode === 'ai'}
                    onChange={(e) => setAiClassify(e.target.checked)}
                    className="tp-focus-ring mt-0.5 rounded border-slate-300 text-indigo-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-700">Classify &amp; assess with AI</span>
                    <span className="block text-[11px] text-slate-500">Sets category · subcategory · priority · incident/request — leaves the assignee alone.</span>
                  </span>
                </label>
                {assignMode === 'ai' && (
                  <p className="mt-1.5 text-[11px] text-indigo-600">Included automatically with AI assignment below.</p>
                )}
              </div>

              {/* Assignment */}
              <div className="tp-card rounded-2xl p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2.5">Assignment</p>
                <div className="space-y-1.5">
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'ai' ? 'border-indigo-300 bg-indigo-50/60' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'ai'} onChange={() => setAssignMode('ai')} className="tp-focus-ring" />
                    <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
                    <span className="text-sm text-slate-700">AI recommends an assignee</span>
                  </label>
                  {canTakeMyself && (
                    <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'me' ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                      <input type="radio" name="tc-assign" checked={assignMode === 'me'} onChange={() => setAssignMode('me')} className="tp-focus-ring" />
                      <span className="text-sm text-slate-700">Assign to me</span>
                    </label>
                  )}
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'pick' ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'pick'} onChange={() => setAssignMode('pick')} className="tp-focus-ring" />
                    <span className="text-sm text-slate-700">Assign to…</span>
                    <select
                      value={assignTechId}
                      onChange={(e) => { setAssignTechId(e.target.value); setAssignMode('pick'); }}
                      onClick={() => setAssignMode('pick')}
                      aria-label="Member to assign"
                      className="tp-focus-ring ml-auto text-sm bg-white border border-input rounded-lg px-2 py-1 text-slate-700 max-w-[8rem]"
                    >
                      <option value="">Choose…</option>
                      {(meta?.technicians || []).map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${assignMode === 'none' ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                    <input type="radio" name="tc-assign" checked={assignMode === 'none'} onChange={() => setAssignMode('none')} className="tp-focus-ring" />
                    <span className="text-sm text-slate-700">Leave unassigned</span>
                  </label>
                </div>
              </div>

              {/* Create actions — on mobile the sticky bottom bar owns this, so hide here */}
              <div className="tp-card rounded-2xl p-4 hidden lg:block">
                {scheduleOpen && (
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      type="datetime-local"
                      value={scheduleAt}
                      min={toLocalDatetimeInput(new Date(Date.now() + 5 * 60 * 1000))}
                      onChange={(e) => setScheduleAt(e.target.value)}
                      aria-label="Schedule ticket for"
                      className="tp-focus-ring flex-1 text-sm bg-white border border-input rounded-lg px-2.5 py-2 text-slate-700"
                    />
                    <button
                      onClick={(e) => submit(e, 'schedule')}
                      type="button"
                      disabled={submitDisabled || !scheduleAt}
                      className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                      Schedule
                    </button>
                    <button
                      onClick={() => { setScheduleOpen(false); setScheduleAt(''); }}
                      type="button"
                      aria-label="Cancel scheduling"
                      className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div className="flex">
                  <button
                    onClick={(e) => submit(e, 'open')}
                    disabled={submitDisabled}
                    className="tp-focus-ring flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-l-lg shadow-subtle hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
                    {isSaving ? (saveStep || 'Creating…') : 'Create ticket'}
                  </button>
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
                          className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                        >
                          Create & start another
                        </button>
                        <button
                          onClick={(e) => submit(e, 'resolve')}
                          role="menuitem"
                          className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-slate-600 hover:bg-emerald-50 hover:text-emerald-700"
                        >
                          Create & resolve (walk-up log)
                        </button>
                        <button
                          onClick={() => { setScheduleOpen(true); setSubmitMenuOpen(false); }}
                          role="menuitem"
                          className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-slate-600 hover:bg-violet-50 hover:text-violet-700 flex items-center gap-2"
                        >
                          <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Schedule for later…
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={goBack} type="button" className="tp-focus-ring w-full mt-2 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
                  Cancel
                </button>
                <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">Born in Ticket Pulse — mirrored to FreshService as a fallback copy.</p>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Sticky mobile action bar — Create is otherwise buried at the bottom of a
          long scroll. Under md it sits ABOVE the bottom tab bar (QA 07-06 #11). */}
      {meta && (
        <div className="lg:hidden fixed bottom-[calc(48px+env(safe-area-inset-bottom))] md:bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-slate-200 px-4 pt-3 pb-3 md:pb-safe flex items-center gap-2 shadow-[0_-4px_16px_-8px_rgba(15,23,42,0.25)]">
          <button
            type="button"
            onClick={goBack}
            className="tp-focus-ring px-4 min-h-[44px] text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
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

      <MobileTabBar />
    </div>
  );
}
