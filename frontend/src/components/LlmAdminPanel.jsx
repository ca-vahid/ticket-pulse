import { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  Save, 
  RotateCcw, 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  Code,
  FileText,
  Clock,
  Filter,
  History,
  Upload,
  Maximize2,
  SlidersHorizontal,
  Plus,
  Trash2,
  Info,
} from 'lucide-react';
import PromptEditorModal from './PromptEditorModal';
import ConfirmationModal from './ConfirmationModal';

const compareFields = [
  'classificationPrompt',
  'responsePrompt',
  'signatureBlock',
  'fallbackMessage',
  'tonePresets',
  'baseResponseMinutes',
  'perTicketDelayMinutes',
  'afterHoursMessage',
  'holidayMessage',
  'overrideRules',
  'domainWhitelist',
  'domainBlacklist',
  'model',
  'reasoningEffort',
  'verbosity',
  'maxOutputTokens',
];

const normalizeValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeValue(value[key]);
        return acc;
      }, {});
  }
  return value ?? null;
};

const computeHasUnpublishedChanges = (draft, published) => {
  if (!draft) return false;
  if (!published) return true;

  const buildComparable = (cfg) => {
    return compareFields.reduce((acc, field) => {
      acc[field] = normalizeValue(cfg?.[field]);
      return acc;
    }, {});
  };

  const draftFields = buildComparable(draft);
  const publishedFields = buildComparable(published);

  return JSON.stringify(draftFields) !== JSON.stringify(publishedFields);
};

