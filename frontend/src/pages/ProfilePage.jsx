import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, Bell, Camera, LayoutDashboard, Loader2, LogOut, RotateCcw, UserRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { settingsAPI } from '../services/api';
import PhotoUploadDialog from '../components/settings/PhotoUploadDialog';
import { PersonAvatar } from '../components/tickets/ticketUi';

/**
 * Profile page (QA 09-22 #7): who you are in this workspace and the photo the
 * app shows for you. Opened from the account menu's name block. Admins set
 * other people's photos from Settings → Members.
 */
export default function ProfilePage() {
  const { user, logout } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [profile, setProfile] = useState(null); // technician row or null
  const [state, setState] = useState('loading'); // loading | ready | none | error
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const canAccessDashboard = user?.role && user.role !== 'agent';
  const homeHref = canAccessDashboard ? '/dashboard' : '/my-competencies';

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await settingsAPI.myPhoto();
      setProfile(res?.data || null);
      setState('ready');
    } catch (err) {
      if (err?.response?.status === 404 || err?.status === 404) { setProfile(null); setState('none'); } else { setState('error'); }
    }
  }, []);
  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  const save = async (dataUrl) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await settingsAPI.uploadMyPhoto(dataUrl);
      setProfile(res?.data || profile);
      setDialogOpen(false);
      setNotice({ tone: 'ok', text: 'Photo saved. It shows on tickets, the dashboard and e-mails from now on.' });
    } catch (err) {
      setNotice({ tone: 'err', text: err.response?.data?.message || err.message || 'Could not save the photo' });
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await settingsAPI.revertMyPhoto();
      setProfile(res?.data || profile);
      setDialogOpen(false);
      setNotice({ tone: 'ok', text: 'Back to the directory photo.' });
    } catch (err) {
      setNotice({ tone: 'err', text: err.response?.data?.message || err.message || 'Could not revert the photo' });
    } finally {
      setBusy(false);
    }
  };

  const displayName = profile?.name || user?.name || user?.username || user?.email || 'You';
  const email = profile?.email || user?.email || '';
  const roleLabel = user?.role === 'admin' ? 'Administrator' : user?.role === 'readonly' ? 'Observer' : user?.role === 'agent' ? 'Agent' : user?.role || '';

  return (
    <div className="tp-app-backdrop min-h-screen bg-cover bg-fixed">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/brand/logo-wordmark.png" alt="Ticket Pulse" className="h-14 w-auto dark:hidden" />
            <img src="/brand/logo-mark.png" alt="Ticket Pulse" className="hidden h-9 w-9 object-contain dark:block" />
            <div className="hidden h-8 w-px bg-secondary sm:block" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">Profile</div>
              <div className="truncate text-xs text-muted-foreground">Your photo and details in {currentWorkspace?.name || 'this workspace'}.</div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <a
              href={homeHref}
              aria-label={canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-3 text-sm font-semibold text-blue-700 dark:text-blue-200 transition hover:bg-blue-100 dark:hover:bg-blue-500/25"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden sm:inline">{canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}</span>
              <span className="sm:hidden">Back</span>
            </a>
            <button
              type="button"
              onClick={() => logout()}
              className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground/85 transition hover:bg-muted"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-200 dark:shadow-none">
            <UserRound className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-foreground">Profile</h1>
            <p className="text-sm text-muted-foreground">The photo Ticket Pulse shows for you on tickets, the dashboard and in e-mails.</p>
          </div>
        </div>

        <section aria-label="Your photo" className="tp-card rounded-2xl p-5 sm:p-6">
          {state === 'loading' ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground/75"><Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /></div>
          ) : (
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <PersonAvatar name={displayName} photoUrl={profile?.photoUrl || null} size="h-24 w-24" textSize="text-2xl" />
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold text-foreground">{displayName}</h2>
                {email && <p className="text-sm text-muted-foreground">{email}</p>}
                <p className="mt-1 text-xs text-muted-foreground/75">
                  {[roleLabel, currentWorkspace?.name].filter(Boolean).join(' · ')}
                  {state === 'ready' && (
                    <> · Photo: {profile?.photoSource === 'custom' ? 'uploaded here' : profile?.photoUrl ? 'from the directory' : 'none yet'}</>
                  )}
                </p>
                {state === 'none' && (
                  <p className="mt-2 text-xs text-muted-foreground" role="note">
                    This account has no agent profile in {currentWorkspace?.name || 'this workspace'}, so there is no photo to set here — the app shows your initials.
                  </p>
                )}
                {state === 'error' && <p className="mt-2 text-xs text-destructive" role="alert">Could not load your profile. Try again in a moment.</p>}
                {notice && <p className={`mt-2 text-xs ${notice.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}`} role="status">{notice.text}</p>}
              </div>
              {state === 'ready' && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setDialogOpen(true)}
                    className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                  >
                    <Camera className="h-4 w-4" aria-hidden="true" /> {profile?.photoUrl ? 'Change photo' : 'Add a photo'}
                  </button>
                  {profile?.photoSource === 'custom' && (
                    <button
                      type="button"
                      onClick={revert}
                      disabled={busy}
                      className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" /> Use the directory photo
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <nav aria-label="Your settings" className="mt-4 grid gap-2.5 sm:grid-cols-2">
          <Link to="/notifications" className="tp-card tp-focus-ring flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-muted/50">
            <Bell className="h-5 w-5 text-primary" aria-hidden="true" />
            <span>
              <span className="block text-sm font-semibold text-foreground">Mail &amp; alerts</span>
              <span className="block text-xs text-muted-foreground">How you are notified, your alert rules, your e-mail signature.</span>
            </span>
          </Link>
          <Link to="/my-competencies" className="tp-card tp-focus-ring flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-muted/50">
            <Award className="h-5 w-5 text-primary" aria-hidden="true" />
            <span>
              <span className="block text-sm font-semibold text-foreground">My Skills</span>
              <span className="block text-xs text-muted-foreground">Your competencies, as the assignment AI sees them.</span>
            </span>
          </Link>
        </nav>
      </main>

      {dialogOpen && (
        <PhotoUploadDialog
          title="Your profile photo"
          initialPhotoUrl={profile?.photoUrl || null}
          canRevert={profile?.photoSource === 'custom'}
          busy={busy}
          onSave={save}
          onRevert={revert}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}
