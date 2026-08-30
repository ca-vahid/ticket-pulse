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
  bgImageDataUrl: '',
};

// Downscale an uploaded background to a data URL that fits the server cap (~700 KB). Tries
// progressively smaller/softer JPEG encodes; photos almost always fit on the first pass.
const MAX_BG_DATA_URL_CHARS = 950_000;
function fileToBgDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode that image'));
      img.onload = () => {
        for (const [maxW, quality] of [[1920, 0.82], [1600, 0.74], [1280, 0.66]]) {
          const scale = Math.min(1, maxW / img.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL('image/jpeg', quality);
          if (out.length <= MAX_BG_DATA_URL_CHARS) {
            resolve(out);
            return;
          }
        }
        reject(new Error('That image is too large even after compression — try a smaller one'));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

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
        checked ? 'border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:bg-muted/50'
      }`}
    >
      <span>
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        {description && <span className="mt-1 block text-sm text-muted-foreground">{description}</span>}
      </span>
      <span className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-blue-600' : 'bg-muted-foreground/40'}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-card transition ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

function Field({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30"
      />
    </label>
  );
}

function AreaField({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-muted-foreground">{label}</span>
      <textarea
        value={value ?? ''}
        rows={2}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30"
      />
    </label>
  );
}

function Status({ status }) {
  if (!status) return null;
  const ok = status.type === 'success';
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
      ok ? 'border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'
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
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="text-sm font-semibold text-foreground">Theme</div>
      <p className="text-xs text-muted-foreground">Pick the look requesters see. Earth Sciences is the default.</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {FEEDBACK_THEME_LIST.map((t) => {
          const sel = value === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-center transition ${
                sel ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/10 ring-1 ring-blue-300' : 'border-border bg-card hover:bg-muted/50'
              }`}
            >
              <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full" style={{ background: CHIP_BG }}>
                {t.kind === 'image'
                  ? <img src={t.tiles[4]} alt="" className="h-full w-full object-contain p-1" />
                  : <Smile className="h-6 w-6 text-emerald-500" />}
              </span>
              <span className="text-[11px] font-semibold leading-tight text-foreground/85">{t.label}</span>
            </button>
          );
        })}
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-input bg-muted/25 p-2 text-center opacity-80">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><Plus className="h-5 w-5 text-muted-foreground/75" /></span>
          <span className="text-[11px] font-semibold leading-tight text-muted-foreground/75">Custom emojis</span>
          <span className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-1.5 text-[8px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-200">Soon</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/75">Want your own look? You can already upload a custom <b>background</b> below — custom emoji sets are coming.</p>
    </div>
  );
}

