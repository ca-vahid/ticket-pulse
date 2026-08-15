import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Check, CheckCircle2, Loader, PenLine, Search, Sparkles, Wand2, X,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import RichTextEditor from '../tickets/RichTextEditor';
import { SafeHtml } from '../tickets/ticketUi';

/**
 * Settings → Signatures (Mega 08-15 Phase D, admin-only).
 *
 * Per-user email signatures, appended to outbound REPLY emails only (never
 * notes/forwards; the stored thread entry stays clean). This panel is the
 * management side: every workspace member joined with their signature, a
 * per-row enable/disable toggle, inline editing via modal, and a mass-apply
 * template with {{name}} / {{title}} / {{email}} substitution — previewed
 * per member before anything is written.
 *
 * Self-service lives on the Notifications page (account menu), backed by the
 * same storage.
 */

const TEMPLATE_STARTER = '<p>Kind regards,</p><p><strong>{{name}}</strong><br>{{title}}<br>{{email}}</p>';

function Avatar({ name, photoUrl, dim = false }) {
  return (
    <div className={`h-8 w-8 rounded-full bg-slate-100 overflow-hidden flex items-center justify-center shrink-0 ${dim ? 'grayscale opacity-60' : ''}`}>
      {photoUrl
        ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
        : <span className="text-[10px] font-semibold text-slate-500">{(name || '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
    </div>
  );
}

function SignatureStatus({ signature }) {
  if (!signature || !signature.exists) {
    return <span className="text-xs text-slate-300">None</span>;
  }
  return signature.enabled ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> Enabled
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
      Disabled
    </span>
  );
}

export default function SignaturesPanel() {
  const { currentWorkspace } = useWorkspace();
  const [members, setMembers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [togglingEmail, setTogglingEmail] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // Edit modal
  const [editTarget, setEditTarget] = useState(null); // member row
  const [editHtml, setEditHtml] = useState('');
  const [editText, setEditText] = useState('');
  const [editEnabled, setEditEnabled] = useState(true);
  const [editSaving, setEditSaving] = useState(false);

  // Mass-apply template
  const [template, setTemplate] = useState(TEMPLATE_STARTER);
  const [previews, setPreviews] = useState(null); // results from preview call
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await settingsAPI.getSignatures();
      setMembers(res.data?.members || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load signatures');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  const rows = useMemo(() => {
    let list = members || [];
    const q = searchQ.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => [m.name, m.email].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [members, searchQ]);

  const selectable = useMemo(
    () => rows.filter((m) => m.technicianId && m.email && m.isActive),
    [rows],
  );
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.technicianId));

  const toggleSelectAll = () => {
    setPreviews(null);
    setSelected((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      selectable.forEach((m) => next.add(m.technicianId));
      return next;
    });
  };

  const toggleSelect = (technicianId) => {
    setPreviews(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(technicianId)) next.delete(technicianId);
      else next.add(technicianId);
      return next;
    });
  };

  const toggleEnabled = async (member) => {
    if (!member.email || !member.signature?.exists) return;
    setTogglingEmail(member.email); setError(null);
    try {
      await settingsAPI.updateSignature(member.email, { enabled: !member.signature.enabled });
      flash(`${member.name}'s signature ${member.signature.enabled ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to change signature status');
    } finally {
      setTogglingEmail(null);
    }
  };

  const openEdit = (member) => {
    setEditTarget(member);
    setEditHtml(member.signature?.html || '');
    setEditText(member.signature?.text || '');
    setEditEnabled(member.signature ? member.signature.enabled !== false : true);
    setError(null);
  };

  const saveEdit = async () => {
    if (!editTarget?.email) return;
    setEditSaving(true); setError(null);
    try {
      await settingsAPI.updateSignature(editTarget.email, {
        html: editHtml,
        text: editText,
        enabled: editEnabled,
      });
      flash(`${editTarget.name}'s signature saved.`);
      setEditTarget(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to save signature');
    } finally {
      setEditSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true); setError(null);
    try {
      const res = await settingsAPI.massApplySignatures({
        template,
        technicianIds: [...selected],
        preview: true,
      });
      setPreviews(res.data || null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to preview the template');
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    setApplying(true); setError(null);
    try {
      const res = await settingsAPI.massApplySignatures({
        template,
        technicianIds: [...selected],
        preview: false,
      });
      flash(`Signature template applied to ${res.data?.applied ?? 0} member${(res.data?.applied ?? 0) === 1 ? '' : 's'}.`);
      setPreviews(null);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to apply the template');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <PenLine className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Signatures</h3>
          <p className="text-sm text-gray-500 max-w-2xl">
            Per-user email signatures, appended to outbound <strong>reply emails only</strong> — internal notes and
            the stored ticket thread stay clean. Members manage their own from the account menu (Notifications);
            here you can edit any member&rsquo;s, toggle them, or mass-apply a template.
          </p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /><span>{successMsg}</span>
        </div>
      )}

      {/* Mass-apply template */}
      <div className="tp-card p-3.5 space-y-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Wand2 className="w-4 h-4 text-blue-600" /> Apply a signature template
          <span className="text-xs font-normal text-gray-500">
            to {selected.size} selected member{selected.size === 1 ? '' : 's'}
          </span>
        </div>
        <RichTextEditor
          value={template}
          onChange={({ html }) => { setTemplate(html); setPreviews(null); }}
          placeholder="Signature template…"
          ariaLabel="Signature template"
          minHeight={110}
        />
        <p className="text-[11px] text-slate-500">
          Variables: <code className="rounded bg-slate-100 px-1">{'{{name}}'}</code>{' '}
          <code className="rounded bg-slate-100 px-1">{'{{title}}'}</code>{' '}
          <code className="rounded bg-slate-100 px-1">{'{{email}}'}</code> — filled from each member&rsquo;s
          profile (title comes from Entra when available).
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runPreview}
            disabled={previewing || selected.size === 0 || !template.trim()}
            className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {previewing ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Preview
          </button>
          <button
            type="button"
            onClick={runApply}
            disabled={applying || !previews || selected.size === 0}
            title={previews ? 'Write the previewed signatures' : 'Preview first — nothing is written until you apply'}
            className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
          >
            {applying ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Apply to selected
          </button>
          {!previews && selected.size > 0 && (
            <span className="text-[11px] text-slate-400">Preview first — nothing is written until you apply.</span>
          )}
        </div>
        {previews && (
          <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/40 p-3" data-testid="mass-apply-previews">
            <div className="text-xs font-semibold text-slate-700">
              Preview — what each member gets ({previews.results?.length || 0}):
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(previews.results || []).map((p) => (
                <div key={p.technicianId} className="rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="mb-1 text-xs font-semibold text-slate-600">{p.name} · {p.email}</div>
                  <SafeHtml html={p.html} className="text-xs" />
                </div>
              ))}
            </div>
            {(previews.skipped || []).length > 0 && (
              <p className="text-[11px] text-amber-700">
                Skipped: {previews.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader className="w-5 h-5 animate-spin mr-2" /> Loading signatures…
        </div>
      ) : (
        <div className="tp-card rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-3 py-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search name or email…"
                aria-label="Search members"
                className="w-full pl-8 pr-3 py-1.5 border border-input rounded-lg text-sm bg-white tp-focus-ring"
              />
            </div>
            <span className="ml-auto hidden md:inline text-xs text-slate-400">
              {rows.length} shown · select rows for the template above
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all active members"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                  </th>
                  <th className="px-3 py-2">Member</th>
                  <th className="px-3 py-2">Signature</th>
                  <th className="px-3 py-2 hidden md:table-cell">Last updated</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-400">
                      {searchQ ? `No members match “${searchQ}”.` : 'No members in this workspace.'}
                    </td>
                  </tr>
                )}
                {rows.map((m) => {
                  const key = m.email || `tech-${m.technicianId}`;
                  const canSelect = Boolean(m.technicianId && m.email && m.isActive);
                  return (
                    <tr key={key} className={`transition-colors hover:bg-slate-50/70 ${m.isActive ? '' : 'opacity-60'}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={canSelect && selected.has(m.technicianId)}
                          disabled={!canSelect}
                          onChange={() => toggleSelect(m.technicianId)}
                          aria-label={`Select ${m.name}`}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 disabled:opacity-40"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={m.name} photoUrl={m.photoUrl} dim={!m.isActive} />
                          <div className="min-w-0">
                            <div className={`text-sm font-medium truncate ${m.isActive ? 'text-gray-900' : 'text-slate-500'}`}>{m.name}</div>
                            <div className="text-xs text-gray-500 truncate">{m.email || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2"><SignatureStatus signature={m.signature} /></td>
                      <td className="px-3 py-2 hidden md:table-cell">
                        {m.signature?.updatedAt ? (
                          <span className="text-xs text-slate-500" title={m.signature.updatedBy ? `by ${m.signature.updatedBy}` : undefined}>
                            {new Date(m.signature.updatedAt).toLocaleDateString()}
                          </span>
                        ) : <span className="text-xs text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-0.5">
                          {m.signature?.exists && (
                            <button
                              type="button"
                              onClick={() => toggleEnabled(m)}
                              disabled={togglingEmail === m.email}
                              title={m.signature.enabled ? 'Disable signature' : 'Enable signature'}
                              className={`p-1.5 rounded-lg tp-focus-ring ${m.signature.enabled ? 'text-gray-400 hover:text-red-600' : 'text-emerald-600 hover:text-emerald-700'}`}
                            >
                              {togglingEmail === m.email
                                ? <Loader className="w-4 h-4 animate-spin" />
                                : m.signature.enabled ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                            </button>
                          )}
                          {m.email && (
                            <button
                              type="button"
                              onClick={() => openEdit(m)}
                              title={`Edit ${m.name}'s signature`}
                              className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg tp-focus-ring"
                            >
                              <PenLine className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={`Edit ${editTarget.name}'s signature`}>
          <div className="tp-card w-full max-w-2xl rounded-xl shadow-soft animate-scaleIn max-h-[90vh] overflow-y-auto settings-scrollbar">
            <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3">
              <Avatar name={editTarget.name} photoUrl={editTarget.photoUrl} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-900 truncate">{editTarget.name}</div>
                <div className="text-xs text-slate-500 truncate">{editTarget.email}</div>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                <input
                  type="checkbox"
                  checked={editEnabled}
                  onChange={(e) => setEditEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                Enabled
              </label>
              <button type="button" onClick={() => setEditTarget(null)} aria-label="Close" className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg tp-focus-ring">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 p-4">
              <RichTextEditor
                value={editHtml}
                onChange={({ html, text }) => { setEditHtml(html); setEditText(text); }}
                placeholder="Signature…"
                ariaLabel={`Signature for ${editTarget.name}`}
                minHeight={130}
              />
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</div>
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-3">
                  {String(editHtml || '').trim()
                    ? <SafeHtml html={editHtml} />
                    : <p className="text-sm text-slate-400">Empty — their replies go out unsigned.</p>}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button type="button" onClick={() => setEditTarget(null)} className="tp-focus-ring px-3 py-2 rounded-lg text-sm text-slate-600 hover:text-slate-900">
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={editSaving}
                className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-60"
              >
                {editSaving && <Loader className="w-4 h-4 animate-spin" />}
                Save signature
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
