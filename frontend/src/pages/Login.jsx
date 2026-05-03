import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { loginWithSSO, isAuthenticated, isLoading, error } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousHtmlBackground = document.documentElement.style.backgroundColor;
    document.body.style.backgroundColor = '#020617';
    document.documentElement.style.backgroundColor = '#020617';
    return () => {
      document.body.style.backgroundColor = previousBodyBackground;
      document.documentElement.style.backgroundColor = previousHtmlBackground;
    };
  }, []);

  return (
    <main className="fixed inset-0 h-screen h-[100lvh] min-h-[100dvh] w-full overflow-hidden bg-slate-950 text-white">
      <img
        src="/brand/ticket-pulse-new-loginpage.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[8%_center] md:object-center"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-slate-950/35 via-slate-950/5 to-slate-950/10" />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/45 via-transparent to-slate-950/15 md:from-slate-950/20" />
      <img
        src="/brand/bgc-logo-transparent.png"
        alt="BGC Engineering"
        className="pointer-events-none absolute bottom-5 right-5 z-20 h-24 w-auto brightness-0 invert opacity-82 drop-shadow-[0_14px_32px_rgba(0,0,0,0.55)] sm:bottom-7 sm:right-7 sm:h-28 md:bottom-9 md:right-10 md:h-36 lg:h-44 xl:h-48"
      />

      <section className="relative z-10 flex h-full min-h-[100dvh] items-end justify-center px-5 pb-10 pt-8 sm:px-8 sm:pb-14 md:items-start md:justify-start md:px-[5.4vw] md:pt-[58vh] lg:pt-[59vh]">
        <div className="w-full max-w-[20rem] sm:max-w-[26rem]">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-200/40 bg-red-950/40 px-4 py-3 text-sm text-red-100 shadow-2xl shadow-red-950/20 backdrop-blur-xl">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-none" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={loginWithSSO}
            disabled={isLoading}
            className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-[1.35rem] border border-cyan-100/35 bg-slate-800/62 px-6 py-[1.125rem] text-base font-semibold text-white shadow-[0_24px_80px_rgba(0,0,0,0.46),inset_0_1px_0_rgba(255,255,255,0.42),inset_0_-18px_45px_rgba(14,165,233,0.12)] backdrop-blur-2xl transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-100/60 hover:bg-slate-700/68 hover:shadow-[0_30px_90px_rgba(8,47,73,0.52),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-18px_50px_rgba(34,211,238,0.16)] focus:outline-none focus:ring-2 focus:ring-cyan-200/70 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/16 via-transparent to-cyan-300/10 opacity-90" />
            <svg
              className="relative h-5 w-5 flex-none"
              viewBox="0 0 21 21"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <rect width="10" height="10" fill="#f25022" />
              <rect x="11" width="10" height="10" fill="#7fba00" />
              <rect y="11" width="10" height="10" fill="#00a4ef" />
              <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
            </svg>
            <span className="relative">{isLoading ? 'Signing you in...' : 'Sign in with your BGC Account'}</span>
          </button>

          <div className="mx-auto mt-4 max-w-[22rem] rounded-xl bg-slate-950/28 px-4 py-3 text-center shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-sm">
            <p className="space-y-0.5 overflow-hidden text-xs leading-5 text-cyan-50/76 [text-shadow:0_2px_18px_rgba(0,0,0,0.65)]">
              <span className="block whitespace-nowrap font-semibold text-white/92">BGC Engineering AI Tools</span>
              <span className="block whitespace-nowrap">Internal operations for authorized BGC users.</span>
              <span className="block whitespace-nowrap text-cyan-50/58">© {new Date().getFullYear()} BGC Engineering Inc.</span>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
