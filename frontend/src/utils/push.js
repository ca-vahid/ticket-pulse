import { agentAPI } from '../services/api';
import { isIos, isStandalone } from './pwa';

/**
 * Notifications on this device (web push, 12 Oct 2026).
 *
 * state: 'unsupported' | 'needs-install' (iPhone: only an installed app may
 * ask) | 'unconfigured' (server has no keys) | 'blocked' (the person said no
 * in the browser) | 'off' | 'on'
 */
const supported = () => typeof window !== 'undefined'
  && 'serviceWorker' in window.navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = window.atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const registration = async () => {
  const reg = await window.navigator.serviceWorker.getRegistration();
  return reg || window.navigator.serviceWorker.register('/sw.js');
};

export async function getPushState() {
  if (!supported()) return { state: isIos() && !isStandalone() ? 'needs-install' : 'unsupported', devices: [] };
  let server;
  try {
    const res = await agentAPI.getPush();
    server = res.data || res;
  } catch { return { state: 'unsupported', devices: [] }; }
  if (!server.configured) return { state: 'unconfigured', devices: [] };
  if (window.Notification.permission === 'denied') return { state: 'blocked', devices: server.devices || [] };
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  const mine = sub && (server.devices || []).some((d) => d.endpoint === sub.endpoint);
  return { state: mine ? 'on' : 'off', devices: server.devices || [], endpoint: sub?.endpoint || null, publicKey: server.publicKey };
}

/** Ask the browser, subscribe, and tell the server. Must run from a tap. */
export async function enablePush() {
  const res = await agentAPI.getPush();
  const server = res.data || res;
  if (!server.configured) throw new Error('Device notifications are not set up on the server yet.');
  const permission = await window.Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
  const reg = await registration();
  await window.navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(server.publicKey) });
  await agentAPI.subscribePush({ subscription: sub.toJSON() });
  return getPushState();
}

export async function disablePush() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await agentAPI.unsubscribePush({ endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => {});
  }
  return getPushState();
}

export const sendPushTest = () => agentAPI.sendPushTest();