// Toast Component
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-6 right-6 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border transition-all transform animate-slideInLeft z-50 ${
      type === 'success' 
        ? 'bg-white border-green-200 text-green-800' 
        : 'bg-white border-red-200 text-red-800'
    }`}>
      {type === 'success' ? <CheckCircle className="w-5 h-5 text-green-500" /> : <XCircle className="w-5 h-5 text-red-500" />}
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="ml-2 text-gray-400 hover:text-gray-600">
        <XCircle className="w-4 h-4" />
      </button>
    </div>
  );
};

export default function LlmAdminPanel() {
  const [activeTab, setActiveTab] = useState('prompts');
  const [config, setConfig] = useState(null);
  const [publishedConfig, setPublishedConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(true);
  
  // Confirmation Modal State
  const [confirmation, setConfirmation] = useState({ 
    isOpen: false, 
    type: null, 
    title: '', 
    message: '', 
    isDangerous: false, 
  });

  const tabs = [
    { id: 'prompts', label: 'Prompts', icon: Code },
    { id: 'templates', label: 'Templates', icon: FileText },
    { id: 'eta', label: 'ETA Rules', icon: Clock },
    { id: 'overrides', label: 'Overrides', icon: Filter },
    { id: 'runtime', label: 'Runtime', icon: SlidersHorizontal },
    { id: 'history', label: 'History', icon: History },
  ];

  useEffect(() => {
    fetchConfigs();
    fetchDefaults();
  }, []);

  const fetchConfigs = async () => {
    setIsLoading(true);
    try {
      const [draftResponse, publishedResponse] = await Promise.all([
        axios.get('/api/admin/llm-settings/config?type=draft'),
        axios.get('/api/admin/llm-settings/config?type=published'),
      ]);

      const draftConfig = draftResponse.data.data;
      const published = publishedResponse.data.data;

      setConfig(draftConfig);
      setPublishedConfig(published);
      
      const hasChanges = computeHasUnpublishedChanges(draftConfig, published);
      console.log('Draft config version:', draftConfig?.version, 'Published version:', published?.version);
      console.log('Has unpublished changes:', hasChanges);
      setHasUnpublishedChanges(hasChanges);
    } catch (error) {
      console.error('Failed to fetch config:', error);
      setToast({ type: 'error', message: 'Failed to load configuration' });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDefaults = async () => {
    try {
      const response = await axios.get('/api/admin/llm-settings/defaults');
      setDefaults(response.data.data);
    } catch (error) {
      console.error('Failed to fetch defaults:', error);
    }
  };

  const handleSave = async (section, data) => {
    setIsSaving(true);
    setToast(null);

    try {
      await axios.put(`/api/admin/llm-settings/${section}`, data);
      setToast({ type: 'success', message: 'Settings saved successfully' });
      fetchConfigs();
    } catch (error) {
      setToast({ 
        type: 'error', 
        message: error.response?.data?.message || 'Failed to save settings',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublishClick = () => {
    setConfirmation({
      isOpen: true,
      type: 'publish',
      title: 'Publish Configuration',
      message: 'Are you sure you want to publish the current draft? This will make it active for all auto-responses.',
      isDangerous: false,
    });
  };

  const handleResetClick = () => {
    setConfirmation({
      isOpen: true,
      type: 'reset',
      title: 'Reset Configuration',
      message: 'Are you sure you want to reset to default configuration? This will discard all your changes.',
      isDangerous: true,
    });
  };

  const handleConfirmAction = async () => {
    if (confirmation.type === 'publish') {
      await performPublish();
    } else if (confirmation.type === 'reset') {
      await performReset();
    }
  };

  const performPublish = async () => {
    setIsSaving(true);
    setToast(null);

    try {
      await axios.post('/api/admin/llm-settings/publish', {
        notes: `Published from UI on ${new Date().toLocaleString()}`,
      });
      setToast({ type: 'success', message: 'Configuration published successfully' });
      fetchConfigs();
    } catch (error) {
      setToast({ 
        type: 'error', 
        message: error.response?.data?.message || 'Failed to publish',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const performReset = async () => {
    setIsSaving(true);
    setToast(null);

    try {
      await axios.post('/api/admin/llm-settings/reset');
      setToast({ type: 'success', message: 'Configuration reset to defaults' });
      fetchConfigs();
    } catch (error) {
      setToast({ 
        type: 'error', 
        message: error.response?.data?.message || 'Failed to reset',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200 flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="text-gray-600">Loading LLM configuration...</p>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
        <div className="flex items-center gap-2 text-red-600 mb-2">
          <AlertCircle className="w-5 h-5" />
          <h3 className="font-semibold">Failed to load configuration</h3>
        </div>
        <button 
          onClick={fetchConfigs}
          className="text-sm text-blue-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-bold text-gray-900">LLM Configuration</h2>
          <div className="flex items-center gap-2">
            {hasUnpublishedChanges ? (
              <span className="px-2.5 py-0.5 bg-yellow-100 text-yellow-800 text-xs font-medium rounded-full border border-yellow-200">
                Draft Changes
              </span>
            ) : (
              <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full border border-green-200">
                Published
              </span>
            )}
            {publishedConfig && (
              <span className="px-2.5 py-0.5 bg-gray-100 text-gray-600 text-xs font-medium rounded-full border border-gray-200">
                v{publishedConfig.version}
              </span>
            )}
          </div>
        </div>
        
        <div className="flex gap-3">
          <button
            onClick={handleResetClick}
            disabled={isSaving}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
          <button
            onClick={handlePublishClick}
            disabled={isSaving || !hasUnpublishedChanges}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow"
          >
            <Upload className="w-4 h-4" />
            Publish Changes
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6 flex-shrink-0">
        <div className="flex gap-6 overflow-x-auto">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 py-4 border-b-2 text-sm font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {activeTab === 'prompts' && (
            <PromptsTab config={config} onSave={handleSave} isSaving={isSaving} defaults={defaults} />
          )}
          {activeTab === 'templates' && (
            <TemplatesTab config={config} onSave={handleSave} isSaving={isSaving} defaults={defaults} />
          )}
          {activeTab === 'eta' && (
            <EtaRulesTab config={config} onSave={handleSave} isSaving={isSaving} defaults={defaults} />
          )}
          {activeTab === 'overrides' && (
            <OverridesTab config={config} onSave={handleSave} isSaving={isSaving} />
          )}
          {activeTab === 'runtime' && (
            <RuntimeTab config={config} onSave={handleSave} isSaving={isSaving} />
          )}
          {activeTab === 'history' && (
            <HistoryTab config={config} onRevert={fetchConfigs} />
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <Toast 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(null)} 
        />
      )}

      <ConfirmationModal
        isOpen={confirmation.isOpen}
        onClose={() => setConfirmation({ ...confirmation, isOpen: false })}
        onConfirm={handleConfirmAction}
        title={confirmation.title}
        message={confirmation.message}
        isDangerous={confirmation.isDangerous}
      />
    </div>
  );
}

// Prompts Tab Component
function PromptsTab({ config, onSave, isSaving, defaults }) {
  const [classificationPrompt, setClassificationPrompt] = useState(config.classificationPrompt || '');
  const [responsePrompt, setResponsePrompt] = useState(config.responsePrompt || '');
  const [editingModal, setEditingModal] = useState(null);

  // Update local state when config changes from parent
  useEffect(() => {
    setClassificationPrompt(config.classificationPrompt || '');
    setResponsePrompt(config.responsePrompt || '');
  }, [config]);

  // Check if there are unsaved changes
  const hasUnsavedChanges = 
    classificationPrompt !== (config.classificationPrompt || '') ||
    responsePrompt !== (config.responsePrompt || '');

  const handleSave = () => {
    onSave('prompts', { classificationPrompt, responsePrompt });
  };

  // Extract JSON field names from classification prompt
  const extractJsonFieldsFromPrompt = (prompt) => {
    const fields = new Set();
    
    // Match patterns like: "fieldName": or 1. "fieldName": or - "fieldName":
    const patterns = [
      /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g,  // "fieldName":
      /\d+\.\s+"([a-zA-Z_][a-zA-Z0-9_]*)"/g,  // 1. "fieldName"
    ];
    
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        fields.add(match[1]);
      }
    });
    
    return Array.from(fields);
  };

  // Dynamic placeholders for response prompt based on classification output
  const classificationOutputFields = extractJsonFieldsFromPrompt(classificationPrompt);
  
  const placeholders = {
    classification: ['senderName', 'senderEmail', 'subject', 'body'],
    response: [
      // Email metadata (always available)
      'senderName', 
      'senderEmail', 
      'subject',
      // Classification outputs (dynamic)
      ...classificationOutputFields,
      // System-provided context
      'context', 
      'instructions',
    ],
  };

  const PromptCard = ({ title, value, onEdit, placeholders }) => (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h4 className="font-semibold text-gray-900">{title}</h4>
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 text-xs font-medium bg-white border border-gray-200 text-gray-700 hover:text-blue-600 hover:border-blue-200 px-3 py-1.5 rounded-lg transition-all shadow-sm"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Open Editor
        </button>
      </div>
      <div className="p-5">
        <div className="bg-gray-900 rounded-lg p-4 max-h-48 overflow-y-auto custom-scrollbar group relative">
          <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap leading-relaxed">
            {value.substring(0, 500)}
            {value.length > 500 && <span className="text-gray-500">... (more)</span>}
          </pre>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-gray-900/10 pointer-events-none" />
        </div>
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wider">Available Variables</p>
          <div className="flex flex-wrap gap-2">
            {placeholders.map(p => (
              <code key={p} className="bg-blue-50 text-blue-700 px-2 py-1 rounded-md text-xs font-mono border border-blue-100">
                {`{{${p}}}`}
              </code>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {hasUnsavedChanges && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-amber-800">Unsaved Changes</h4>
            <p className="text-xs text-amber-700 mt-0.5">
              You have unsaved changes to your prompts. Click &quot;Save Prompts&quot; below to persist them.
            </p>
          </div>
        </div>
      )}

      <PromptCard 
        title="Classification Prompt" 
        value={classificationPrompt} 
        onEdit={() => setEditingModal('classification')}
        placeholders={placeholders.classification}
      />

      <PromptCard 
        title="Response Generation Prompt" 
        value={responsePrompt} 
        onEdit={() => setEditingModal('response')}
        placeholders={placeholders.response}
      />

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={isSaving || !hasUnsavedChanges}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : hasUnsavedChanges ? 'Save Prompts' : 'No Changes'}
        </button>
      </div>

      <PromptEditorModal
        isOpen={editingModal === 'classification'}
        onClose={() => setEditingModal(null)}
        title="Edit Classification Prompt"
        value={classificationPrompt}
        onChange={setClassificationPrompt}
        placeholders={placeholders.classification}
        defaultValue={defaults?.classificationPrompt || ''}
      />

      <PromptEditorModal
        isOpen={editingModal === 'response'}
        onClose={() => setEditingModal(null)}
        title="Edit Response Generation Prompt"
        value={responsePrompt}
        onChange={setResponsePrompt}
        placeholders={placeholders.response}
        defaultValue={defaults?.responsePrompt || ''}
      />
    </div>
  );
}

// Templates Tab Component
function TemplatesTab({ config, onSave, isSaving, defaults }) {
  const [signatureBlock, setSignatureBlock] = useState(config.signatureBlock || '');
  const [fallbackMessage, setFallbackMessage] = useState(config.fallbackMessage || '');
  const [tonePresets, setTonePresets] = useState(
    JSON.parse(JSON.stringify(config.tonePresets || defaults?.tonePresets || {})),
  );
  const [newPresetKey, setNewPresetKey] = useState('');
  const [isAddingPreset, setIsAddingPreset] = useState(false);

  useEffect(() => {
    setSignatureBlock(config.signatureBlock || '');
    setFallbackMessage(config.fallbackMessage || '');
    setTonePresets(JSON.parse(JSON.stringify(config.tonePresets || defaults?.tonePresets || {})));
  }, [config, defaults]);

  const handlePresetChange = (presetKey, field, value) => {
    setTonePresets(prev => ({
      ...prev,
      [presetKey]: {
        ...prev[presetKey],
        [field]: value,
      },
    }));
  };

  const handlePresetReset = (presetKey) => {
    const defaultPreset = defaults?.tonePresets?.[presetKey];
    if (!defaultPreset) return;
    setTonePresets(prev => ({
      ...prev,
      [presetKey]: { ...defaultPreset },
    }));
  };

  const handleDeletePreset = (presetKey) => {
    if (!confirm(`Delete preset "${presetKey}"?`)) return;
    setTonePresets(prev => {
      const next = { ...prev };
      delete next[presetKey];
      return next;
    });
  };

  const handleAddPreset = () => {
    if (!newPresetKey.trim()) return;
    const key = newPresetKey.trim().toLowerCase().replace(/\s+/g, '_');
    if (tonePresets[key]) {
      alert('Preset already exists!');
      return;
    }
    setTonePresets(prev => ({
      ...prev,
      [key]: { tone: '', instructions: '' },
    }));
    setNewPresetKey('');
    setIsAddingPreset(false);
  };

  const handleSave = () => {
    onSave('templates', { signatureBlock, fallbackMessage, tonePresets });
  };

  const formatPresetLabel = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Signature Block */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5">
          <label className="block text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            Email Signature
            <Info className="w-4 h-4 text-gray-400" />
          </label>
          <textarea
            value={signatureBlock}
            onChange={(e) => setSignatureBlock(e.target.value)}
            rows={5}
            placeholder="Best regards,&#10;IT Support Team"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono transition-all"
          />
          <p className="text-xs text-gray-500 mt-2">
            Appended to all auto-response emails
          </p>
        </div>

        {/* Fallback Message */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5">
          <label className="block text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            Fallback Message
            <span className="text-xs font-normal text-gray-500">(when LLM fails)</span>
          </label>
          <textarea
            value={fallbackMessage}
            onChange={(e) => setFallbackMessage(e.target.value)}
            rows={5}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono transition-all"
          />
          <p className="text-xs text-gray-500 mt-2">
            Used when OpenAI API is unavailable or errors occur
          </p>
        </div>
      </div>

      {/* Tone Presets */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h4 className="text-base font-semibold text-gray-900">Tone Presets & Instructions</h4>
            <p className="text-sm text-gray-500 mt-1">
              Customize the directions passed to GPT-5.1 for each classification type.
            </p>
          </div>
          <button
            onClick={() => setIsAddingPreset(true)}
            className="flex items-center gap-1.5 text-sm bg-blue-50 text-blue-600 hover:bg-blue-100 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Preset
          </button>
        </div>

        {isAddingPreset && (
          <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-xl flex items-center gap-3 animate-fadeIn">
            <input
              type="text"
              value={newPresetKey}
              onChange={(e) => setNewPresetKey(e.target.value)}
              placeholder="e.g. urgent_request"
              className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              autoFocus
            />
            <button
              onClick={handleAddPreset}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add
            </button>
            <button
              onClick={() => setIsAddingPreset(false)}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        <div className="space-y-4">
          {Object.keys(tonePresets || {}).length === 0 && (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
              <p className="text-gray-500 text-sm">No tone presets found. Add one to get started.</p>
            </div>
          )}

          {Object.entries(tonePresets || {}).map(([key, preset]) => (
            <div key={key} className="border border-gray-200 rounded-xl p-5 hover:border-blue-300 hover:shadow-sm transition-all bg-white">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-semibold text-xs">
                    {key.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {formatPresetLabel(key)}
                    </p>
                    <p className="text-xs text-gray-500 font-mono">
                      source_type: {key}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handlePresetReset(key)}
                    className="text-xs text-gray-500 hover:text-gray-700 font-medium px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    Reset Default
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(key)}
                    className="text-gray-400 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                <div className="md:col-span-4">
                  <label className="block text-xs font-medium text-gray-700 mb-1.5 uppercase tracking-wide">
                    Tone Label
                  </label>
                  <input
                    type="text"
                    value={preset?.tone || ''}
                    onChange={(e) => handlePresetChange(key, 'tone', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    placeholder="e.g. Warm and professional"
                  />
                </div>
                <div className="md:col-span-8">
                  <label className="block text-xs font-medium text-gray-700 mb-1.5 uppercase tracking-wide">
                    Instructions
                  </label>
                  <textarea
                    value={preset?.instructions || ''}
                    onChange={(e) => handlePresetChange(key, 'instructions', e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono"
                    placeholder="Instructions for the LLM..."
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm disabled:opacity-50 transition-all shadow-sm hover:shadow"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save Templates'}
        </button>
      </div>
    </div>
  );
}

// ETA Rules Tab Component
function EtaRulesTab({ config, onSave, isSaving, defaults: _defaults }) {
  const [baseResponseMinutes, setBaseResponseMinutes] = useState(config.baseResponseMinutes || 30);
  const [perTicketDelayMinutes, setPerTicketDelayMinutes] = useState(config.perTicketDelayMinutes || 10);
  const [afterHoursMessage, setAfterHoursMessage] = useState(config.afterHoursMessage || '');
  const [holidayMessage, setHolidayMessage] = useState(config.holidayMessage || '');

  const handleSave = () => {
    onSave('eta-rules', {
      baseResponseMinutes: baseResponseMinutes === '' ? 0 : parseInt(baseResponseMinutes),
      perTicketDelayMinutes: perTicketDelayMinutes === '' ? 0 : parseInt(perTicketDelayMinutes),
      afterHoursMessage,
      holidayMessage,
    });
  };

  const base = parseInt(baseResponseMinutes) || 0;
  const delay = parseInt(perTicketDelayMinutes) || 0;
  const exampleETA = base + (5 / 3) * delay;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <h4 className="text-base font-semibold text-gray-900 mb-6 flex items-center gap-2">
          <Clock className="w-5 h-5 text-blue-600" />
          ETA Calculation Logic
        </h4>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Base Response Time (minutes)
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={baseResponseMinutes}
                  onChange={(e) => setBaseResponseMinutes(e.target.value)}
                  min="5"
                  max="240"
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">min</span>
              </div>
              <p className="text-xs text-gray-500 mt-1.5">Minimum time to respond to a new ticket.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Per-Ticket Delay (minutes)
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={perTicketDelayMinutes}
                  onChange={(e) => setPerTicketDelayMinutes(e.target.value)}
                  min="1"
                  max="60"
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">min</span>
              </div>
              <p className="text-xs text-gray-500 mt-1.5">Added delay for each ticket currently in queue per agent.</p>
            </div>
          </div>

          <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-6 flex flex-col justify-center">
            <h5 className="text-sm font-semibold text-blue-900 mb-4">Live Preview</h5>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-blue-800">
                <span>Scenario:</span>
                <span className="font-medium">5 tickets, 3 agents</span>
              </div>
              <div className="h-px bg-blue-200"></div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-blue-800">Estimated Wait:</span>
                <span className="text-2xl font-bold text-blue-600">{Math.round(exampleETA)} min</span>
              </div>
              <p className="text-xs text-blue-600 mt-2 text-center">
                Formula: Base + (Tickets / Agents) × Delay
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <h4 className="text-base font-semibold text-gray-900 mb-6">Custom Messages</h4>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              After-Hours Message
            </label>
            <textarea
              value={afterHoursMessage}
              onChange={(e) => setAfterHoursMessage(e.target.value)}
              rows={3}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              placeholder="We are currently closed..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Holiday Message
            </label>
            <textarea
              value={holidayMessage}
              onChange={(e) => setHolidayMessage(e.target.value)}
              rows={3}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              placeholder="Happy Holidays! We will return on..."
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm disabled:opacity-50 transition-all shadow-sm hover:shadow"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save ETA Rules'}
        </button>
      </div>
    </div>
  );
}

// Overrides Tab Component
function OverridesTab({ config, onSave, isSaving }) {
  const [overrideRules] = useState(config.overrideRules || []);
  const [domainWhitelist, setDomainWhitelist] = useState((config.domainWhitelist || []).join('\n'));
  const [domainBlacklist, setDomainBlacklist] = useState((config.domainBlacklist || []).join('\n'));

  const handleSave = () => {
    onSave('overrides', {
      overrideRules,
      domainWhitelist: domainWhitelist.split('\n').filter(d => d.trim()),
      domainBlacklist: domainBlacklist.split('\n').filter(d => d.trim()),
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-amber-800">Warning: Override Rules Active</h4>
          <p className="text-sm text-amber-700 mt-1">
            These settings bypass the LLM classification entirely. Use with caution to avoid misclassifying legitimate tickets.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 flex flex-col h-full">
          <div className="mb-4">
            <label className="block text-sm font-semibold text-gray-900 mb-1">
              Domain Whitelist
            </label>
            <p className="text-xs text-gray-500">Always process emails from these domains.</p>
          </div>
          <textarea
            value={domainWhitelist}
            onChange={(e) => setDomainWhitelist(e.target.value)}
            className="flex-1 w-full px-4 py-3 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none"
            placeholder="example.com&#10;partner.org"
          />
        </div>

        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 flex flex-col h-full">
          <div className="mb-4">
            <label className="block text-sm font-semibold text-gray-900 mb-1">
              Domain Blacklist
            </label>
            <p className="text-xs text-gray-500">Automatically mark these as spam.</p>
          </div>
          <textarea
            value={domainBlacklist}
            onChange={(e) => setDomainBlacklist(e.target.value)}
            className="flex-1 w-full px-4 py-3 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none"
            placeholder="spam.com&#10;blocked.net"
          />
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm disabled:opacity-50 transition-all shadow-sm hover:shadow"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save Overrides'}
        </button>
      </div>
    </div>
  );
}

// Runtime Tab Component
function RuntimeTab({ config, onSave, isSaving }) {
  const [model, setModel] = useState(config.model || 'gpt-5.1');
  const [reasoningEffort, setReasoningEffort] = useState(config.reasoningEffort || 'none');
  const [verbosity, setVerbosity] = useState(config.verbosity || 'medium');
  const [maxOutputTokens, setMaxOutputTokens] = useState(config.maxOutputTokens || 800);

  useEffect(() => {
    setModel(config.model || 'gpt-5.1');
    setReasoningEffort(config.reasoningEffort || 'none');
    setVerbosity(config.verbosity || 'medium');
    setMaxOutputTokens(config.maxOutputTokens || 800);
  }, [config]);

  const handleSave = () => {
    onSave('runtime', {
      model,
      reasoningEffort,
      verbosity,
      maxOutputTokens: Number(maxOutputTokens),
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-blue-800">Model Configuration</h4>
          <p className="text-sm text-blue-700 mt-1">
            GPT-5.1 ignores temperature and top_p. Use reasoning effort, verbosity, and token limits to tune behavior.
          </p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Model Version</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white"
            >
              <option value="gpt-5.1">gpt-5.1 (Flagship)</option>
              <option value="gpt-5">gpt-5 (Legacy)</option>
              <option value="gpt-5-mini">gpt-5-mini (Faster, cheaper)</option>
              <option value="gpt-5-nano">gpt-5-nano (High throughput)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1.5">
              Choose which GPT-5 family variant to call for both classification and responses.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Reasoning Effort</label>
            <select
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white"
            >
              <option value="none">None (Fastest)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High (Slowest)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1.5">
              Higher effort allows the model to &quot;think&quot; longer before answering.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Verbosity Level</label>
            <select
              value={verbosity}
              onChange={(e) => setVerbosity(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white"
            >
              <option value="low">Low (Concise)</option>
              <option value="medium">Medium (Standard)</option>
              <option value="high">High (Detailed)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1.5">
              Controls the length and detail of the generated responses.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Max Output Tokens</label>
            <input
              type="number"
              min={100}
              max={4000}
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1.5">
              Hard limit on response length. Higher values cost more tokens.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm disabled:opacity-50 transition-all shadow-sm hover:shadow"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save Runtime Settings'}
        </button>
      </div>
    </div>
  );
}

// History Tab Component
function HistoryTab({ config: _config, onRevert }) {
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const response = await axios.get('/api/admin/llm-settings/history?limit=20');
      setHistory(response.data.data);
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevert = async (historyId) => {
    if (!confirm('Revert to this version? This will create a new draft from this historical configuration.')) {
      return;
    }

    try {
      await axios.post('/api/admin/llm-settings/revert', { historyId });
      alert('Reverted successfully!');
      onRevert();
    } catch (error) {
      alert('Failed to revert: ' + (error.response?.data?.message || error.message));
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-base font-semibold text-gray-900">Version History</h4>
        <span className="text-xs text-gray-500">Last 20 changes</span>
      </div>

      {history.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <History className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No history available yet.</p>
        </div>
      )}

      <div className="space-y-3">
        {history.map(record => (
          <div key={record.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-300 hover:shadow-sm transition-all group">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span className="font-bold text-sm text-gray-900">v{record.version}</span>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    record.action === 'publish' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                  }`}>
                    {record.action}
                  </span>
                  <span className="text-xs text-gray-400">•</span>
                  <span className="text-xs text-gray-500">
                    {new Date(record.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-gray-600">{record.changeNotes || 'No notes provided'}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Modified by {record.changedBy || 'System'}
                </p>
              </div>
              <button
                onClick={() => handleRevert(record.id)}
                className="opacity-0 group-hover:opacity-100 flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Revert
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
