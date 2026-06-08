import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { CheckCircle2, Loader2, MessageSquareHeart, SendHorizonal } from 'lucide-react';
import { publicTicketFeedbackAPI } from '../services/api';
import { getFeedbackTheme } from '../data/feedbackThemes';

const DEFAULT_LABELS = ['Bad', 'Meh', 'Okay', 'Good', 'Great'];
const DEFAULT_ACCENT = '#2563eb';
// Emotion palette: red -> orange -> amber -> lime -> emerald (label + selection ring).
const FACE_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981'];
const CHIP_BG = 'radial-gradient(circle at 50% 36%, #ffffff, #eef2f7)';

function unwrap(response) {
  return response?.data ?? response ?? null;
}

function errMessage(err, fallback) {
  return err?.response?.data?.message || err?.message || fallback;
}

export const FEEDBACK_PREVIEW_KEY = 'tp_feedback_preview';

// Build a sample public payload from the admin's (possibly unsaved) settings so the
// /feedback/preview route renders the full interactive experience without a real token.
function previewPayloadFromSettings(s) {
  const v = s || {};
  const labels = [v.label1, v.label2, v.label3, v.label4, v.label5];
  return {
    theme: v.theme || 'earth',
    ticket: { number: '12345', subject: 'VPN access problem', status: 'Resolved' },
    branding: {
      brandName: v.brandName || 'Ticket Pulse',
      logoDataUrl: v.logoDataUrl || null,
      logoAltText: v.logoAltText || v.brandName || null,
      trademarkText: v.trademarkText || null,
      accentColor: v.accentColor || DEFAULT_ACCENT,
    },
    page: {
      headline: v.headline || 'How did we do?',
      subtext: v.subtext || 'Your feedback helps our team keep improving. It only takes a moment.',
      thankYouMessage: v.thankYouMessage || 'Thanks for letting us know — we really appreciate it.',
      commentEnabled: v.commentEnabled !== false,
      commentPrompt: v.commentPrompt || "Anything you'd like to add? (optional)",
      labels: labels.every(Boolean) ? labels : DEFAULT_LABELS,
    },
    existing: null,
  };
}

function lerp(a, b, v) {
  return a + (b - a) * v;
}

