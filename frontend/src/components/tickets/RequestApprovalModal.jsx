import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BadgeDollarSign, Check, HardDrive, ImagePlus, Laptop, Loader2, Mail, Paperclip, PencilLine, Search, Send, ShieldAlert, ShieldCheck, Stamp, X,
} from 'lucide-react';
import { PersonAvatar } from './ticketUi';
import RichTextEditor, { isRichContent } from './RichTextEditor';
import StagedFileChip from './StagedFileChip';
import { formatMoney } from './ApprovalHandoff';
import LaptopPicker, { assetTitle } from './LaptopPicker';

const MAX_FILES = 5;
const NL2 = String.fromCharCode(10, 10);
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STEP_LABEL = { what: 'What', hardware: 'Hardware', details: 'Details' };

/**
 * "Request approval" — a wide dialog in steps (approval redesign B1 + C1, 29 Sep 2026).
 *
 *  1. What: every category as a compact card, two per row: name, one line of
 *     description, the tier chain with avatars. Picking one moves on.
 *  2. Hardware (hardware categories only): "Reserve from Assetron" (the device
 *     finder: filters with counts + a paged table) or "Manual entry" (what and
 *     how many; nothing is reserved, the line goes into the request note).
 *  3. Details: amount (monetary categories, with the tier read-out), context
 *     with pasted/dropped files, the self-approval notices, e-mail the approvers.
 *
 * `onSubmit` gets { approvalCategoryId, note, noteHtml, notifyApprover, amount,
 * files, hardware } and should resolve/reject; the parent closes the dialog.
 */