/** "Bring your own" v1 — a custom background image that replaces the theme's built-in one. */
function BackgroundCard({ settings, update, uploadBg }) {
  const theme = getFeedbackTheme(settings.theme);
  const custom = settings.bgImageDataUrl || '';
  const effective = custom || (theme.kind === 'image' ? theme.bg : null);
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Background</div>
          <p className="text-xs text-muted-foreground">
            {custom ? 'Custom image — shown behind the feedback card instead of the theme background.' : 'Currently using the theme’s built-in background.'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${custom ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' : 'bg-muted text-muted-foreground'}`}>
          {custom ? 'Custom' : 'Theme default'}
        </span>
      </div>
      <div className="h-24 overflow-hidden rounded-xl border border-border bg-muted/50">
        {effective ? (
          <img src={effective} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground/75">Soft accent gradient (classic theme default)</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground/85 hover:bg-muted/50">
          {custom ? <ImageIcon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
          {custom ? 'Replace background' : 'Upload background'}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={uploadBg} />
        </label>
        {custom && (
          <button
            type="button"
            onClick={() => update({ bgImageDataUrl: '' })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15"
          >
            <Trash2 className="h-4 w-4" /> Use theme background
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground/75">JPG, PNG, or WEBP. Large photos are resized automatically. Wide, soft images work best — the white card sits on top with a light overlay.</p>
    </div>
  );
}

/** A faithful-but-static preview of the live /feedback page so admins see their edits. */
function FeedbackPreview({ settings }) {
  const theme = getFeedbackTheme(settings.theme);
  const isImage = theme.kind === 'image';
  const accent = isImage ? theme.accent : (settings.accentColor || '#2563eb');
  const labels = [settings.label1, settings.label2, settings.label3, settings.label4, settings.label5];
  // Custom uploaded background wins over the theme's built-in one (matches the live page).
  const bgUrl = settings.bgImageDataUrl || (isImage ? theme.bg : null);
  const bgStyle = bgUrl
    ? {
      backgroundImage: `linear-gradient(180deg, rgba(255,255,255,.42), rgba(255,255,255,.62)), url('${bgUrl}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
    : { background: `radial-gradient(600px 280px at 50% -20%, ${accent}22, transparent 60%), #ffffff` };
  return (
    <div className="tp-light rounded-2xl border border-border p-5 shadow-sm" style={bgStyle}>
      <div className="mx-auto max-w-xs rounded-2xl border border-border bg-card/95 p-5 text-center shadow">
        {settings.logoDataUrl ? (
          <img src={settings.logoDataUrl} alt="" className="mx-auto mb-2 h-9 max-w-[140px] object-contain" />
        ) : (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: accent }}>
            {settings.brandName || 'Ticket Pulse'}
          </div>
        )}
        <div className="text-[11px] font-medium text-muted-foreground/75">Ticket #12345 · VPN access problem</div>
        <h3 className="mt-1 text-lg font-bold text-foreground">{settings.headline || 'How did we do?'}</h3>
        {settings.subtext && <p className="mt-1 text-xs leading-5 text-muted-foreground">{settings.subtext}</p>}
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
              <span className="text-[9px] font-semibold leading-tight text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
        {settings.commentEnabled && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left text-[11px] text-muted-foreground/75">
            {settings.commentPrompt || "Anything you'd like to add? (optional)"}
          </div>
        )}
        <div className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: accent }}>
          <SendHorizonal className="h-4 w-4" /> Send feedback
        </div>
        {settings.trademarkText && <div className="mt-3 text-[9px] text-muted-foreground/75">{settings.trademarkText}</div>}
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
        active ? 'bg-card text-foreground shadow-subtle ring-1 ring-black/5 dark:ring-white/10' : 'text-muted-foreground hover:bg-card/70 hover:text-foreground'
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 transition-colors ${active ? 'text-blue-600 dark:text-blue-300' : 'text-muted-foreground/75 group-hover:text-muted-foreground'}`} />
      <span className="text-[13px] font-semibold">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors ${
          active ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' : 'bg-secondary/70 text-muted-foreground group-hover:bg-secondary'
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
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label}</div>
      <div className="mt-0.5 text-2xl font-bold tabular-nums" style={{ color: accent || 'hsl(var(--foreground))' }}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground/75">{sub}</div>}
    </div>
  );
}

/** Appearance tab — theme selector, background, and branding (logo, accent, names, footer). */
function AppearanceSettings({ settings, update, uploadLogo, uploadBg }) {
  return (
    <>
      <ThemePicker value={settings.theme} onChange={(k) => update({ theme: k })} />

      <BackgroundCard settings={settings} update={update} uploadBg={uploadBg} />

      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Branding</div>
        <Field label="Brand name" value={settings.brandName} maxLength={120} onChange={(v) => update({ brandName: v })} placeholder="Shown when no logo is set" />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <span className="text-xs font-semibold uppercase text-muted-foreground">Accent color</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={settings.accentColor || '#2563eb'}
                onChange={(e) => update({ accentColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-border bg-card"
              />
              <input
                type="text"
                value={settings.accentColor || ''}
                onChange={(e) => update({ accentColor: e.target.value })}
                className="w-28 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground/85 hover:bg-muted/50">
              {settings.logoDataUrl ? <ImageIcon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {settings.logoDataUrl ? 'Replace logo' : 'Upload logo'}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={uploadLogo} />
            </label>
            {settings.logoDataUrl && (
              <button
                type="button"
                onClick={() => update({ logoDataUrl: '' })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15"
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
      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Wording</div>
        <Field label="Headline" value={settings.headline} maxLength={160} onChange={(v) => update({ headline: v })} placeholder="How did we do?" />
        <AreaField label="Subtext" value={settings.subtext} maxLength={400} onChange={(v) => update({ subtext: v })} placeholder="Short intro line under the headline" />
        <Field label="Thank-you message" value={settings.thankYouMessage} maxLength={400} onChange={(v) => update({ thankYouMessage: v })} placeholder="Shown after they submit" />
      </div>

      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Rating labels</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <span className="h-3 w-3 rounded-full" style={{ background: FACE_COLORS[n - 1] }} /> {n}
              </span>
              <input
                type="text"
                value={settings[`label${n}`] ?? ''}
                maxLength={40}
                onChange={(e) => update({ [`label${n}`]: e.target.value })}
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
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
    return <div className="rounded-2xl border border-border bg-card py-12 text-center text-sm text-muted-foreground/75">Loading feedback…</div>;
  }
  if (submissions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-input bg-card py-14 text-center">
        <MessagesSquare className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <div className="mt-2 text-sm font-semibold text-muted-foreground">No feedback yet</div>
        <p className="mt-1 text-xs text-muted-foreground/75">Ratings submitted from the feedback page will show up here.</p>
        <button type="button" onClick={onRefresh} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200">
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

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Rating distribution</div>
          {(scoreFilter != null || commentsOnly) && (
            <button type="button" onClick={() => { setScoreFilter(null); setCommentsOnly(false); }} className="text-xs font-semibold text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200">Clear filters</button>
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
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 transition ${active ? 'bg-blue-50 dark:bg-blue-500/15 ring-1 ring-blue-200 dark:ring-blue-500/30' : 'hover:bg-muted/50'}`}
              >
                <ScoreTile score={score} theme={theme} size="h-6 w-6" />
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full transition-all" style={{ width: `${pct}%`, background: FACE_COLORS[score - 1] }} />
                </span>
                <span className="w-8 text-right text-xs font-semibold tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={() => setCommentsOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${commentsOnly ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200' : 'border-border bg-card text-muted-foreground hover:bg-muted/50'}`}
          >
            <MessageSquare className="h-3.5 w-3.5" /> With comments only
          </button>
          <button type="button" onClick={onRefresh} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          <span>{filtered.length === submissions.length ? `${submissions.length} responses` : `${filtered.length} of ${submissions.length} shown`}</span>
          <span className="text-muted-foreground/75">Deleting is permanent</span>
        </div>
        {filtered.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground/75">No feedback matches the current filter.</div>
        ) : (
          <ul className="divide-y divide-border/60">
            {filtered.map((s) => {
              const idx = Math.min(Math.max((s.score || 1) - 1, 0), 4);
              return (
                <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                  <ScoreTile score={s.score} theme={theme} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-bold" style={{ color: FACE_COLORS[idx] }}>{s.score}/5</span>
                      <span className="font-semibold text-foreground/85">#{s.ticketNumber || '—'}</span>
                      {s.techName && <span className="text-muted-foreground/75">· {s.techName}</span>}
                      <span className="text-muted-foreground/75">· {s.submittedAt ? new Date(s.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
                    </div>
                    {s.subject && <div className="mt-0.5 truncate text-sm font-medium text-foreground" title={s.subject}>{s.subject}</div>}
                    {s.comment && (
                      <div className="mt-1 rounded-lg bg-muted/50 px-3 py-2 text-xs italic text-muted-foreground">“{s.comment}”</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(s)}
                    disabled={deletingId === s.id}
                    className="shrink-0 rounded-lg border border-border p-1.5 text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/15 disabled:opacity-50"
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

  const uploadBg = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
      setStatus({ type: 'error', message: 'Background must be a PNG, JPG, or WEBP image' });
      return;
    }
    try {
      const dataUrl = await fileToBgDataUrl(file);
      update({ bgImageDataUrl: dataUrl });
      setStatus({ type: 'success', message: 'Background ready — click Save to apply.' });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Could not process that image' });
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="tp-glass flex items-center gap-3 rounded-2xl border border-card/70 dark:border-white/10 p-5 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-300" />
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
            <code className="rounded bg-muted px-1.5 py-0.5">{'{{ ticket.feedbackUrl }}'}</code>.
            Customize the look, wording, and branding below; it shares the per-ticket link with the public status page.
          </>
        )}
      />

      <Status status={status} />

      {/* Sticky action bar — master toggle + preview + save stay reachable across every tab. */}
      <div className="tp-glass sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card/70 dark:border-white/10 px-3 py-2 shadow-subtle">
        <button
          type="button"
          onClick={() => update({ enabled: !settings.enabled })}
          title="When off, the feedback page shows a friendly closed message and submissions are rejected."
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1"
        >
          <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition ${settings.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-card shadow transition-all ${settings.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
          <span className="text-sm font-semibold text-foreground/85">{settings.enabled ? 'Collecting feedback' : 'Feedback paused'}</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openFullPreview}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-300 transition hover:bg-blue-50 dark:hover:bg-blue-500/15"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open full preview
          </button>
          <Button type="button" onClick={save} disabled={saving} variant="default">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </div>
      </div>

      <div role="tablist" className="inline-flex gap-1 rounded-xl border border-border bg-muted/70 p-1">
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
              ? <AppearanceSettings settings={settings} update={update} uploadLogo={uploadLogo} uploadBg={uploadBg} />
              : <ContentSettings settings={settings} update={update} />}
          </div>

          <aside className="lg:sticky lg:top-[4.75rem] lg:self-start">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live preview</div>
            <FeedbackPreview settings={settings} />
            <p className="mt-2 text-center text-[11px] text-muted-foreground/75">Use “Open full preview” above to click through the real page — nothing is recorded.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
