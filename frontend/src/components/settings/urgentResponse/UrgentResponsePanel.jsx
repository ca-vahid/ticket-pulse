import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarClock, Route, ScrollText, ShieldAlert } from 'lucide-react';
import { urgentResponseAPI } from '../../../services/api';
import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { setUrgentResponseStatus } from '../../../hooks/useUrgentResponseStatus';
import LightTabBar from '../../common/LightTabBar';
import { ConfirmDialog } from '../../knowledge/knowledgeUi';
import { StatusDot } from '../../onboarding/onboardingUi';
import { StatusBanner } from '../SettingsLayoutPrimitives';
import UrgentEscalationPanel from '../UrgentEscalationPanel';
import RulesTab from './RulesTab';
import OnCallTab from './OnCallTab';
import LogTab from './LogTab';
import { MODES, MODE_INFO } from './urgentResponseFormat';

/**
 * Settings → Urgent Response (plans/URGENT_RESPONSE_PLAN.md): an Urgent
 * ticket always has an owner who is at work, and somebody touches it within
 * N minutes. Four tabs — Rules, On-call, Log and the older Requester
 * escalation settings — under one mode (Off / Shadow / Live).
 *
 * The mode is saved the moment it is picked (Live asks first); each tab saves
 * its own fields. A tab stays mounted once opened, so an unsaved draft
 * survives a look at another tab.
 */

const TABS = [
  { id: 'rules', label: 'Rules', icon: Route },
  { id: 'oncall', label: 'On-call', icon: CalendarClock },
  { id: 'log', label: 'Log', icon: ScrollText },
  { id: 'escalation', label: 'Requester escalation', icon: ShieldAlert },
];
const tabOrDefault = (id) => (TABS.some((t) => t.id === id) ? id : 'rules');

