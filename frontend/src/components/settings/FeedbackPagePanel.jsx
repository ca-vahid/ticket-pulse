import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Palette,
  Plus,
  RefreshCw,
  Save,
  SendHorizonal,
  Smile,
  Star,
  Trash2,
  Type,
  Upload,
  XCircle,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui';
import { SettingsHero } from './SettingsLayoutPrimitives';
import { FEEDBACK_THEME_LIST, getFeedbackTheme } from '../../data/feedbackThemes';

const FACE_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#10b981'];
const MAX_LOGO_BYTES = 512 * 1024;

const DEFAULTS = {
  enabled: true,
  theme: 'earth',
  headline: 'How did we do?',
  subtext: 'Your feedback helps our team keep improving. It only takes a moment.',
  thankYouMessage: 'Thanks for letting us know — we really appreciate it.',
  commentEnabled: true,
  commentPrompt: "Anything you'd like to add? (optional)",
  label1: 'Bad',
  label2: 'Meh',
  label3: 'Okay',
  label4: 'Good',
  label5: 'Great',
  brandName: '',
  logoDataUrl: '',
  logoAltText: '',
  trademarkText: '',
  accentColor: '#2563eb',
};

function mergeSettings(data = {}) {
  const merged = {};
  for (const key of Object.keys(DEFAULTS)) {
    merged[key] = data[key] ?? DEFAULTS[key];
  }
  return merged;
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition ${
        checked ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'
      }`}
    >
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        {description && <span className="mt-1 block text-sm text-slate-500">{description}</span>}
      </span>
      <span className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-blue-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

function Field({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <input
        type="text"
        value={value ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
      />
    </label>
  );
}

function AreaField({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <textarea
        value={value ?? ''}
        rows={2}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
      />
    </label>
  );
}

function Status({ status }) {
  if (!status) return null;
  const ok = status.type === 'success';
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
      ok ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-red-200 bg-red-50 text-red-800'
    }`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {status.message}
    </div>
  );
}

const CHIP_BG = 'radial-gradient(circle at 50% 36%, #ffffff, #eef2f7)';

/** Theme selector grid — image themes show their "Great" tile; classic shows a smiley. */
function ThemePicker({ value, onChange }) {
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-900">Theme</div>
      <p className="text-xs text-slate-500">Pick the look requesters see. Earth Sciences is the default.</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {FEEDBACK_THEME_LIST.map((t) => {
          const sel = value === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-center transition ${
                sel ? 'border-blue-400 bg-blue-50/60 ring-1 ring-blue-300' : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full" style={{ background: CHIP_BG }}>
                {t.kind === 'image'
                  ? <img src={t.tiles[4]} alt="" className="h-full w-full object-contain p-1" />
                  : <Smile className="h-6 w-6 text-emerald-500" />}
              </span>
              <span className="text-[11px] font-semibold leading-tight text-slate-700">{t.label}</span>
            </button>
          );
        })}
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-2 text-center opacity-80">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100"><Plus className="h-5 w-5 text-slate-400" /></span>
          <span className="text-[11px] font-semibold leading-tight text-slate-400">Bring your own</span>
          <span className="rounded-full bg-amber-100 px-1.5 text-[8px] font-bold uppercase tracking-wide text-amber-700">Soon</span>
        </div>
      </div>
    </div>
  );
}

