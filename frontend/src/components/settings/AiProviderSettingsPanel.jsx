import { useCallback, useEffect, useState } from 'react';
import { Bot, Loader2, Save, Zap } from 'lucide-react';
import { aiProviderAPI } from '../../services/api';
import { Button } from '../ui';
import { SettingsHero } from './SettingsLayoutPrimitives';

const AI_OPERATION_OPTIONS = [
  { value: 'assignment_pipeline', label: 'Assignment' },
  { value: 'competency_analysis', label: 'Competency' },
  { value: 'daily_review', label: 'Daily Review' },
  { value: 'daily_review_consolidation', label: 'Consolidation' },
  { value: 'ticket_reclassification', label: 'Reclassification' },
  { value: 'calendar_leave', label: 'Calendar Leave' },
  { value: 'autoresponse_classification', label: 'Auto-response Classify' },
  { value: 'autoresponse_generation', label: 'Auto-response Generate' },
  { value: 'notification_workflow_generation', label: 'Mail Workflow Generation' },
];

function ConfigToggle({ label, description, checked, onChange }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
      />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

export default function AiProviderSettingsPanel({ defaultOperation = 'notification_workflow_generation', onAssignmentModelChange = null }) {
  const [models, setModels] = useState([]);
  const [settings, setSettings] = useState([]);
  const [health, setHealth] = useState({});
  const [operation, setOperation] = useState(defaultOperation);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const loadHealth = useCallback(async (op = operation) => {
    try {
      const res = await aiProviderAPI.getHealth({ operation: op });
      setHealth(res?.data || {});
    } catch {
      setHealth({});
    }
  }, [operation]);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const [modelRes, settingsRes] = await Promise.all([
        aiProviderAPI.getModels(),
        aiProviderAPI.getSettings(),
      ]);
      setModels(modelRes?.data?.models || []);
      setSettings(settingsRes?.data || []);
      await loadHealth(operation);
    } finally {
      setLoading(false);
    }
  }, [loadHealth, operation]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  useEffect(() => {
    loadHealth(operation);
    const timer = setInterval(() => loadHealth(operation), 30000);
    return () => clearInterval(timer);
  }, [loadHealth, operation]);

  const selected = settings.find((row) => row.operation === operation) || {
    operation,
    primaryProvider: 'anthropic',
    primaryModel: 'claude-sonnet-4-6',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-5.5',
    autoFallbackEnabled: true,
    fallbackMode: 'retry_safe_checkpoint',
  };

  const modelOptions = (provider) => models.filter((model) => (
    model.provider === provider && model.operations?.includes(operation)
  ));

  const updateSelected = (patch) => {
    const next = { ...selected, ...patch };
    setSettings((current) => {
      const index = current.findIndex((row) => row.operation === operation);
      if (index === -1) return [...current, next];
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  };

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await aiProviderAPI.updateSettings([selected]);
      const saved = res?.data?.[0] || selected;
      setSettings((current) => current.map((row) => (row.operation === saved.operation ? saved : row)));
      if (saved.operation === 'assignment_pipeline') onAssignmentModelChange?.(saved.primaryModel);
      setTestResult({ ok: true, message: 'Provider setting saved.' });
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Save failed.' });
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider, model) => {
    setTestingProvider(provider);
    setTestResult(null);
    try {
      const res = await aiProviderAPI.testProvider({ operation, provider, model });
      setTestResult({
        ok: true,
        message: `${provider} responded in ${res?.data?.durationMs ?? 0} ms.`,
      });
      await loadHealth(operation);
    } catch (error) {
      setTestResult({ ok: false, message: error.message || `${provider} test failed.` });
      await loadHealth(operation);
    } finally {
      setTestingProvider(null);
    }
  };

  const providerButton = (field, provider) => {
    const checked = selected[field] === provider;
    return (
      <button
        type="button"
        onClick={() => {
          const firstModel = modelOptions(provider)[0]?.model || (provider === 'openai' ? 'gpt-5.5' : 'claude-sonnet-4-6');
          updateSelected({ [field]: provider, [field === 'primaryProvider' ? 'primaryModel' : 'fallbackModel']: firstModel });
        }}
        className={`px-3 py-1.5 text-xs font-semibold border transition-colors ${checked ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
      >
        {provider === 'openai' ? 'OpenAI' : 'Anthropic'}
      </button>
    );
  };

  const healthPill = (provider) => {
    const status = health?.[provider]?.status || 'unknown';
    const styles = {
      healthy: 'bg-green-50 text-green-700 border-green-200',
      degraded: 'bg-yellow-50 text-yellow-700 border-yellow-200',
      down: 'bg-red-50 text-red-700 border-red-200',
      unknown: 'bg-slate-50 text-slate-600 border-slate-200',
    };
    return (
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[status] || styles.unknown}`}>
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="tp-glass flex items-center gap-2 rounded-2xl border border-white/70 p-5 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading provider settings...
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-5">
      <SettingsHero
        eyebrow="Provider routing"
        title="AI Providers"
        description="Workspace-scoped model and fallback routing for assignment, review, auto-response, calendar, and mail workflow operations."
        icon={Bot}
        tone="purple"
      />
      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-800">Operation</label>
        <select
          value={operation}
          onChange={(event) => setOperation(event.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          {AI_OPERATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-800">Primary</h4>
            {healthPill(selected.primaryProvider)}
          </div>
          <div className="inline-flex overflow-hidden rounded-lg">
            {providerButton('primaryProvider', 'anthropic')}
            {providerButton('primaryProvider', 'openai')}
          </div>
          <select
            value={selected.primaryModel || ''}
            onChange={(event) => updateSelected({ primaryModel: event.target.value })}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            {modelOptions(selected.primaryProvider).map((model) => (
              <option key={model.model} value={model.model}>{model.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => test(selected.primaryProvider, selected.primaryModel)}
            disabled={testingProvider === selected.primaryProvider}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {testingProvider === selected.primaryProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Test
          </button>
        </div>

        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-800">Fallback</h4>
            {healthPill(selected.fallbackProvider)}
          </div>
          <div className="inline-flex overflow-hidden rounded-lg">
            {providerButton('fallbackProvider', 'anthropic')}
            {providerButton('fallbackProvider', 'openai')}
          </div>
          <select
            value={selected.fallbackModel || ''}
            onChange={(event) => updateSelected({ fallbackModel: event.target.value })}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            {modelOptions(selected.fallbackProvider).map((model) => (
              <option key={model.model} value={model.model}>{model.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => test(selected.fallbackProvider, selected.fallbackModel)}
            disabled={testingProvider === selected.fallbackProvider}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {testingProvider === selected.fallbackProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Test
          </button>
        </div>
      </div>

      <ConfigToggle
        label="Automatic fallback"
        description="Retry through the alternate provider when the primary provider has a retryable outage, auth, config, rate-limit, or timeout failure."
        checked={selected.autoFallbackEnabled !== false}
        onChange={() => updateSelected({ autoFallbackEnabled: selected.autoFallbackEnabled === false })}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Provider API keys are configured server-side through environment variables or Key Vault.</p>
        <Button
          type="button"
          onClick={save}
          disabled={saving}
          variant="dark"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Provider
        </Button>
      </div>
      {testResult && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${testResult.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}