function ModeControl({ mode, onPick, disabled }) {
  return (
    <fieldset className="w-full min-w-0 lg:w-auto lg:max-w-[42rem]" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Mode for this workspace</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => (
          <label key={m} className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${mode === m ? 'border-primary bg-primary/[0.05] dark:bg-primary/10' : 'border-border hover:bg-muted/50'}`}>
            <input type="radio" name="urgent-response-mode" value={m} checked={mode === m} onChange={() => onPick(m)} className="mt-0.5 accent-[hsl(var(--primary))]" />
            <span>
              <StatusDot tone={MODE_INFO[m].tone} label={MODE_INFO[m].label} className="text-sm font-medium" />
              <span className="mt-0.5 block text-xs text-muted-foreground">{MODE_INFO[m].hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The order is only a suggestion (from the old escalation settings) until it is saved. */
const isSuggested = (d) => d?.onCallOrderSuggested === true || d?.settings?.onCallOrderSuggested === true;

export default function UrgentResponsePanel({ initialTab = 'rules', previewDelayMs = 600 }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id || null;
  const [tab, setTab] = useState(() => tabOrDefault(initialTab));
  const [opened, setOpened] = useState(() => new Set([tabOrDefault(initialTab)]));
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [onCall, setOnCall] = useState(null);
  const [onCallError, setOnCallError] = useState(null);
  const [changesKey, setChangesKey] = useState(0);
  const [askLive, setAskLive] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeStatus, setModeStatus] = useState(null);
  const dataRef = useRef(null);
  dataRef.current = data;

  const selectTab = useCallback((id) => {
    const next = tabOrDefault(id);
    setTab(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  }, []);
  // An old #urgent-escalation link followed while the panel is already open.
  useEffect(() => { selectTab(initialTab); }, [initialTab, selectTab]);

  const loadSettings = useCallback(() => {
    setLoadError(null);
    return urgentResponseAPI.getSettings()
      .then((res) => setData(res?.data || null))
      .catch((err) => setLoadError(err?.message || 'Could not load the urgent response settings'));
  }, []);
  // The schedule also carries the time zone, for a server that does not send it with the settings.
  const loadOnCall = useCallback(() => urgentResponseAPI.getOnCall()
    .then((res) => { setOnCall(res?.data || null); setOnCallError(null); })
    .catch((err) => setOnCallError(err?.message || 'Could not load the on-call schedule')), []);
  useEffect(() => { loadSettings(); loadOnCall(); }, [loadSettings, loadOnCall]);

  /** A tab saved: keep its answer, and let the Changes list reload. */
  const onSaved = useCallback((settings, { orderSaved = false } = {}) => {
    const d = dataRef.current;
    if (d) {
      const suggested = orderSaved ? false : isSuggested({ ...d, settings: { ...d.settings, onCallOrderSuggested: settings?.onCallOrderSuggested ?? d.settings?.onCallOrderSuggested } });
      const next = { ...d, settings: { ...d.settings, ...settings, onCallOrderSuggested: suggested }, onCallOrderSuggested: suggested };
      dataRef.current = next;
      setData(next);
      // The "On-call" nav entry follows the mode and the saved order without a reload.
      setUrgentResponseStatus(workspaceId, { mode: next.settings.mode || 'off', onCall: !suggested && (next.settings.onCallOrder || []).length > 0 });
    }
    setChangesKey((n) => n + 1);
  }, [workspaceId]);

  const mode = data?.settings?.mode || 'off';
  const saveMode = async (next) => {
    setAskLive(false);
    setModeSaving(true);
    setModeStatus(null);
    try {
      const res = await urgentResponseAPI.updateSettings({ mode: next });
      onSaved(res?.data?.settings || { mode: next });
      setModeStatus({ ok: true, text: `Mode is now ${MODE_INFO[next].label}.` });
    } catch (err) {
      setModeStatus({ ok: false, text: err?.message || 'Could not change the mode' });
    } finally {
      setModeSaving(false);
    }
  };
  const pickMode = (next) => {
    if (next === mode) return;
    if (next === 'live') setAskLive(true);
    else saveMode(next);
  };

  const technicians = useMemo(() => data?.technicians || [], [data?.technicians]);
  const techById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);
  const timezone = data?.timezone || onCall?.timezone || null;
  const orderSuggested = isSuggested(data);
  const newOrderInUse = (data?.settings?.onCallOrder || []).length > 0 && !orderSuggested;

  return (
    <div data-testid="urgent-response-panel">
      <div className="space-y-4 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-[14rem] flex-1">
            <h2 className="text-lg font-semibold text-foreground">Urgent response</h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              An urgent ticket always has an owner who is at work, and somebody touches it within a set time. Every step is a fixed rule, written to the Log, and can be undone.
            </p>
          </div>
          {data && <ModeControl mode={mode} onPick={pickMode} disabled={modeSaving} />}
        </div>
        {modeStatus && (
          <p role="status" className={`text-sm ${modeStatus.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{modeStatus.text}</p>
        )}

        <LightTabBar tabs={TABS} activeId={tab} onSelect={selectTab} ariaLabel="Urgent response" idPrefix="urgent" className="!mb-0" />
      </div>

      {TABS.filter((t) => opened.has(t.id)).map((t) => (
        <div key={t.id} role="tabpanel" id={`urgent-panel-${t.id}`} aria-labelledby={`urgent-tab-${t.id}`} hidden={tab !== t.id}>
          {t.id === 'escalation' ? (
            <UrgentEscalationPanel onCallOrderInUse={newOrderInUse} onOpenOnCall={() => selectTab('oncall')} />
          ) : (
            <div className="px-4 pb-8 pt-5 sm:px-6">
              {loadError && (
                <StatusBanner type="error">
                  {loadError}{' '}
                  <button type="button" onClick={loadSettings} className="tp-focus-ring rounded font-medium underline">Try again</button>
                </StatusBanner>
              )}
              {!data && !loadError && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
              )}
              {data && t.id === 'rules' && (
                <RulesTab
                  settings={data.settings}
                  technicians={technicians}
                  techById={techById}
                  teamsEnabled={data.teamsEnabled !== false}
                  onCall={onCall}
                  timezone={timezone}
                  changesKey={changesKey}
                  previewDelayMs={previewDelayMs}
                  onSaved={onSaved}
                  onOpenOnCall={() => selectTab('oncall')}
                />
              )}
              {data && t.id === 'oncall' && (
                <OnCallTab
                  settings={data.settings}
                  orderSuggested={orderSuggested}
                  timezone={timezone}
                  technicians={technicians}
                  techById={techById}
                  onCall={onCall}
                  onCallError={onCallError}
                  reloadOnCall={loadOnCall}
                  onSaved={onSaved}
                />
              )}
              {data && t.id === 'log' && <LogTab timezone={timezone} />}
            </div>
          )}
        </div>
      ))}

      <ConfirmDialog
        open={askLive}
        title="Switch urgent response to Live?"
        confirmLabel="Switch to Live"
        onConfirm={() => saveMode('live')}
        onCancel={() => setAskLive(false)}
        testId="urgent-live-confirm"
      >
        Tickets are redirected, moved and people are told. Until you switch back, this is real: nothing is only recorded any more.
      </ConfirmDialog>
    </div>
  );
}