/** A faithful-but-static preview of the live /feedback page so admins see their edits. */
function FeedbackPreview({ settings }) {
  const theme = getFeedbackTheme(settings.theme);
  const isImage = theme.kind === 'image';
  const accent = isImage ? theme.accent : (settings.accentColor || '#2563eb');
  const labels = [settings.label1, settings.label2, settings.label3, settings.label4, settings.label5];
  const bgStyle = isImage
    ? {
      backgroundImage: `linear-gradient(180deg, rgba(255,255,255,.42), rgba(255,255,255,.62)), url('${theme.bg}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
    : { background: `radial-gradient(600px 280px at 50% -20%, ${accent}22, transparent 60%), #ffffff` };
  return (
    <div className="rounded-2xl border border-slate-200 p-5 shadow-sm" style={bgStyle}>
      <div className="mx-auto max-w-xs rounded-2xl border border-slate-200 bg-white/95 p-5 text-center shadow">
        {settings.logoDataUrl ? (
          <img src={settings.logoDataUrl} alt="" className="mx-auto mb-2 h-9 max-w-[140px] object-contain" />
        ) : (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: accent }}>
            {settings.brandName || 'Ticket Pulse'}
          </div>
        )}
        <div className="text-[11px] font-medium text-slate-400">Ticket #12345 · VPN access problem</div>
        <h3 className="mt-1 text-lg font-bold text-slate-900">{settings.headline || 'How did we do?'}</h3>
        {settings.subtext && <p className="mt-1 text-xs leading-5 text-slate-500">{settings.subtext}</p>}
        <div className="mx-auto mt-3 flex h-16 w-16 items-center justify-center overflow-hidden rounded-full" style={{ background: isImage ? CHIP_BG : '#ffcc4d' }}>
          {isImage ? <img src={theme.tiles[4]} alt="" className="h-full w-full object-contain p-1.5" /> : <span className="text-2xl">🙂</span>}
        </div>
        <div className="mt-3 flex items-start justify-between gap-1">
          {labels.map((label, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              {isImage ? (
                <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border-2" style={{ borderColor: i === 4 ? accent : '#e2e8f0', background: CHIP_BG }}>
                  <img src={theme.tiles[i]} alt="" className="h-full w-full object-contain p-0.5" />
                </span>
              ) : (
                <span className="h-7 w-7 rounded-full border-2" style={{ borderColor: FACE_COLORS[i], background: i === 4 ? FACE_COLORS[i] : '#fff' }} />
              )}
              <span className="text-[9px] font-semibold leading-tight text-slate-500">{label}</span>
            </div>
          ))}
        </div>
        {settings.commentEnabled && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-left text-[11px] text-slate-400">
            {settings.commentPrompt || "Anything you'd like to add? (optional)"}
          </div>
        )}
        <div className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: accent }}>
          <SendHorizonal className="h-4 w-4" /> Send feedback
        </div>
        {settings.trademarkText && <div className="mt-3 text-[9px] text-slate-400">{settings.trademarkText}</div>}
      </div>
    </div>
  );
}

/** Segmented tab button (matches the Mail Workflows settings tabs). */
function TabButton({ active, icon: Icon, label, count, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`group relative flex h-9 items-center gap-2 rounded-lg px-3.5 transition-all duration-200 ${
        active ? 'bg-white text-slate-900 shadow-subtle ring-1 ring-slate-900/5' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 transition-colors ${active ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
      <span className="text-[13px] font-semibold">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors ${
          active ? 'bg-blue-100 text-blue-700' : 'bg-slate-200/70 text-slate-500 group-hover:bg-slate-200'
        }`}>
          {count}
        </span>
      )}
    </button>
  );
}

const SCORE_EMOJI = ['😞', '😕', '😐', '🙂', '😄'];

