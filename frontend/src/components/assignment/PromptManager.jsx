import { useState, useEffect, useCallback } from 'react';
import { assignmentAPI } from '../../services/api';
import {
  Save, Upload, RotateCcw, Clock, Loader2, Eye, FileText, CheckCircle,
  Wrench, ChevronDown, ChevronRight, Trash2,
} from 'lucide-react';
import { formatDateOnlyInTimezone } from '../../utils/dateHelpers';

function ToolListPanel() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const res = await assignmentAPI.getTools();
        setTools(res?.data || []);
      } catch {
        setTools([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));

  if (loading) {
    return <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-blue-600" /></div>;
  }

  const TOOL_TYPES = {
    custom: 'bg-blue-100 text-blue-700',
    web_search_20250305: 'bg-purple-100 text-purple-700',
  };

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
        <Wrench className="w-4 h-4" /> Available Tools ({tools.length})
      </h4>
      <p className="text-xs text-gray-400 mb-3">
        These tools are passed to Claude alongside the system prompt. Claude decides which to call during analysis.
      </p>
      <div className="space-y-1">
        {tools.map((tool) => (
          <div key={tool.name} className="border rounded-lg bg-white overflow-hidden">
            <button
              onClick={() => toggle(tool.name)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
            >
              {expanded[tool.name]
                ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
              <code className="text-xs font-semibold text-blue-700">{tool.name}</code>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TOOL_TYPES[tool.type] || TOOL_TYPES.custom}`}>
                {tool.type === 'custom' ? 'custom' : 'server'}
              </span>
              <span className="text-xs text-gray-400 truncate flex-1">{tool.description.slice(0, 80)}{tool.description.length > 80 ? '...' : ''}</span>
            </button>
            {expanded[tool.name] && (
              <div className="px-3 pb-3 border-t bg-gray-50">
                <p className="text-xs text-gray-600 mt-2 mb-2">{tool.description}</p>
                {Object.keys(tool.parameters).length > 0 && (
                  <div>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Parameters</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(tool.parameters).map(([key, val]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <code className="font-mono text-blue-600 flex-shrink-0">{key}</code>
                          {tool.required.includes(key) && (
                            <span className="text-[9px] bg-red-100 text-red-600 px-1 rounded font-medium">required</span>
                          )}
                          <span className="text-gray-400">{val.type}{val.enum ? ` (${val.enum.join(' | ')})` : ''}</span>
                          {val.description && <span className="text-gray-500">— {val.description}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(tool.parameters).length === 0 && (
                  <p className="text-xs text-gray-400 italic">No parameters — called without arguments.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PromptManager({ workspaceTimezone = 'America/Los_Angeles' }) {
  const [versions, setVersions] = useState([]);
  const [published, setPublished] = useState(null);
  const [editText, setEditText] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getPrompts();
      const data = res?.data || {};
      setVersions(data.versions || []);
      setPublished(data.published || null);
      if (data.published?.systemPrompt && !editText) {
        setEditText(data.published.systemPrompt);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSaveDraft = async () => {
    if (!editText.trim()) return;
    try {
      setSaving(true);
      setSaveMsg(null);
      await assignmentAPI.createPrompt({ systemPrompt: editText, notes: notes || null });
      setSaveMsg('Draft saved');
      setNotes('');
      await fetchData();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async (id) => {
    try {
      setPublishing(true);
      await assignmentAPI.publishPrompt(id);
      setSaveMsg('Published successfully');
      await fetchData();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const handleRestore = async (id) => {
    try {
      const res = await assignmentAPI.restorePrompt(id);
      const draft = res?.data;
      if (draft?.systemPrompt) setEditText(draft.systemPrompt);
      setSaveMsg('Restored as new draft');
      await fetchData();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this prompt version? This cannot be undone.')) return;
    try {
      await assignmentAPI.deletePrompt(id);
      setSaveMsg('Version deleted');
      await fetchData();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const handleViewVersion = async (id) => {
    if (selectedVersion?.id === id) {
      setSelectedVersion(null);
      return;
    }
    try {
      const res = await assignmentAPI.getPrompt(id);
      setSelectedVersion(res?.data || null);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadVersionToEditor = (prompt) => {
    setEditText(prompt);
    setSelectedVersion(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const STATUS_BADGES = {
    published: 'bg-green-100 text-green-800',
    draft: 'bg-yellow-100 text-yellow-800',
    archived: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Tool List */}
      <ToolListPanel />

      {/* Editor */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <FileText className="w-4 h-4" /> System Prompt
          </h4>
          {published && (
            <span className="text-xs text-gray-400">
              Currently published: v{published.version}
            </span>
          )}
        </div>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          className="w-full border rounded-lg p-3 text-sm font-mono resize-y min-h-[300px] bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-200 transition-colors"
          placeholder="Enter your system prompt here..."
        />
        <div className="flex items-center gap-2 mt-2">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Version notes (optional)"
            className="flex-1 border rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={handleSaveDraft}
            disabled={saving || !editText.trim()}
            className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Draft
          </button>
        </div>
        {saveMsg && (
          <p className="text-sm text-green-600 mt-2 flex items-center gap-1">
            <CheckCircle className="w-4 h-4" /> {saveMsg}
          </p>
        )}
      </div>

      {/* Version History */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
          <Clock className="w-4 h-4" /> Version History
        </h4>
        {versions.length === 0 ? (
          <p className="text-gray-400 text-sm">No versions yet. Save a draft to create the first version.</p>
        ) : (
          <div className="space-y-1.5">
            {versions.map((v) => (
              <div key={v.id}>
                <div className="flex items-center justify-between bg-white border rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-sm font-mono font-medium text-gray-700">v{v.version}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_BADGES[v.status] || ''}`}>
                      {v.status}
                    </span>
                    {v.notes && <span className="text-xs text-gray-400 truncate">{v.notes}</span>}
                    <span className="text-xs text-gray-300">{formatDateOnlyInTimezone(v.createdAt, workspaceTimezone)}</span>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleViewVersion(v.id)}
                      className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                      title="View"
                    >
                      <Eye className="w-3.5 h-3.5 text-gray-500" />
                    </button>
                    {v.status !== 'published' && (
                      <button
                        onClick={() => handlePublish(v.id)}
                        disabled={publishing}
                        className="p-1.5 hover:bg-green-50 rounded transition-colors"
                        title="Publish"
                      >
                        <Upload className="w-3.5 h-3.5 text-green-600" />
                      </button>
                    )}
                    <button
                      onClick={() => handleRestore(v.id)}
                      className="p-1.5 hover:bg-blue-50 rounded transition-colors"
                      title="Restore to editor"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-blue-600" />
                    </button>
                    {v.status !== 'published' && (
                      <button
                        onClick={() => handleDelete(v.id)}
                        className="p-1.5 hover:bg-red-50 rounded transition-colors"
                        title="Delete version"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-400 hover:text-red-600" />
                      </button>
                    )}
                  </div>
                </div>

                {selectedVersion?.id === v.id && (
                  <div className="border border-t-0 rounded-b-lg bg-gray-50 p-3 -mt-1">
                    <pre className="text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                      {selectedVersion.systemPrompt}
                    </pre>
                    <div className="flex justify-end mt-2">
                      <button
                        onClick={() => loadVersionToEditor(selectedVersion.systemPrompt)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Load into editor
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