function scoreToT(score) {
  if (!score) return 0.5; // neutral resting pose before a pick
  return (score - 1) / 4;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(37,99,235,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/**
 * The classic animated hero face — mouth, colour, cheeks and eyes spring between five
 * emotional states driven by `score` (1-5). Honours prefers-reduced-motion.
 */
function MorphFace({ score, reduced }) {
  const target = scoreToT(score);
  const spring = useSpring(target, reduced ? { duration: 0 } : { stiffness: 220, damping: 18 });
  const pop = useSpring(1, reduced ? { duration: 0 } : { stiffness: 400, damping: 12 });

  useEffect(() => {
    spring.set(target);
    if (!reduced && score) {
      pop.set(1.08);
      const id = setTimeout(() => pop.set(1), 150);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [target, score, reduced, spring, pop]);

  const faceColor = useTransform(spring, [0, 0.25, 0.5, 0.75, 1], FACE_COLORS);
  const mouthD = useTransform(spring, (v) => {
    const curve = lerp(-26, 44, v);
    const lift = lerp(6, 0, v);
    return `M60 ${132 - lift} Q100 ${132 + curve} 140 ${132 - lift}`;
  });
  const mouthWidth = useTransform(spring, [0, 1], [11, 13]);
  const blush = useTransform(spring, [0.55, 1], [0, 0.55]);
  const browY = useTransform(spring, [0, 1], [7, -6]);
  const browTilt = useTransform(spring, [0, 0.5, 1], [15, 0, -2]);
  const browTiltLeft = useTransform(browTilt, (d) => -d);

  return (
    <motion.svg viewBox="0 0 200 200" width="100%" height="100%" style={{ scale: pop }} role="img" aria-hidden="true">
      <motion.circle cx="100" cy="100" r="92" style={{ fill: faceColor }} />
      <motion.circle cx="58" cy="118" r="13" fill="#ffffff" style={{ opacity: blush }} />
      <motion.circle cx="142" cy="118" r="13" fill="#ffffff" style={{ opacity: blush }} />
      <circle cx="72" cy="86" r="9.5" fill="#0f172a" />
      <circle cx="128" cy="86" r="9.5" fill="#0f172a" />
      <circle cx="75" cy="83" r="3" fill="#ffffff" />
      <circle cx="131" cy="83" r="3" fill="#ffffff" />
      <motion.line x1="58" y1="66" x2="86" y2="66" stroke="#0f172a" strokeWidth="6" strokeLinecap="round"
        style={{ y: browY, rotate: browTiltLeft, originX: '72px', originY: '66px' }} />
      <motion.line x1="114" y1="66" x2="142" y2="66" stroke="#0f172a" strokeWidth="6" strokeLinecap="round"
        style={{ y: browY, rotate: browTilt, originX: '128px', originY: '66px' }} />
      <motion.path d={mouthD} fill="none" stroke="#0f172a" style={{ strokeWidth: mouthWidth }} strokeLinecap="round" />
    </motion.svg>
  );
}

/** A themed image face (one of the five generated tiles) inside a soft circular chip. */
function ImageFace({ src }) {
  return (
    <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full" style={{ background: CHIP_BG }}>
      <img src={src} alt="" className="h-full w-full object-contain p-2.5" />
    </span>
  );
}

function ScoreButton({ index, label, active, accent, imgSrc, onPick, onHover, onLeave, registerRef }) {
  const color = FACE_COLORS[index];
  return (
    <button
      type="button"
      ref={registerRef}
      role="radio"
      aria-checked={active}
      aria-label={`${label} (${index + 1} of 5)`}
      onClick={() => onPick(index + 1)}
      onMouseEnter={() => onHover(index + 1)}
      onMouseLeave={onLeave}
      onFocus={() => onHover(index + 1)}
      onBlur={onLeave}
      className="group flex flex-1 flex-col items-center gap-2 rounded-2xl px-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{ '--tw-ring-color': accent }}
    >
      <span
        className={`flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border-2 transition-all duration-200 sm:h-12 sm:w-12 ${
          active ? 'scale-110 shadow-md' : 'group-hover:scale-105'
        }`}
        style={{
          borderColor: active ? color : '#e2e8f0',
          background: imgSrc ? CHIP_BG : (active ? color : '#ffffff'),
        }}
      >
        {imgSrc ? (
          <img src={imgSrc} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <span className={`h-3 w-3 rounded-full transition-colors ${active ? 'bg-white' : 'bg-slate-200 group-hover:bg-slate-300'}`} />
        )}
      </span>
      <span className={`text-center text-[11px] font-semibold leading-tight transition-colors sm:text-xs ${active ? 'text-slate-900' : 'text-slate-500'}`}>
        {label}
      </span>
    </button>
  );
}

function Shell({ accent, bgImage, preview, children }) {
  const style = bgImage
    ? {
      backgroundImage: `linear-gradient(180deg, rgba(255,255,255,.34), rgba(255,255,255,.56)), url('${bgImage}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
    : {
      background: `radial-gradient(1200px 600px at 50% -10%, ${hexToRgba(accent, 0.16)}, transparent 60%), linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)`,
    };
  return (
    <div className="flex min-h-screen items-center justify-center p-4 sm:p-6" style={style}>
      {preview && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-slate-900/95 px-4 py-1.5 text-center text-xs font-semibold text-white">
          <span>Preview — this is exactly what requesters see. Submissions are not recorded.</span>
          <button type="button" onClick={() => window.close()} className="rounded bg-white/15 px-2 py-0.5 font-bold hover:bg-white/25">Close</button>
        </div>
      )}
      {children}
    </div>
  );
}

function CenteredCard({ children }) {
  return (
    <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white/90 p-6 text-center shadow-xl backdrop-blur sm:p-8">
      {children}
    </div>
  );
}

export default function PublicTicketFeedback() {
  const { token } = useParams();
  const isPreview = token === 'preview';
  const reduced = useReducedMotion();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [comment, setComment] = useState('');
  const btnRefs = useRef([]);

  const load = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    if (isPreview) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(FEEDBACK_PREVIEW_KEY) || 'null'); } catch { /* ignore */ }
      setData(previewPayloadFromSettings(stored));
      setLoading(false);
      return;
    }
    try {
      const payload = unwrap(await publicTicketFeedbackAPI.get(token));
      setData(payload);
      if (payload?.existing?.score) {
        setSelected(payload.existing.score);
        setComment(payload.existing.comment || '');
      }
    } catch (err) {
      setFatal(errMessage(err, 'This feedback link is no longer available.'));
    } finally {
      setLoading(false);
    }
  }, [token, isPreview]);

  useEffect(() => {
    load();
  }, [load]);

  const theme = getFeedbackTheme(data?.theme);
  const isImage = theme.kind === 'image';
  const accent = isImage ? theme.accent : (data?.branding?.accentColor || DEFAULT_ACCENT);
  const page = data?.page || {};
  const labels = (page.labels && page.labels.length === 5) ? page.labels : DEFAULT_LABELS;
  const display = hover || selected || null;
  const alreadyRated = Boolean(data?.existing?.score);

  const renderHero = (score) => (
    isImage
      ? <ImageFace src={theme.tiles[(score || 3) - 1]} />
      : <MorphFace score={score} reduced={reduced} />
  );

  const onKeyDown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const base = selected || 3;
    const next = ['ArrowRight', 'ArrowUp'].includes(e.key) ? Math.min(base + 1, 5) : Math.max(base - 1, 1);
    setSelected(next);
    btnRefs.current[next - 1]?.focus();
  };

  const submit = async () => {
    if (!selected || submitting) return;
    if (isPreview) {
      setDone({ score: selected, thankYouMessage: page.thankYouMessage });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = unwrap(await publicTicketFeedbackAPI.submit(token, { score: selected, comment }));
      setDone(result || { score: selected, thankYouMessage: page.thankYouMessage });
    } catch (err) {
      setError(errMessage(err, 'Your feedback could not be sent. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Shell accent={DEFAULT_ACCENT} preview={isPreview}>
        <CenteredCard>
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-400" />
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        </CenteredCard>
      </Shell>
    );
  }

  if (fatal) {
    return (
      <Shell accent={DEFAULT_ACCENT} preview={isPreview}>
        <CenteredCard>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
            <MessageSquareHeart className="h-7 w-7 text-slate-400" />
          </div>
          <h1 className="mt-4 text-lg font-bold text-slate-900">Feedback link unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">{fatal}</p>
        </CenteredCard>
      </Shell>
    );
  }

  if (done) {
    const score = done.score || selected || 5;
    return (
      <Shell accent={accent} bgImage={isImage ? theme.bg : null} preview={isPreview}>
        <CenteredCard>
          <motion.div
            initial={reduced ? false : { scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 240, damping: 16 }}
            className="mx-auto h-28 w-28"
          >
            {renderHero(score)}
          </motion.div>
          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Feedback received
          </div>
          <h1 className="mt-3 text-xl font-bold text-slate-900">
            {done.thankYouMessage || page.thankYouMessage || 'Thanks for your feedback!'}
          </h1>
          {comment.trim() && (
            <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-left text-sm italic text-slate-600">“{comment.trim()}”</p>
          )}
          {data?.branding?.trademarkText && (
            <p className="mt-6 text-[11px] text-slate-400">{data.branding.trademarkText}</p>
          )}
        </CenteredCard>
      </Shell>
    );
  }

  return (
    <Shell accent={accent} bgImage={isImage ? theme.bg : null} preview={isPreview}>
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white/95 p-6 shadow-xl backdrop-blur sm:p-8">
        <div className="flex flex-col items-center text-center">
          {data?.branding?.logoDataUrl ? (
            <img src={data.branding.logoDataUrl} alt={data.branding.logoAltText || data?.branding?.brandName || ''} className="mb-3 h-12 max-w-[180px] object-contain" />
          ) : (
            <div className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: accent }}>
              {data?.branding?.brandName || 'Ticket Pulse'}
            </div>
          )}
          {data?.ticket?.number && (
            <div className="text-xs font-medium text-slate-400">
              Ticket #{data.ticket.number}{data.ticket.subject ? ` · ${data.ticket.subject}` : ''}
            </div>
          )}
          <h1 className="mt-2 text-2xl font-bold text-slate-900">{page.headline || 'How did we do?'}</h1>
          {page.subtext && <p className="mt-2 text-sm leading-6 text-slate-500">{page.subtext}</p>}
        </div>

        <div className="mx-auto mt-6 h-36 w-36 sm:h-40 sm:w-40">
          {renderHero(display)}
        </div>
        <div className="mt-3 h-6 text-center text-base font-bold" style={{ color: display ? FACE_COLORS[display - 1] : '#94a3b8' }}>
          {display ? labels[display - 1] : 'Tap a face to rate'}
        </div>

        <div role="radiogroup" aria-label="Rate your support experience" onKeyDown={onKeyDown} className="mt-4 flex items-start justify-between gap-1">
          {labels.map((label, i) => (
            <ScoreButton
              key={label + i}
              index={i}
              label={label}
              active={selected === i + 1}
              accent={accent}
              imgSrc={isImage ? theme.tiles[i] : null}
              onPick={setSelected}
              onHover={setHover}
              onLeave={() => setHover(null)}
              registerRef={(el) => { btnRefs.current[i] = el; }}
            />
          ))}
        </div>

        {page.commentEnabled !== false && (
          <div className="mt-5">
            <label htmlFor="tp-feedback-comment" className="sr-only">{page.commentPrompt || 'Additional comments'}</label>
            <textarea
              id="tp-feedback-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={page.commentPrompt || "Anything you'd like to add? (optional)"}
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white focus:ring-2"
              style={{ '--tw-ring-color': hexToRgba(accent, 0.35) }}
            />
          </div>
        )}

        {alreadyRated && (
          <p className="mt-3 text-center text-xs text-slate-400">You already shared feedback for this ticket. Submitting again updates it.</p>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!selected || submitting}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-base font-bold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: accent }}
        >
          {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizonal className="h-5 w-5" />}
          {submitting ? 'Sending…' : alreadyRated ? 'Update feedback' : 'Send feedback'}
        </button>

        {data?.branding?.trademarkText && (
          <p className="mt-5 text-center text-[11px] text-slate-400">{data.branding.trademarkText}</p>
        )}
      </div>
    </Shell>
  );
}
