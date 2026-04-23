import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Scale, Plug, ShieldCheck, ArrowRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const FEATURES = [
  {
    icon: Activity,
    title: 'Real-time pulse',
    desc: 'Live ticket distribution updates within 30 seconds via SSE.',
  },
  {
    icon: Scale,
    title: 'Fair workload',
    desc: 'Workload meters surface heavy-load technicians at a glance.',
  },
  {
    icon: Plug,
    title: 'FreshService native',
    desc: 'Two-way sync with your existing FreshService workspace.',
  },
];

export default function Login() {
  const { loginWithSSO, isAuthenticated, isLoading, error } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 lg:grid lg:grid-cols-[1.15fr_1fr] xl:grid-cols-[1.25fr_1fr]">
      {/* ============================================================
       * LEFT — Brand / hero pane
       * ============================================================ */}
      <section
        aria-hidden="true"
        className="relative overflow-hidden min-h-[52vh] lg:min-h-screen lg:flex lg:flex-col lg:justify-between"
      >
        {/* Hero illustration */}
        <img
          src="/brand/hero-welcome.webp"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Subtle slate gradients — let the illustration shine, just darken
            the corners enough that text reads cleanly. */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/55 via-transparent to-slate-950/65" />
        <div className="hidden lg:block absolute inset-0 bg-gradient-to-r from-slate-950/35 via-transparent to-slate-950/30" />
        {/* Mobile: soft fade from hero to the form pane below */}
        <div className="lg:hidden absolute bottom-0 inset-x-0 h-28 bg-gradient-to-b from-transparent to-[#e9eefe] pointer-events-none" />
        {/* Soft blurred color blobs for that modern Stripe-y depth */}
        <div className="hidden lg:block absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-indigo-500/25 blur-3xl pointer-events-none" />
        <div className="hidden lg:block absolute -top-32 -right-24 h-80 w-80 rounded-full bg-teal-400/20 blur-3xl pointer-events-none" />

        {/* TOP: brand identity (anchored to top-left on desktop, bottom on mobile) */}
        <div className="hidden lg:block relative z-10 px-12 xl:px-16 pt-12">
          <div className="flex items-center gap-4">
            <div className="relative flex-none">
              <span className="absolute inset-0 rounded-2xl bg-teal-400/40 blur-2xl animate-pulse" />
              <img
                src="/brand/logo-mark.png"
                alt=""
                className="relative h-16 w-16 xl:h-20 xl:w-20 drop-shadow-2xl"
              />
            </div>
            <div className="min-w-0">
              <div className="text-2xl xl:text-3xl font-bold tracking-tight text-white leading-none">
                Ticket Pulse
              </div>
              <div className="text-xs xl:text-sm text-teal-300 font-medium tracking-wider uppercase mt-1.5">
                Dashboard
              </div>
            </div>
          </div>
        </div>

        {/* MOBILE-ONLY: compact brand identity anchored top-left of hero,
            sitting cleanly on the dark "sky" portion of the illustration */}
        <div className="lg:hidden absolute top-0 left-0 right-0 z-10 px-6 sm:px-10 pt-8">
          <div className="flex items-center gap-3">
            <div className="relative flex-none">
              <span className="absolute inset-0 rounded-2xl bg-teal-400/40 blur-xl animate-pulse" />
              <img
                src="/brand/logo-mark.png"
                alt=""
                className="relative h-12 w-12 drop-shadow-2xl"
              />
            </div>
            <div className="min-w-0">
              <div className="text-xl font-bold tracking-tight text-white leading-none">
                Ticket Pulse
              </div>
              <div className="text-[10px] text-teal-300 font-medium tracking-wider uppercase mt-1.5">
                Dashboard
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
       * RIGHT — Sign-in panel
       * ============================================================ */}
      <section
        className="relative text-slate-900 flex items-center justify-center px-6 py-10 lg:py-12 lg:px-12"
        style={{
          backgroundImage: 'url(/brand/panel-background.webp)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundColor: '#eef2ff',
        }}
      >
        {/* Soft light wash so the form card has extra breathing room */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-br from-white/40 via-white/10 to-transparent pointer-events-none"
        />
        {/* Top-right dot grid accent */}
        <div
          aria-hidden="true"
          className="absolute top-8 right-8 h-32 w-32 opacity-40 pointer-events-none"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgb(99 102 241 / 0.5) 1.2px, transparent 1.2px)',
            backgroundSize: '14px 14px',
          }}
        />

        <div className="relative z-10 w-full max-w-md animate-fadeIn">
          {/* Soft colored halo behind the card for ambient depth */}
          <div
            aria-hidden="true"
            className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-indigo-400/25 via-transparent to-teal-400/25 blur-2xl pointer-events-none"
          />
          {/* Card with layered borders + ring + shadow */}
          <div className="relative rounded-3xl bg-white/95 backdrop-blur-2xl ring-1 ring-slate-200/70 border border-white shadow-[0_30px_60px_-15px_rgba(15,23,42,0.25),0_0_0_1px_rgba(255,255,255,0.6)_inset] p-8 lg:p-10">
            {/* Subtle top inner highlight to suggest a glass surface */}
            <div
              aria-hidden="true"
              className="absolute top-0 left-6 right-6 h-px bg-gradient-to-r from-transparent via-white to-transparent pointer-events-none"
            />

            {/* Heading — centered */}
            <div className="mb-8 text-center">
              <h2 className="text-3xl lg:text-4xl font-bold tracking-tight text-slate-900 mb-2">
                Welcome back.
              </h2>
              <p className="text-slate-500 text-base">
                Sign in to your dashboard.
              </p>
            </div>

            {/* Error banner */}
            {error && (
              <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 mt-0.5 flex-none" />
                <span>{error}</span>
              </div>
            )}

            {/* Microsoft SSO */}
            <button
              onClick={loginWithSSO}
              disabled={isLoading}
              className="group w-full flex items-center justify-center gap-3 bg-[#2f2f2f] hover:bg-black text-white font-semibold py-3.5 px-5 rounded-xl transition-all duration-200 shadow-lg shadow-slate-900/15 hover:shadow-xl hover:shadow-slate-900/25 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#2f2f2f]"
            >
              <svg
                className="w-5 h-5 flex-none"
                viewBox="0 0 21 21"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect width="10" height="10" fill="#f25022" />
                <rect x="11" width="10" height="10" fill="#7fba00" />
                <rect y="11" width="10" height="10" fill="#00a4ef" />
                <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
              </svg>
              <span className="text-base">
                {isLoading ? 'Signing you in…' : 'Continue with Microsoft'}
              </span>
              {!isLoading && (
                <ArrowRight className="h-4 w-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200" />
              )}
            </button>

            {/* Divider */}
            <div className="mt-8 flex items-center gap-3 text-xs text-slate-400">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="uppercase tracking-wider">Single sign-on only</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* Footer */}
            <div className="mt-8 text-center text-xs text-slate-500 leading-relaxed">
              <p>
                Authentication is managed by your organization's Microsoft Entra ID.
                <br className="hidden sm:inline" />
                Need help?{' '}
                <a
                  href="mailto:helpdesk@example.com"
                  className="text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Contact your administrator
                </a>
                .
              </p>
            </div>

            {/* Feature pills — compact 3-column footer inside the form card */}
            <div className="mt-8 pt-6 border-t border-slate-100 grid grid-cols-3 gap-2">
              {FEATURES.map(({ icon: Icon, title }) => (
                <div
                  key={title}
                  className="flex flex-col items-center text-center gap-1.5 rounded-xl py-2 px-1"
                  title={title}
                >
                  <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-500 to-teal-400 grid place-items-center shadow-sm">
                    <Icon className="h-[18px] w-[18px] text-white" strokeWidth={2.25} />
                  </div>
                  <div className="text-[10px] font-semibold text-slate-700 leading-tight">
                    {title}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Copyright — sits below the card as legal fine print */}
          <p className="mt-6 text-center text-xs text-slate-500/90">
            © {new Date().getFullYear()} BGC Engineering Inc.
          </p>
        </div>
      </section>
    </div>
  );
}
