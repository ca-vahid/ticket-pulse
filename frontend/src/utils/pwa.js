/**
 * Installable app (12 Oct 2026). Registers the service worker and keeps hold
 * of the browser's install prompt, which fires once, early, before any menu
 * that could offer it has been opened.
 */
let deferredPrompt = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener error */ } });

export function isStandalone() {
  try {
    return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true);
  } catch { return false; }
}

/** iPhone / iPad Safari has no install prompt: the person uses Share, then Add to Home Screen. */
export function isIos() {
  const ua = window.navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1);
}

export function canPromptInstall() { return Boolean(deferredPrompt); }

export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const evt = deferredPrompt;
  deferredPrompt = null;
  emit();
  try {
    await evt.prompt();
    const choice = await evt.userChoice;
    return choice?.outcome || 'dismissed';
  } catch { return 'dismissed'; }
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; emit(); });
  if ('serviceWorker' in window.navigator) {
    window.addEventListener('load', () => {
      window.navigator.serviceWorker.register('/sw.js').catch(() => { /* not fatal: the site works without it */ });
    });
  }
}
