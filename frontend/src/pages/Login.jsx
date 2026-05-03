import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
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

      <section className="relative z-10 flex h-full min-h-[100dvh] items-end justify-center px-5 pb-10 pt-8 sm:px-8 sm:pb-14 md:items-start md:justify-start md:px-[5.4vw] md:pt-[58vh] lg:pt-[59vh]">
        <div className="w-full max-w-[18.5rem] sm:max-w-sm md:max-w-[24rem]">
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
            className="group flex w-full items-center justify-center gap-3 rounded-2xl border border-white/24 bg-white/10 px-5 py-4 text-base font-semibold text-white shadow-[0_20px_60px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-2xl transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-200/50 hover:bg-white/16 hover:shadow-[0_24px_70px_rgba(8,47,73,0.45),inset_0_1px_0_rgba(255,255,255,0.35)] focus:outline-none focus:ring-2 focus:ring-cyan-200/70 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg
              className="h-5 w-5 flex-none"
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
            <span>{isLoading ? 'Signing you in...' : 'Sign in with Microsoft'}</span>
            {!isLoading && (
              <ArrowRight className="h-4 w-4 flex-none opacity-70 transition-transform duration-200 group-hover:translate-x-1 group-hover:opacity-100" />
            )}
          </button>

          <p className="mt-3 text-center text-xs font-medium text-cyan-50/75 drop-shadow md:text-left">
            Secure access through Microsoft Entra ID
          </p>
        </div>
      </section>
    </main>
  );
}