/** A rating tile shown in the workspace's theme (themed rock when available, else a colored face). */
function ScoreTile({ score, theme, size = 'h-9 w-9' }) {
  const idx = Math.min(Math.max((score || 1) - 1, 0), 4);
  if (theme?.kind === 'image' && theme.tiles?.[idx]) {
    return (
      <span className={`flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full`} style={{ background: CHIP_BG }}>
        <img src={theme.tiles[idx]} alt="" className="h-full w-full object-contain p-0.5" />
      </span>
    );
  }
  return (
    <span className={`flex ${size} shrink-0 items-center justify-center rounded-full text-lg`} style={{ background: `${FACE_COLORS[idx]}1a` }}>
      {SCORE_EMOJI[idx]}
    </span>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-2xl font-bold tabular-nums" style={{ color: accent || '#0f172a' }}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

/** Appearance tab — theme selector + branding (logo, accent, names, footer). */
function AppearanceSettings({ settings, update, uploadLogo }) {
  return (
    <>
      <ThemePicker value={settings.theme} onChange={(k) => update({ theme: k })} />

      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">Branding</div>
        <Field label="Brand name" value={settings.brandName} maxLength={120} onChange={(v) => update({ brandName: v })} placeholder="Shown when no logo is set" />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <span className="text-xs font-semibold uppercase text-slate-500">Accent color</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={settings.accentColor || '#2563eb'}
                onChange={(e) => update({ accentColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-slate-200 bg-white"
              />
              <input
                type="text"
                value={settings.accentColor || ''}
                onChange={(e) => update({ accentColor: e.target.value })}
                className="w-28 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              {settings.logoDataUrl ? <ImageIcon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {settings.logoDataUrl ? 'Replace logo' : 'Upload logo'}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={uploadLogo} />
            </label>
            {settings.logoDataUrl && (
              <button
                type="button"
                onClick={() => update({ logoDataUrl: '' })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" /> Remove
              </button>
            )}
          </div>
        </div>
        <Field label="Footer / trademark text" value={settings.trademarkText} maxLength={300} onChange={(v) => update({ trademarkText: v })} placeholder="© Your Company. All rights reserved." />
      </div>
    </>
  );
}

/** Content tab — wording, rating labels, and the optional comment box. */
function ContentSettings({ settings, update }) {
  return (
    <>
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">Wording</div>
        <Field label="Headline" value={settings.headline} maxLength={160} onChange={(v) => update({ headline: v })} placeholder="How did we do?" />
        <AreaField label="Subtext" value={settings.subtext} maxLength={400} onChange={(v) => update({ subtext: v })} placeholder="Short intro line under the headline" />
        <Field label="Thank-you message" value={settings.thankYouMessage} maxLength={400} onChange={(v) => update({ thankYouMessage: v })} placeholder="Shown after they submit" />
      </div>

      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">Rating labels</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                <span className="h-3 w-3 rounded-full" style={{ background: FACE_COLORS[n - 1] }} /> {n}
              </span>
              <input
                type="text"
                value={settings[`label${n}`] ?? ''}
                maxLength={40}
                onChange={(e) => update({ [`label${n}`]: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        <Toggle
          label="Comment box"
          description="Let requesters add an optional free-text comment."
          checked={settings.commentEnabled}
          onChange={(v) => update({ commentEnabled: v })}
        />
        {settings.commentEnabled && (
          <Field label="Comment prompt" value={settings.commentPrompt} maxLength={200} onChange={(v) => update({ commentPrompt: v })} placeholder="Anything you'd like to add? (optional)" />
        )}
      </div>
    </>
  );
}

/** The enriched "Recent feedback" tab — summary stats, a clickable distribution, and rich rows. */
function RecentFeedback({ submissions, loading, onRefresh, onDelete, deletingId, theme }) {
  const [scoreFilter, setScoreFilter] = useState(null);
  const [commentsOnly, setCommentsOnly] = useState(false);

  const stats = useMemo(() => {
    const dist = [0, 0, 0, 0, 0];
    let sum = 0;
    let withComments = 0;
    submissions.forEach((s) => {
      const idx = Math.min(Math.max((s.score || 1) - 1, 0), 4);
      dist[idx] += 1;
      sum += s.score || 0;
      if (s.comment && s.comment.trim()) withComments += 1;
    });
    const n = submissions.length;
    return {
      n,
      avg: n ? sum / n : 0,
      dist,
      withComments,
      satisfaction: n ? Math.round(((dist[3] + dist[4]) / n) * 100) : 0,
      maxDist: Math.max(1, ...dist),
    };
  }, [submissions]);

  const filtered = submissions.filter((s) => (
    (scoreFilter == null || s.score === scoreFilter)
    && (!commentsOnly || (s.comment && s.comment.trim()))
  ));

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400">Loading feedback…</div>;
  }
  if (submissions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-14 text-center">
        <MessagesSquare className="mx-auto h-8 w-8 text-slate-300" />
        <div className="mt-2 text-sm font-semibold text-slate-600">No feedback yet</div>
        <p className="mt-1 text-xs text-slate-400">Ratings submitted from the feedback page will show up here.</p>
        <button type="button" onClick={onRefresh} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Responses" value={stats.n} sub="loaded (most recent)" />
        <StatCard
          label="Avg rating"
          value={stats.avg.toFixed(1)}
          sub={<span className="inline-flex items-center gap-1"><Star className="h-3 w-3 fill-amber-400 text-amber-400" /> out of 5</span>}
          accent={FACE_COLORS[Math.min(Math.max(Math.round(stats.avg) - 1, 0), 4)]}
        />
        <StatCard
          label="Satisfaction"
          value={`${stats.satisfaction}%`}
          sub="rated Good or Great"
          accent={stats.satisfaction >= 70 ? '#10b981' : stats.satisfaction >= 40 ? '#f59e0b' : '#ef4444'}
        />
        <StatCard label="With comments" value={stats.withComments} sub={`${stats.n ? Math.round((stats.withComments / stats.n) * 100) : 0}% of responses`} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-900">Rating distribution</div>
          {(scoreFilter != null || commentsOnly) && (
            <button type="button" onClick={() => { setScoreFilter(null); setCommentsOnly(false); }} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Clear filters</button>
          )}
        </div>
        <div className="space-y-1.5">
          {[5, 4, 3, 2, 1].map((score) => {
            const count = stats.dist[score - 1];
            const active = scoreFilter === score;
            const pct = Math.round((count / stats.maxDist) * 100);
            return (
              <button
                key={score}
                type="button"
                onClick={() => setScoreFilter(active ? null : score)}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 transition ${active ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50'}`}
              >
                <ScoreTile score={score} theme={theme} size="h-6 w-6" />
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span className="block h-full rounded-full transition-all" style={{ width: `${pct}%`, background: FACE_COLORS[score - 1] }} />
                </span>
                <span className="w-8 text-right text-xs font-semibold tabular-nums text-slate-500">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={() => setCommentsOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${commentsOnly ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <MessageSquare className="h-3.5 w-3.5" /> With comments only
          </button>
          <button type="button" onClick={onRefresh} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500">
          <span>{filtered.length === submissions.length ? `${submissions.length} responses` : `${filtered.length} of ${submissions.length} shown`}</span>
          <span className="text-slate-400">Deleting is permanent</span>
        </div>
        {filtered.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">No feedback matches the current filter.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((s) => {
              const idx = Math.min(Math.max((s.score || 1) - 1, 0), 4);
              return (
                <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                  <ScoreTile score={s.score} theme={theme} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-bold" style={{ color: FACE_COLORS[idx] }}>{s.score}/5</span>
                      <span className="font-semibold text-slate-700">#{s.ticketNumber || '—'}</span>
                      {s.techName && <span className="text-slate-400">· {s.techName}</span>}
                      <span className="text-slate-400">· {s.submittedAt ? new Date(s.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
                    </div>
                    {s.subject && <div className="mt-0.5 truncate text-sm font-medium text-slate-800" title={s.subject}>{s.subject}</div>}
                    {s.comment && (
                      <div className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs italic text-slate-600">“{s.comment}”</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(s)}
                    disabled={deletingId === s.id}
                    className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-red-500 transition hover:bg-red-50 disabled:opacity-50"
                    title="Delete this feedback"
                  >
                    {deletingId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function FeedbackPagePanel() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id || null;
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [activeTab, setActiveTab] = useState('appearance');

  const workspaceRequestConfig = useMemo(() => (
    workspaceId ? { headers: { 'X-Workspace-Id': String(workspaceId) } } : {}
  ), [workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false);
      setStatus({ type: 'error', message: 'Select a workspace before editing the feedback page' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const response = await settingsAPI.getFeedbackSettings(workspaceRequestConfig);
      setSettings(mergeSettings(response.data || {}));
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to load feedback settings' });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, workspaceRequestConfig]);

  const loadSubmissions = useCallback(async () => {
    if (!workspaceId) return;
    setSubmissionsLoading(true);
    try {
      const response = await settingsAPI.listFeedbackSubmissions({ ...workspaceRequestConfig, params: { limit: 200 } });
      setSubmissions(response.data || []);
    } catch { /* non-fatal */ } finally {
      setSubmissionsLoading(false);
    }
  }, [workspaceId, workspaceRequestConfig]);

  useEffect(() => {
    load();
    loadSubmissions();
  }, [load, loadSubmissions]);

  const update = (patch) => setSettings((current) => ({ ...current, ...patch }));

  const deleteSubmission = async (row) => {
    if (!window.confirm(`Delete the feedback on ticket #${row.ticketNumber || row.id}? This permanently removes the rating and comment.`)) return;
    setDeletingId(row.id);
    try {
      await settingsAPI.deleteFeedbackSubmission(row.id, workspaceRequestConfig);
      setSubmissions((cur) => cur.filter((s) => s.id !== row.id));
      setStatus({ type: 'success', message: `Deleted feedback for ticket #${row.ticketNumber || row.id}` });
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to delete feedback' });
    } finally {
      setDeletingId(null);
    }
  };

  // Open the real /feedback page in preview mode, seeded with the current (unsaved)
  // settings via localStorage, so admins can click through the full experience.
  const openFullPreview = () => {
    try { localStorage.setItem('tp_feedback_preview', JSON.stringify(settings)); } catch { /* ignore */ }
    window.open('/feedback/preview', '_blank', 'noopener');
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await settingsAPI.updateFeedbackSettings(settings, workspaceRequestConfig);
      setSettings(mergeSettings(response.data || {}));
      setStatus({ type: 'success', message: 'Feedback page settings saved' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
      setStatus({ type: 'error', message: 'Logo must be a PNG, JPG, WEBP, or GIF image' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setStatus({ type: 'error', message: 'Logo must be 512 KB or smaller' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      update({
        logoDataUrl: String(reader.result || ''),
        logoAltText: settings.logoAltText || file.name.replace(/\.[^.]+$/, ''),
      });
      setStatus({ type: 'success', message: 'Logo ready — click Save to apply.' });
    };
    reader.onerror = () => setStatus({ type: 'error', message: 'Could not read that logo file' });
    reader.readAsDataURL(file);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="tp-glass flex items-center gap-3 rounded-2xl border border-white/70 p-5 text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          Loading feedback page settings
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <SettingsHero
        eyebrow="Requester-facing pages"
        title="Feedback Page"
        description={(
          <>
            The first-party satisfaction page requesters land on from mail workflow links like{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">{'{{ ticket.feedbackUrl }}'}</code>.
            Customize the look, wording, and branding below; it shares the per-ticket link with the public status page.
          </>
        )}
      />

      <Status status={status} />

      {/* Sticky action bar — master toggle + preview + save stay reachable across every tab. */}
      <div className="tp-glass sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/70 px-3 py-2 shadow-subtle">
        <button
          type="button"
          onClick={() => update({ enabled: !settings.enabled })}
          title="When off, the feedback page shows a friendly closed message and submissions are rejected."
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1"
        >
          <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition ${settings.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${settings.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
          <span className="text-sm font-semibold text-slate-700">{settings.enabled ? 'Collecting feedback' : 'Feedback paused'}</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openFullPreview}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-600 transition hover:bg-blue-50"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open full preview
          </button>
          <Button type="button" onClick={save} disabled={saving} variant="default">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </div>
      </div>

      <div role="tablist" className="inline-flex gap-1 rounded-xl border border-slate-200 bg-slate-100/70 p-1">
        <TabButton active={activeTab === 'appearance'} icon={Palette} label="Appearance" onClick={() => setActiveTab('appearance')} />
        <TabButton active={activeTab === 'content'} icon={Type} label="Content" onClick={() => setActiveTab('content')} />
        <TabButton active={activeTab === 'recent'} icon={MessagesSquare} label="Recent feedback" count={submissions.length} onClick={() => setActiveTab('recent')} />
      </div>

      {activeTab === 'recent' ? (
        <RecentFeedback
          submissions={submissions}
          loading={submissionsLoading}
          onRefresh={loadSubmissions}
          onDelete={deleteSubmission}
          deletingId={deletingId}
          theme={getFeedbackTheme(settings.theme)}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            {activeTab === 'appearance'
              ? <AppearanceSettings settings={settings} update={update} uploadLogo={uploadLogo} />
              : <ContentSettings settings={settings} update={update} />}
          </div>

          <aside className="lg:sticky lg:top-[4.75rem] lg:self-start">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Live preview</div>
            <FeedbackPreview settings={settings} />
            <p className="mt-2 text-center text-[11px] text-slate-400">Use “Open full preview” above to click through the real page — nothing is recorded.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