export default function RequestApprovalModal({
  categories = [], technicians = [], members = [], busy = false, onSubmit, onClose, allowFiles = true, actorEmail = null,
  requester = null,
}) {
  const [categoryId, setCategoryId] = useState(categories.length === 1 ? categories[0].id : null);
  const [step, setStep] = useState(categories.length === 1 ? (categories[0].gatesHardware ? 'hardware' : 'details') : 'what');
  const [note, setNote] = useState('');
  const [noteHtml, setNoteHtml] = useState('');
  const [amount, setAmount] = useState('');
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [notifyApprover, setNotifyApprover] = useState(true);
  const [amountTouched, setAmountTouched] = useState(false);
  // Hardware categories: null = not chosen yet; 'assetron' = reserve a device;
  // 'manual' = something Assetron does not track (chargers, docks…).
  const [source, setSource] = useState(null);
  const [device, setDevice] = useState(null);
  const [deviceCount, setDeviceCount] = useState(null);
  const [manualWhat, setManualWhat] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [recipient, setRecipient] = useState(requester?.email ? { email: String(requester.email).toLowerCase(), name: requester.name || null } : null);
  const pasteCount = useRef(0);
  const fileInputRef = useRef(null);

  const people = useMemo(() => {
    const map = new Map();
    for (const t of [...(technicians || []), ...(members || [])]) {
      if (!t?.email) continue;
      const key = String(t.email).toLowerCase();
      if (!map.has(key) || (!map.get(key).photoUrl && t.photoUrl)) map.set(key, t);
    }
    return map;
  }, [technicians, members]);
  const person = (email) => {
    const m = people.get(String(email || '').toLowerCase());
    return { email, name: m?.name || email, photoUrl: m?.photoUrl || null };
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = categories.find((c) => c.id === categoryId) || null;
  const tiers = selected ? (Array.isArray(selected.tiers) && selected.tiers.length ? selected.tiers : [{ name: 'Tier 1', managerEmails: selected.managerEmails || [], limit: null }]) : [];
  const monetary = Boolean(selected?.hasAmount);
  const hardwareOn = Boolean(selected?.gatesHardware);
  const steps = hardwareOn ? ['what', 'hardware', 'details'] : ['what', 'details'];
  const stepIdx = steps.indexOf(step);
  const currency = selected?.amountCurrency || 'CAD';
  const amountNumber = amount.trim() === '' ? null : Number(String(amount).replace(/[^0-9.]/g, ''));
  const amountValid = !monetary || (amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0);
  const qtyNumber = Math.max(1, Math.floor(Number(manualQty) || 1));
  const hardwareReady = !hardwareOn
    || (source === 'assetron' && Boolean(device) && Boolean(recipient?.email))
    || (source === 'manual' && manualWhat.trim().length > 0);

  // Which tiers this amount has to pass through (limits are "may finalise up to").
  const route = useMemo(() => {
    if (!selected) return [];
    if (!monetary || amountNumber === null || !Number.isFinite(amountNumber)) return tiers.slice(0, 1);
    const out = [];
    for (let i = 0; i < tiers.length; i += 1) {
      out.push(tiers[i]);
      const limit = tiers[i].limit;
      if (limit === null || limit === undefined || amountNumber <= Number(limit) || i === tiers.length - 1) break;
    }
    return out;
  }, [selected, monetary, amountNumber, tiers]);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of incoming) if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f);
      return merged.slice(0, MAX_FILES);
    });
  };

  const pickCategory = (c) => {
    if (c.id !== categoryId) {
      setCategoryId(c.id);
      if (!c.hasAmount) setAmount('');
      if (!c.gatesHardware) { setSource(null); setDevice(null); }
    }
    setStep(c.gatesHardware ? 'hardware' : 'details');
  };

  // Approvals v3: an approver may request on their own category — the request
  // starts at the first tier that has someone OTHER than them (self-approval
  // stays prohibited). Surface that before they send.
  const me = String(actorEmail || '').trim().toLowerCase();
  const startTierIdx = selected ? tiers.findIndex((t) => (t.managerEmails || []).some((e) => String(e).toLowerCase() !== me)) : 0;
  const startTier = startTierIdx >= 0 ? tiers[startTierIdx] : null;
  const selfOnEveryTier = Boolean(selected) && startTierIdx === -1;
  const skipped = startTierIdx > 0 ? tiers.slice(0, startTierIdx) : [];
  const startApprovers = startTier ? (startTier.managerEmails || []).filter((e) => String(e).toLowerCase() !== me) : [];
  const tierOneCount = startApprovers.length;

  const canSend = Boolean(selected) && !busy && !selfOnEveryTier && hardwareReady && !(monetary && amountTouched && !amountValid);
  const submit = (e) => {
    e.preventDefault();
    if (step !== 'details') { if (step === 'hardware' && hardwareReady) setStep('details'); return; }
    if (!categoryId || busy) return;
    if (!amountValid) { setAmountTouched(true); return; }
    if (!hardwareReady) { setStep('hardware'); return; }
    // Manual entry is not reserved anywhere: it rides at the top of the note
    // so the approver reads exactly what is being asked for.
    const manualLine = hardwareOn && source === 'manual' ? `Hardware (manual entry): ${qtyNumber} × ${manualWhat.trim()}` : null;
    const text = [manualLine, note.trim()].filter(Boolean).join(NL2);
    const rich = note.trim() && isRichContent(noteHtml);
    onSubmit({
      approvalCategoryId: Number(categoryId),
      note: text || null,
      noteHtml: rich ? `${manualLine ? `<p><strong>Hardware (manual entry):</strong> ${qtyNumber} × ${escHtml(manualWhat.trim())}</p>` : ''}${noteHtml}` : null,
      notifyApprover,
      amount: monetary ? Math.round(amountNumber * 100) / 100 : null,
      files,
      hardware: hardwareOn && source === 'assetron' && device && recipient?.email ? { assetId: device.id, recipient } : null,
    });
  };

  const wide = step === 'hardware' && source === 'assetron';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="req-approval-title">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <form onSubmit={submit} className={`relative tp-card rounded-2xl shadow-soft w-full ${wide ? 'max-w-6xl' : 'max-w-4xl'} max-h-[92vh] flex flex-col animate-scaleIn transition-[max-width] duration-200`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-4 pb-3 border-b border-border/60">
          <span className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 inline-flex items-center justify-center flex-shrink-0">
            <Stamp className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="req-approval-title" className="text-base font-bold text-foreground">Request approval</h2>
            <p className="text-xs text-muted-foreground mt-0.5">The first tier decides, or moves it up.</p>
          </div>
          <ol className="flex items-center gap-2 text-xs" aria-label="Steps" data-testid="approval-steps">
            {steps.map((s, i) => {
              const done = i < stepIdx;
              const on = s === step;
              return (
                <li key={s} className="flex items-center gap-2">
                  {i > 0 && <span className="h-px w-5 bg-border" aria-hidden="true" />}
                  <button
                    type="button" disabled={!done} onClick={() => setStep(s)} aria-current={on ? 'step' : undefined}
                    className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 ${on ? 'font-semibold text-foreground' : done ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/60'}`}
                  >
                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${on ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/15 text-primary' : 'border border-border'}`}>
                      {done ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
                    </span>
                    {STEP_LABEL[s]}
                  </button>
                </li>
              );
            })}
          </ol>
          <button type="button" onClick={onClose} aria-label="Close" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto settings-scrollbar space-y-4 flex-1">
          {step === 'what' && (
            <CategoryGrid categories={categories} value={selected} onPick={pickCategory} person={person} />
          )}

          {step !== 'what' && selected && (
            <ChosenCategory category={selected} tiers={tiers} person={person} onChange={() => setStep('what')} />
          )}

          {step === 'hardware' && selected && (
            <div data-testid="hardware-step">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Hardware</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Hardware source">
                <SourceTile
                  on={source === 'assetron'} onPick={() => setSource('assetron')} Icon={Laptop}
                  title="Reserve from Assetron"
                  hint={deviceCount === null ? 'Held until the approval is decided, then assigned or released.' : `${deviceCount} new device${deviceCount === 1 ? '' : 's'} available · held until decided`}
                />
                <SourceTile
                  on={source === 'manual'} onPick={() => { setSource('manual'); setDevice(null); }} Icon={PencilLine}
                  title="Manual entry" hint="Hardware Assetron doesn’t track: describe it."
                />
              </div>
              {source === null && <p className="mt-1.5 text-[11px] text-muted-foreground">Choose one to continue.</p>}
              {source === 'assetron' && (
                <div className="mt-3">
                  <LaptopPicker recipient={recipient} onRecipient={setRecipient} value={device} onChange={setDevice} onLoaded={setDeviceCount} />
                </div>
              )}
              {source === 'manual' && (
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
                  <label className="text-xs text-muted-foreground" htmlFor="manual-what">What is needed
                    <input id="manual-what" value={manualWhat} onChange={(e) => setManualWhat(e.target.value)} autoFocus
                      placeholder="e.g. USB-C charger 100 W, docking station" className="tp-focus-ring mt-1 block w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground" />
                  </label>
                  <label className="text-xs text-muted-foreground" htmlFor="manual-qty">Quantity
                    <input id="manual-qty" value={manualQty} onChange={(e) => setManualQty(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric"
                      className="tp-focus-ring mt-1 block w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm tabular-nums text-foreground" />
                  </label>
                  <p className="text-[11px] text-muted-foreground sm:col-span-2">Nothing is reserved. The approver reads this line at the top of the request.</p>
                </div>
              )}
            </div>
          )}

          {step === 'details' && selected && (
            <>
              {hardwareOn && (
                <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="hardware-summary">
                  {source === 'assetron' ? <Laptop className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" /> : <HardDrive className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 text-foreground/85">
                    {source === 'assetron' && device
                      ? <><span className="font-medium text-foreground">{assetTitle(device)}</span>{device.serialNumber ? ` · S/N ${device.serialNumber}` : ''} held in Assetron for <span className="font-medium text-foreground">{recipient?.name || recipient?.email}</span></>
                      : <>Manual entry: <span className="font-medium text-foreground">{qtyNumber} × {manualWhat.trim()}</span></>}
                  </span>
                  <button type="button" onClick={() => setStep('hardware')} className="tp-focus-ring text-xs font-semibold text-primary hover:underline">Change</button>
                </div>
              )}

              {monetary && (
                <div>
                  <label htmlFor="approval-amount" className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">
                    Amount <span className="font-normal normal-case text-muted-foreground/50">— {currency}, required</span>
                  </label>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="relative w-44">
                      <BadgeDollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                      <input
                        id="approval-amount" inputMode="decimal" value={amount}
                        onChange={(e) => setAmount(e.target.value)} onBlur={() => setAmountTouched(true)}
                        placeholder="0.00" aria-invalid={amountTouched && !amountValid}
                        className={`tp-focus-ring w-full text-sm font-semibold tabular-nums bg-card border rounded-lg pl-8 pr-3 py-2 ${amountTouched && !amountValid ? 'border-red-400' : 'border-input'}`}
                      />
                    </div>
                    <div className="min-w-0 flex-1 text-xs text-muted-foreground leading-relaxed">
                      {amountNumber !== null && Number.isFinite(amountNumber) ? (
                        <RouteReadout route={route} tiers={tiers} amountLabel={formatMoney(amountNumber, currency)} person={person} />
                      ) : (
                        <span>Enter the total. Each tier has a limit it may approve up to — anything above moves to the next tier automatically after they approve.</span>
                      )}
                    </div>
                  </div>
                  {amountTouched && !amountValid && <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-200">Enter the amount (numbers only).</p>}
                </div>
              )}

              <div>
                <label htmlFor="approval-note" className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">
                  Context for the approver{tierOneCount === 1 ? '' : 's'} <span className="font-normal normal-case text-muted-foreground/50">— optional · paste or drop screenshots</span>
                </label>
                <div
                  onDragOver={(e) => { if (!allowFiles) return; e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { if (!allowFiles) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); }}
                  className={`relative rounded-xl transition-shadow ${dragging ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-card' : ''}`}
                >
                  <RichTextEditor
                    value={noteHtml}
                    onChange={({ html, text }) => { setNoteHtml(html); setNote(text); }}
                    placeholder="Why does this need approval? e.g. “New hire starting Monday needs a dev laptop — quote attached, budget code IT-204.”"
                    ariaLabel="Approval context"
                    minHeight={130}
                    onImagePaste={allowFiles ? (file) => {
                      const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
                      const name = `pasted-image-${++pasteCount.current}.${ext}`;
                      addFiles([new File([file], name, { type: file.type || 'image/png' })]);
                      return name;
                    } : undefined}
                  />
                  {dragging && (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-blue-50/80 dark:bg-blue-500/20 text-sm font-semibold text-blue-700 dark:text-blue-200">
                      <span className="inline-flex items-center gap-2"><ImagePlus className="w-4 h-4" aria-hidden="true" /> Drop to attach</span>
                    </div>
                  )}
                </div>
                {allowFiles && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button" onClick={() => fileInputRef.current?.click()} disabled={files.length >= MAX_FILES}
                      className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      <Paperclip className="w-3.5 h-3.5" aria-hidden="true" /> Attach files
                    </button>
                    <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="Attach files" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                    <span className="text-[11px] text-muted-foreground/75">Files land on the ticket; approvers open it to see them. Up to {MAX_FILES}.</span>
                  </div>
                )}
                {files.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2 items-start" aria-label="Files to attach">
                    {files.map((file) => (
                      <StagedFileChip key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles((prev) => prev.filter((f) => f !== file))} />
                    ))}
                  </ul>
                )}
              </div>

              {skipped.length > 0 && !selfOnEveryTier && (
                <div role="status" className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100" data-testid="auto-start-warning">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                  <p className="text-xs leading-relaxed">
                    <span className="font-semibold">You are a {skipped.map((t) => t.name).join(' / ')} approver on {selected.name}</span>, and self-approval is not allowed — so this request goes straight to{' '}
                    <span className="font-semibold">{startApprovers.map((e) => person(e).name).join(', ')}</span> ({startTier.name}). The skip is recorded on the ticket.
                  </p>
                </div>
              )}
              {selfOnEveryTier && (
                <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p className="text-xs leading-relaxed">You are the only approver on every tier of {selected.name}, and self-approval is not allowed. Ask a colleague to request it, or add another approver in Settings.</p>
                </div>
              )}

              <div className="space-y-2">
                <label className="flex items-start gap-2 rounded-xl bg-muted/50 border border-border/60 px-3 py-2.5 cursor-pointer hover:border-blue-200 dark:hover:border-blue-500/30">
                  <input type="checkbox" checked={notifyApprover} onChange={(e) => setNotifyApprover(e.target.checked)} className="tp-focus-ring mt-0.5" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85">
                      <Mail className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /> Email the approver{tierOneCount === 1 ? '' : 's'} a decision link
                    </span>
                    <span className="block text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                      {notifyApprover
                        ? 'Each approver gets a personal email link to approve, reject, ask a question, escalate or forward — no sign-in needed.'
                        : 'No email — approvers will only see the request in-app under Approvals.'}
                    </span>
                  </span>
                </label>
                <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
                  Goes to the <span className="font-medium text-muted-foreground">{tierOneCount}</span> {startTier?.name || tiers[0]?.name || 'Tier 1'} approver{tierOneCount === 1 ? '' : 's'} of
                  <span className="font-medium text-muted-foreground"> {selected.name}</span>{notifyApprover ? ' in-app and by email' : ' in-app'}. The first to respond decides;
                  the rest auto-cancel.{tiers.length > (startTierIdx + 1) ? ` They can escalate to ${tiers.slice(startTierIdx + 1).map((t) => t.name).join(' then ')} or forward to anyone.` : ''}
                </p>
              </div>
            </>
          )}

          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed px-1">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-px" aria-hidden="true" />
            <span>Approvals stay inside Ticket Pulse — never synced to FreshService. You&apos;ll get an email when the decision is made.</span>
          </p>
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-border/60">
          {stepIdx > 0 && (
            <button type="button" onClick={() => setStep(steps[stepIdx - 1])} className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="tp-focus-ring px-3.5 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted">Cancel</button>
          {step === 'what' && (
            <button type="button" disabled={!selected} onClick={() => selected && pickCategory(selected)}
              className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              Next <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {step === 'hardware' && (
            <button type="button" disabled={!hardwareReady} onClick={() => setStep('details')}
              className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              Next <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {step === 'details' && (
            <button type="submit" disabled={!canSend}
              className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
              {busy ? (files.length ? 'Uploading & sending…' : 'Sending…') : 'Send approval request'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Hardware source choice (C1): compact tile; the chosen one is ringed and tinted. */
function SourceTile({ on, onPick, Icon, title, hint }) {
  return (
    <button
      type="button" role="radio" aria-checked={on} onClick={onPick}
      className={`tp-focus-ring relative flex items-start gap-2.5 rounded-xl border px-3 py-2 pr-9 text-left transition-colors ${on ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-input bg-card hover:border-primary/50'}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
      </span>
      <span className={`absolute right-3 top-2.5 h-4 w-4 rounded-full border ${on ? 'border-primary bg-primary shadow-[inset_0_0_0_3px_hsl(var(--card))]' : 'border-input'}`} aria-hidden="true" />
    </button>
  );
}

const tierChain = (c) => (Array.isArray(c.tiers) && c.tiers.length ? c.tiers : [{ name: 'Tier 1', managerEmails: c.managerEmails || [] }]);

/** Step 1 (B1): every category as a compact card, two per row; search + arrow keys. */
function CategoryGrid({ categories, value, onPick, person }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => `${c.name} ${c.description || ''}`.toLowerCase().includes(q));
  }, [categories, query]);
  useEffect(() => { setCursor(0); }, [query]);

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">What needs approval?</p>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/75" aria-hidden="true" />
        <input
          role="combobox" aria-expanded="true" aria-controls="approval-category-list" aria-autocomplete="list" aria-label="Approval category"
          autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + (e.key === 'ArrowDown' ? 2 : 1))); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setCursor((c) => Math.max(0, c - (e.key === 'ArrowUp' ? 2 : 1))); }
            else if (e.key === 'Enter') { e.preventDefault(); if (filtered[cursor]) onPick(filtered[cursor]); }
          }}
          placeholder={`Search ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}…`}
          className="tp-focus-ring w-full text-sm bg-card border border-input rounded-xl pl-9 pr-3 py-2 placeholder:text-muted-foreground/75"
        />
      </div>
      {filtered.length === 0 && <p className="px-3 py-6 text-sm text-muted-foreground/75 text-center">No categories match “{query}”.</p>}
      <ul id="approval-category-list" role="listbox" aria-label="Approval categories" className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {filtered.map((c, i) => {
          const tiers = tierChain(c);
          const t1 = (tiers[0]?.managerEmails || []).map(person);
          const on = value?.id === c.id;
          return (
            <li key={c.id}>
              <button
                type="button" role="option" aria-selected={i === cursor || on}
                onMouseEnter={() => setCursor(i)} onClick={() => onPick(c)}
                className={`tp-focus-ring h-full w-full text-left rounded-xl border px-3 py-2.5 ${on ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : i === cursor ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border hover:bg-muted/50'}`}
              >
                <span className="flex items-start gap-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-foreground">{c.name}</span>
                      {c.gatesHardware && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary"><Laptop className="h-3 w-3" aria-hidden="true" />Hardware</span>}
                      {c.hasAmount && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"><BadgeDollarSign className="h-3 w-3" aria-hidden="true" />Amount</span>}
                    </span>
                    {c.description && <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-1" title={c.description}>{c.description}</span>}
                    <TierChain tiers={tiers} person={person} className="mt-1" compact />
                  </span>
                  <span className="flex -space-x-2 flex-shrink-0 mt-0.5" title={`${t1.length} approver${t1.length === 1 ? '' : 's'}`}>
                    {t1.slice(0, 3).map((m) => (
                      <span key={m.email} className="ring-2 ring-card rounded-full"><PersonAvatar name={m.name} photoUrl={m.photoUrl} size="h-6 w-6" textSize="text-[9px]" /></span>
                    ))}
                    {t1.length > 3 && <span className="h-6 w-6 rounded-full bg-muted border-2 border-card text-[9px] font-semibold text-muted-foreground flex items-center justify-center">+{t1.length - 3}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Steps 2–3: the chosen category, compact, with "Change" back to step 1. */
function ChosenCategory({ category, tiers, person, onChange }) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 mt-0.5"><Check className="w-3 h-3" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-foreground">{category.name}</span>
          <TierRows tiers={tiers} person={person} className="mt-1" />
        </div>
        <button type="button" onClick={onChange} className="tp-focus-ring text-xs font-semibold text-primary hover:underline flex-shrink-0">Change</button>
      </div>
    </div>
  );
}

function RouteReadout({ route, tiers, amountLabel, person }) {
  if (!route.length) return null;
  const last = route[route.length - 1];
  const finaliser = (last.managerEmails || []).map((e) => person(e).name).join(', ') || last.name;
  if (route.length === 1) {
    return (
      <span>
        <span className="font-semibold text-foreground">{amountLabel}</span> can be approved by <span className="font-semibold text-foreground">{finaliser}</span>
        {tiers.length > 1 && last.limit !== null && last.limit !== undefined ? ` (${last.name} limit ${formatMoney(last.limit)})` : ''}.
      </span>
    );
  }
  return (
    <span>
      <span className="font-semibold text-foreground">{amountLabel}</span> is over the {route[0].name} limit ({formatMoney(route[0].limit)}) — after{' '}
      {route.slice(0, -1).map((t, i) => (
        <span key={t.name}>{i > 0 ? ' and ' : ''}<span className="font-semibold text-foreground">{(t.managerEmails || []).map((e) => person(e).name).join(', ') || t.name}</span></span>
      ))}
      {' '}approve{route.length - 1 === 1 ? 's' : ''}, it goes on to <span className="font-semibold text-foreground">{finaliser}</span> ({last.name}) automatically.
    </span>
  );
}

/** Every tier as a row: chip, the people on it (avatar + name), and the limit. */
function TierRows({ tiers, person, className = '' }) {
  if (!tiers?.length) return null;
  return (
    <ol className={`space-y-1 ${className}`} aria-label="Approval tiers" data-testid="tier-rows">
      {tiers.map((t, i) => {
        const ppl = (t.managerEmails || []).map(person);
        return (
          <li key={t.name || i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className="shrink-0 rounded border border-border bg-card px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.name || `Tier ${i + 1}`}</span>
            {ppl.length === 0 && <span className="text-muted-foreground/70">no approver yet</span>}
            {ppl.map((m) => (
              <span key={m.email} className="inline-flex items-center gap-1.5 text-foreground/85">
                <PersonAvatar name={m.name} photoUrl={m.photoUrl} size="h-5 w-5" textSize="text-[8px]" />
                <span className="font-medium">{m.name}</span>
              </span>
            ))}
            {t.limit !== null && t.limit !== undefined && <span className="text-muted-foreground/70">· up to {formatMoney(t.limit)}</span>}
            {i < tiers.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground/40" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function TierChain({ tiers, person, className = '', compact = false }) {
  if (!tiers?.length) return null;
  const names = (t) => (t.managerEmails || []).map((e) => person(e).name.split(' ')[0]).join(', ') || '—';
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground ${className}`}>
      {tiers.map((t, i) => (
        <span key={t.name || i} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight className="w-3 h-3 text-muted-foreground/50" aria-hidden="true" />}
          <span className={compact ? '' : 'font-medium text-foreground/80'}>{names(t)}</span>
          {tiers.length > 1 && <span className="text-muted-foreground/60">({t.name}{t.limit !== null && t.limit !== undefined ? ` · up to ${formatMoney(t.limit)}` : ''})</span>}
        </span>
      ))}
    </p>
  );
}
