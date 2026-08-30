import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { assignmentAPI } from '../../services/api';
import {
  Save, Upload, RotateCcw, Clock, Loader2, Eye, FileText, CheckCircle,
  Wrench, ChevronDown, ChevronRight, Trash2, Maximize2, X, Code2,
  BookOpen, Columns2, GitCompare, ArrowRight, Plus, Minus, ChevronUp, Undo2,
} from 'lucide-react';
import { formatDateOnlyInTimezone } from '../../utils/dateHelpers';
import { DiffEditor } from '@monaco-editor/react';
import { useTheme } from '../../contexts/ThemeContext';
import { countLines, isDiffTooLarge } from './promptDiff';

const EDITOR_MODES = [
  { id: 'edit', label: 'Edit', icon: Code2 },
  { id: 'preview', label: 'Preview', icon: BookOpen },
  { id: 'split', label: 'Split', icon: Columns2 },
];

const DIFF_MODES = [
  { id: 'split', label: 'Split' },
  { id: 'unified', label: 'Unified' },
];

const STATUS_BADGES = {
  published: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30',
  draft: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-500/30',
  archived: 'bg-muted text-muted-foreground border-border',
};

const promptMarkdownComponents = {
  h1: (props) => <h1 className="text-lg font-bold text-foreground mt-5 mb-2 first:mt-0" {...props} />,
  h2: (props) => <h2 className="text-base font-bold text-foreground mt-5 mb-2 pb-1 border-b border-border first:mt-0" {...props} />,
  h3: (props) => <h3 className="text-sm font-semibold text-foreground mt-4 mb-1.5 first:mt-0" {...props} />,
  h4: (props) => <h4 className="text-xs font-semibold uppercase text-muted-foreground mt-4 mb-1 first:mt-0" {...props} />,
  p: (props) => <p className="my-2 text-sm leading-relaxed text-foreground/85" {...props} />,
  ul: (props) => <ul className="list-disc pl-5 my-2 space-y-1 marker:text-muted-foreground/75" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5 my-2 space-y-1 marker:text-muted-foreground" {...props} />,
  li: (props) => <li className="text-sm leading-relaxed text-foreground/85" {...props} />,
  strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
  em: (props) => <em className="text-foreground/85" {...props} />,
  blockquote: (props) => (
    <blockquote className="border-l-4 border-blue-300 dark:border-blue-500/40 bg-blue-50/70 dark:bg-blue-500/10 pl-3 pr-3 py-2 my-3 rounded-r-lg text-sm text-foreground/85" {...props} />
  ),
  table: (props) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs border-collapse" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-muted/50" {...props} />,
  th: (props) => <th className="border-b border-border px-2 py-1.5 text-left font-semibold text-foreground/85" {...props} />,
  td: (props) => <td className="border-t border-border/60 px-2 py-1.5 text-foreground/85 align-top" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <pre className="bg-slate-950 dark:ring-1 dark:ring-white/10 text-slate-100 rounded-lg p-3 my-3 overflow-x-auto text-xs">
          <code {...props}>{children}</code>
        </pre>
      );
    }
    return <code className="bg-muted text-foreground px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  hr: () => <hr className="my-5 border-border" />,
};

function promptStats(text) {
  const value = String(text || '');
  return {
    chars: value.length,
    lines: value ? value.split(/\r\n|\r|\n/).length : 0,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
  };
}

function formatStat(value) {
  return Number(value || 0).toLocaleString();
}

function ModeToggle({ value, onChange, modes = EDITOR_MODES }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/50 p-0.5">
      {modes.map((mode) => {
        const Icon = mode.icon;
        const active = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(mode.id)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
              active ? 'bg-card text-blue-700 dark:text-blue-200 shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            title={mode.label}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

const MarkdownPreview = memo(function MarkdownPreview({ value, className = '' }) {
  if (!String(value || '').trim()) {
    return (
      <div className={`flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/50 text-sm text-muted-foreground/75 ${className}`}>
        Preview will appear here as the prompt is written.
      </div>
    );
  }

  return (
    <div className={`overflow-auto rounded-lg border border-border bg-card p-4 ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={promptMarkdownComponents}>
        {value}
      </Markdown>
    </div>
  );
});

function PromptEditorSurface({
  value,
  onChange,
  mode,
  onModeChange,
  onExpand,
  expanded = false,
}) {
  const stats = promptStats(value);
  const editorHeight = expanded ? 'min-h-[calc(100vh-230px)]' : 'min-h-[420px]';
  const previewHeight = expanded ? 'max-h-[calc(100vh-230px)]' : 'max-h-[540px]';

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/50 px-3 py-2">
        <ModeToggle value={mode} onChange={onModeChange} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{formatStat(stats.lines)} lines</span>
          <span className="h-3 w-px bg-secondary" />
          <span>{formatStat(stats.words)} words</span>
          <span className="h-3 w-px bg-secondary" />
          <span>{formatStat(stats.chars)} chars</span>
          {!expanded && (
            <button
              type="button"
              onClick={onExpand}
              className="ml-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-semibold text-foreground/85 hover:border-blue-200 dark:hover:border-blue-500/30 hover:text-blue-700 dark:hover:text-blue-200"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Fullscreen
            </button>
          )}
        </div>
      </div>

      {mode === 'edit' && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full ${editorHeight} resize-y border-0 bg-card p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus:ring-0`}
          placeholder="Enter the assignment system prompt here..."
          spellCheck="false"
        />
      )}

      {mode === 'preview' && (
        <MarkdownPreview value={value} className={`${previewHeight} border-0 rounded-none`} />
      )}

      {mode === 'split' && (
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`${editorHeight} resize-y border-0 border-b border-border bg-card p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus:ring-0 lg:border-b-0 lg:border-r`}
            placeholder="Enter the assignment system prompt here..."
            spellCheck="false"
          />
          <MarkdownPreview value={value} className={`${previewHeight} border-0 rounded-none`} />
        </div>
      )}
    </div>
  );
}

function PromptEditorModal({ isOpen, onClose, value, onChange, mode, onModeChange, published }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 dark:bg-black/70 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title">
      <div className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-xl bg-card shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 id="prompt-editor-title" className="text-base font-bold text-foreground">Assignment System Prompt</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {published ? `Currently published: v${published.version}` : 'No published prompt found yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground/85 hover:bg-muted/50"
          >
            <X className="h-4 w-4" />
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <PromptEditorSurface
            value={value}
            onChange={onChange}
            mode={mode}
            onModeChange={onModeChange}
            expanded
          />
        </div>
      </div>
    </div>
  );
}

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
    return <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-blue-600 dark:text-blue-300" /></div>;
  }

  const TOOL_TYPES = {
    custom: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200',
    web_search_20250305: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-200',
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Wrench className="w-4 h-4" /> Available Tools ({tools.length})
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            These tools are passed to the active provider alongside the system prompt. The model decides which tools to call during analysis.
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {tools.map((tool) => (
          <div key={tool.name} className="overflow-hidden rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => toggle(tool.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
            >
              {expanded[tool.name]
                ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/75" />
                : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/75" />}
              <code className="text-xs font-semibold text-blue-700 dark:text-blue-200">{tool.name}</code>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TOOL_TYPES[tool.type] || TOOL_TYPES.custom}`}>
                {tool.type === 'custom' ? 'custom' : 'server'}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/75">
                {tool.description.slice(0, 110)}{tool.description.length > 110 ? '...' : ''}
              </span>
            </button>
            {expanded[tool.name] && (
              <div className="border-t border-border bg-muted/50 px-3 pb-3">
                <p className="mb-2 mt-2 text-xs text-muted-foreground">{tool.description}</p>
                {Object.keys(tool.parameters).length > 0 && (
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Parameters</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(tool.parameters).map(([key, val]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <code className="flex-shrink-0 font-mono text-blue-600 dark:text-blue-300">{key}</code>
                          {tool.required.includes(key) && (
                            <span className="rounded bg-red-100 dark:bg-red-500/20 px-1 text-[9px] font-medium text-red-600 dark:text-red-300">required</span>
                          )}
                          <span className="text-muted-foreground/75">{val.type}{val.enum ? ` (${val.enum.join(' | ')})` : ''}</span>
                          {val.description && <span className="text-muted-foreground">- {val.description}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(tool.parameters).length === 0 && (
                  <p className="text-xs italic text-muted-foreground/75">No parameters - called without arguments.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptViewModal({ prompt, onClose, onLoad }) {
  const [mode, setMode] = useState('preview');

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 dark:bg-black/70 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-view-title">
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-card shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 id="prompt-view-title" className="text-base font-bold text-foreground">Prompt v{prompt.version}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{prompt.status} - {prompt.notes || 'No notes'}</p>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle value={mode} onChange={setMode} modes={EDITOR_MODES.filter((item) => item.id !== 'split')} />
            <button
              type="button"
              onClick={() => onLoad(prompt.systemPrompt)}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-3 text-sm font-semibold text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-500/20"
            >
              <RotateCcw className="h-4 w-4" />
              Load
            </button>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground/85 hover:bg-muted/50"
            >
              <X className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {mode === 'preview' ? (
            <MarkdownPreview value={prompt.systemPrompt} className="min-h-full" />
          ) : (
            <pre className="min-h-full overflow-auto rounded-lg border border-border bg-slate-950 dark:ring-1 dark:ring-white/10 p-4 text-xs leading-relaxed text-slate-100 whitespace-pre-wrap">
              {prompt.systemPrompt}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function optionLabel(option) {
  return option?.label || 'Unknown prompt';
}

const DIFF_EDITOR_OPTIONS = {
  originalEditable: false,
  readOnly: false,
  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
  wordWrap: 'on',
  diffWordWrap: 'on',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  diffAlgorithm: 'advanced',
  fontSize: 12,
  lineNumbers: 'on',
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  wordBasedSuggestions: 'off',
  renderLineHighlight: 'none',
  glyphMargin: false,
  folding: false,
  automaticLayout: true,
};

function DiffLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600 dark:text-blue-300" />
      Loading diff editor...
    </div>
  );
}

/** Raw side-by-side used when the pair is past the size guard. */
function RawSideBySide({ leftLabel, rightLabel, leftText, rightText, onComputeAnyway }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="diff-size-guard">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        <span>
          Prompts too large for a line-by-line diff ({formatStat(countLines(leftText))} vs {formatStat(countLines(rightText))} lines) — showing raw side-by-side.
        </span>
        <button
          type="button"
          onClick={onComputeAnyway}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300 dark:border-amber-500/40 bg-card px-3 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/20"
        >
          <GitCompare className="h-3.5 w-3.5" />
          Compute anyway
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        {[[leftLabel, leftText], [rightLabel, rightText]].map(([label, text]) => (
          <div key={label} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border bg-muted/50 px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
            <pre className="settings-scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground/85 whitespace-pre-wrap break-words">{text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptDiffModal({
  isOpen,
  onClose,
  versions,
  published,
  editText,
  initialLeftKey,
  initialRightKey,
  loadPromptVersion,
  onApplyPrompt,
}) {
  const { resolvedTheme } = useTheme();
  const [leftKey, setLeftKey] = useState(initialLeftKey);
  const [rightKey, setRightKey] = useState(initialRightKey);
  const [mode, setMode] = useState('split');
  const [content, setContent] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [computeAnyway, setComputeAnyway] = useState(false);
  const [compareDirty, setCompareDirty] = useState(false);
  const [changeStats, setChangeStats] = useState({ added: 0, removed: 0, blocks: 0 });
  const [editorReady, setEditorReady] = useState(false);
  // Resolved prompt bodies live in a ref so resolveContent never changes
  // identity on a state write (the old version re-fired the loader effect and
  // duplicated GET /assignment/prompts/:id on every render).
  const contentRef = useRef({});
  const diffEditorRef = useRef(null);
  const editorSubscriptionsRef = useRef([]);
  const keptModelsRef = useRef([]);
  const disposeKeptModels = () => {
    keptModelsRef.current.forEach((model) => {
      try { if (!model.isDisposed?.()) model.dispose(); } catch { /* already gone */ }
    });
    keptModelsRef.current = [];
  };

  const options = useMemo(() => {
    const all = [
      { key: 'current', label: 'Editor draft (current)', systemPrompt: editText, status: 'current' },
    ];
    versions.forEach((version) => {
      all.push({
        key: `version:${version.id}`,
        id: version.id,
        label: `${version.status === 'published' ? 'Live published' : version.status} v${version.version}`,
        meta: version.notes || formatDateOnlyInTimezone(version.createdAt),
        status: version.status,
      });
    });
    if (published && !all.some((item) => item.key === `version:${published.id}`)) {
      all.push({
        key: `version:${published.id}`,
        id: published.id,
        label: `Live published v${published.version}`,
        status: 'published',
      });
    }
    return all;
  }, [editText, published, versions]);

  const resolveContent = useCallback(async (key) => {
    if (key === 'current') {
      return { label: 'Editor draft (current)', systemPrompt: editText };
    }
    if (contentRef.current[key]) return contentRef.current[key];

    const id = Number(String(key).replace('version:', ''));
    let resolved;
    if (published?.id === id) {
      resolved = { ...published, label: `Live published v${published.version}` };
    } else {
      const prompt = await loadPromptVersion(id);
      if (!prompt) throw new Error(`Prompt version ${id} was not found`);
      resolved = { ...prompt, label: `${prompt.status} v${prompt.version}` };
    }
    contentRef.current = { ...contentRef.current, [key]: resolved };
    return resolved;
  }, [editText, loadPromptVersion, published]);

  useEffect(() => {
    if (!isOpen) return undefined;
    setLeftKey(initialLeftKey);
    setRightKey(initialRightKey);
    return undefined;
  }, [initialLeftKey, initialRightKey, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([resolveContent(leftKey), resolveContent(rightKey)])
      .then(() => {
        if (cancelled) return;
        setContent(contentRef.current);
      })
      .catch((err) => {
        if (cancelled) return;
        const failedKeys = [leftKey, rightKey].filter((key) => key !== 'current' && !contentRef.current[key]);
        const labels = failedKeys.map((key) => {
          const option = options.find((item) => item.key === key);
          return option ? `version ${option.label.replace(/^.*\bv/, '')}` : key;
        });
        setLoadError(`Could not load ${labels.join(' and ') || 'the selected prompt'}${err?.message ? ` — ${err.message}` : ''}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, leftKey, rightKey, resolveContent, options]);

  const left = leftKey === 'current' ? { label: 'Editor draft (current)', systemPrompt: editText } : content[leftKey];
  const right = rightKey === 'current' ? { label: 'Editor draft (current)', systemPrompt: editText } : content[rightKey];
  const leftPrompt = left?.systemPrompt || '';
  const rightSourceText = right?.systemPrompt || '';
  const tooLarge = useMemo(() => isDiffTooLarge(leftPrompt, rightSourceText), [leftPrompt, rightSourceText]);
  const showGuard = tooLarge && !computeAnyway;

  // New pair → fresh compare side, fresh guard decision, fresh stats.
  useEffect(() => {
    setComputeAnyway(false);
    setCompareDirty(false);
    setChangeStats({ added: 0, removed: 0, blocks: 0 });
    setEditorReady(false);
  }, [leftKey, rightKey]);

  useEffect(() => () => {
    editorSubscriptionsRef.current.forEach((sub) => sub?.dispose?.());
    editorSubscriptionsRef.current = [];
    // Defer past the child <DiffEditor> unmount so the editor is disposed
    // before its models are.
    const models = keptModelsRef.current;
    keptModelsRef.current = [];
    setTimeout(() => models.forEach((model) => {
      try { if (!model.isDisposed?.()) model.dispose(); } catch { /* already gone */ }
    }), 0);
  }, []);

  const readModifiedValue = () => {
    const model = diffEditorRef.current?.getModifiedEditor?.()?.getModel?.();
    return model ? model.getValue() : rightSourceText;
  };

  const handleEditorMount = (editor) => {
    diffEditorRef.current = editor;
    editorSubscriptionsRef.current.forEach((sub) => sub?.dispose?.());
    editorSubscriptionsRef.current = [];
    // @monaco-editor/react disposes the text models BEFORE the diff editor on
    // unmount ("TextModel got disposed before DiffEditorWidget model got
    // reset"), so we keep the models ourselves (keepCurrent*Model) and drop
    // the previous pair here — by now its editor instance is already gone.
    disposeKeptModels();
    const models = editor.getModel();
    keptModelsRef.current = models ? [models.original, models.modified] : [];
    const modified = editor.getModifiedEditor();
    editorSubscriptionsRef.current.push(modified.onDidChangeModelContent(() => {
      setCompareDirty(modified.getModel()?.getValue() !== rightSourceText);
    }));
    editorSubscriptionsRef.current.push(editor.onDidUpdateDiff(() => {
      const changes = editor.getLineChanges() || [];
      let added = 0;
      let removed = 0;
      changes.forEach((change) => {
        if (change.modifiedEndLineNumber >= change.modifiedStartLineNumber && change.modifiedEndLineNumber > 0) {
          added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
        }
        if (change.originalEndLineNumber >= change.originalStartLineNumber && change.originalEndLineNumber > 0) {
          removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
        }
      });
      setChangeStats({ added, removed, blocks: changes.length });
    }));
    setEditorReady(true);
  };

  const goToDiff = (direction) => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    if (typeof editor.goToDiff === 'function') {
      editor.goToDiff(direction);
    } else {
      editor.getModifiedEditor().trigger('keyboard', direction === 'next' ? 'editor.action.diffReview.next' : 'editor.action.diffReview.prev', null);
    }
  };

  const undoCompareEdit = () => {
    diffEditorRef.current?.getModifiedEditor()?.trigger('keyboard', 'undo', null);
  };

  const resetCompareDraft = () => {
    const model = diffEditorRef.current?.getModifiedEditor?.()?.getModel?.();
    if (model) model.setValue(rightSourceText);
    setCompareDirty(false);
  };

  const applyCompareDraftToEditor = () => {
    onApplyPrompt?.(readModifiedValue());
    onClose();
  };

  if (!isOpen) return null;

  const diffNavControls = (
    <div className="flex items-center gap-1 normal-case tracking-normal">
      <span className="mr-1 text-[10px] font-medium text-muted-foreground/75">
        {changeStats.blocks ? `${changeStats.blocks} change${changeStats.blocks === 1 ? '' : 's'}` : 'no changes'}
      </span>
      <button
        type="button"
        onClick={() => goToDiff('previous')}
        disabled={!editorReady || !changeStats.blocks}
        className="rounded border border-border bg-card p-0.5 text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Previous change"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => goToDiff('next')}
        disabled={!editorReady || !changeStats.blocks}
        className="rounded border border-border bg-card p-0.5 text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Next change"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 dark:bg-black/70 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-diff-title">
      <div className="flex h-[92vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-xl bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="prompt-diff-title" className="flex items-center gap-2 text-base font-bold text-foreground">
                <GitCompare className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                Prompt Diff
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Compare any saved prompt against the live published prompt or the current editor draft. The compare side is editable — unchanged regions are collapsed; use the arrows in the gutter to take or revert a block.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={undoCompareEdit}
                disabled={!editorReady || !compareDirty}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
                title="Undo the last compare-side edit (Ctrl+Z inside the editor also works)"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo
              </button>
              <button
                type="button"
                onClick={resetCompareDraft}
                disabled={!editorReady || !compareDirty}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
                title="Reset compare prompt back to the selected source"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                type="button"
                onClick={applyCompareDraftToEditor}
                disabled={loading || Boolean(loadError)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-500 bg-blue-600 px-3 text-xs font-bold text-white shadow-sm shadow-blue-200 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                title="Apply the compare prompt (with any edits) to the main prompt editor"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Apply to editor
              </button>
              <button
                type="button"
                onClick={onClose}
                autoFocus
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground/85 hover:bg-muted/50"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_1fr_auto] lg:items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Base</span>
              <select
                value={leftKey}
                onChange={(event) => setLeftKey(event.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"
              >
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <ArrowRight className="hidden h-5 w-5 text-muted-foreground/50 lg:block" />
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Compare</span>
              <select
                value={rightKey}
                onChange={(event) => setRightKey(event.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"
              >
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <ModeToggle value={mode} onChange={setMode} modes={DIFF_MODES} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/85">
            {optionLabel(left)} to {optionLabel(right)}
            {compareDirty && (
              <span className="ml-2 rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-200">compare edited</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            {diffNavControls}
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-200"><Plus className="h-3.5 w-3.5" /> {formatStat(changeStats.added)} added/changed</span>
            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-200"><Minus className="h-3.5 w-3.5" /> {formatStat(changeStats.removed)} removed/changed</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {loading && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600 dark:text-blue-300" />
              Loading prompt versions...
            </div>
          )}
          {!loading && loadError && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center" role="alert">
              <p className="text-sm font-semibold text-red-700 dark:text-red-200">{loadError}</p>
              <p className="max-w-md text-xs text-muted-foreground">Pick a different version above, or close and reopen the diff to retry.</p>
            </div>
          )}
          {!loading && !loadError && showGuard && (
            <RawSideBySide
              leftLabel={`Base · ${optionLabel(left)}`}
              rightLabel={`Compare · ${optionLabel(right)}`}
              leftText={leftPrompt}
              rightText={rightSourceText}
              onComputeAnyway={() => setComputeAnyway(true)}
            />
          )}
          {!loading && !loadError && !showGuard && (
            <div className="h-full overflow-hidden rounded-lg border border-border" data-testid="prompt-diff-editor">
              <DiffEditor
                key={`${leftKey}|${rightKey}`}
                height="100%"
                language="markdown"
                original={leftPrompt}
                modified={rightSourceText}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                loading={<DiffLoading />}
                onMount={handleEditorMount}
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                options={{ ...DIFF_EDITOR_OPTIONS, renderSideBySide: mode === 'split' }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PromptManager({ workspaceTimezone = 'America/Los_Angeles' }) {
  const [versions, setVersions] = useState([]);
  const [published, setPublished] = useState(null);
  // Version bodies are cached in a ref (not state) so loadPromptVersion keeps
  // one identity for the modal's effects, and an in-flight map dedupes
  // concurrent GET /assignment/prompts/:id for the same version (Phase PD3).
  const promptCacheRef = useRef({});
  const promptInflightRef = useRef(new Map());
  const cachePrompt = useCallback((prompt) => {
    if (prompt?.id) promptCacheRef.current[String(prompt.id)] = prompt;
  }, []);
  const [editText, setEditText] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [error, setError] = useState(null);
  const [editorMode, setEditorMode] = useState('split');
  const [editorModalOpen, setEditorModalOpen] = useState(false);
  const [viewVersion, setViewVersion] = useState(null);
  const [diffConfig, setDiffConfig] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getPrompts();
      const data = res?.data || {};
      setVersions(data.versions || []);
      setPublished(data.published || null);
      if (data.published?.id) cachePrompt(data.published);
      if (data.published?.systemPrompt) {
        setEditText((prev) => prev || data.published.systemPrompt);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [cachePrompt]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const loadPromptVersion = useCallback(async (id) => {
    const key = String(id);
    if (promptCacheRef.current[key]) return promptCacheRef.current[key];
    const inflight = promptInflightRef.current;
    if (inflight.has(key)) return inflight.get(key);
    const request = assignmentAPI.getPrompt(id)
      .then((res) => {
        const prompt = res?.data || null;
        if (prompt) promptCacheRef.current[key] = prompt;
        return prompt;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }, []);

  const handleSaveDraft = async () => {
    if (!editText.trim()) return;
    try {
      setSaving(true);
      setSaveMsg(null);
      const res = await assignmentAPI.createPrompt({ systemPrompt: editText, notes: notes || null });
      const draft = res?.data;
      cachePrompt(draft);
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
      const res = await assignmentAPI.publishPrompt(id);
      const prompt = res?.data;
      cachePrompt(prompt);
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
      cachePrompt(draft);
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
      delete promptCacheRef.current[String(id)];
      setSaveMsg('Version deleted');
      await fetchData();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const handleViewVersion = async (id) => {
    try {
      const prompt = await loadPromptVersion(id);
      setViewVersion(prompt);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadVersionToEditor = (prompt) => {
    setEditText(prompt);
    setViewVersion(null);
    setSaveMsg('Loaded into editor');
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const openDiff = (rightKey, leftKey = published ? `version:${published.id}` : 'current') => {
    setDiffConfig({ leftKey, rightKey });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 p-3 text-sm text-red-700 dark:text-red-200">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <FileText className="h-4 w-4" /> System Prompt
            </h4>
            {published && (
              <p className="mt-0.5 text-xs text-muted-foreground/75">
                Currently published: v{published.version}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {published && (
              <button
                type="button"
                onClick={() => openDiff('current')}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-500 bg-blue-600 px-3.5 text-xs font-bold text-white shadow-sm shadow-blue-200 transition-colors hover:bg-blue-700"
                title="Compare the current editor contents against the live published prompt"
              >
                <GitCompare className="h-3.5 w-3.5" />
                Diff editor vs live
              </button>
            )}
            {versions.length > 1 && published && (
              <button
                type="button"
                onClick={() => openDiff(`version:${versions[0].id}`)}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-3.5 text-xs font-bold text-violet-700 dark:text-violet-200 transition-colors hover:border-violet-300 dark:hover:border-violet-500/40 hover:bg-violet-100 dark:hover:bg-violet-500/20"
                title="Open the prompt comparison viewer for saved versions"
              >
                <Columns2 className="h-3.5 w-3.5" />
                Compare saved versions
              </button>
            )}
          </div>
        </div>
        <PromptEditorSurface
          value={editText}
          onChange={setEditText}
          mode={editorMode}
          onModeChange={setEditorMode}
          onExpand={() => setEditorModalOpen(true)}
        />
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Version notes (optional)"
            className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-blue-300 dark:focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
          />
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving || !editText.trim()}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border px-4 text-sm font-semibold text-foreground/85 transition-colors hover:bg-muted/50 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Draft
          </button>
        </div>
        {saveMsg && (
          <p className="mt-2 flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-300">
            <CheckCircle className="h-4 w-4" /> {saveMsg}
          </p>
        )}
      </section>

      <ToolListPanel />

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Clock className="h-4 w-4" /> Version History
          </h4>
          <span className="text-xs text-muted-foreground/75">{versions.length} saved versions</span>
        </div>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground/75">No versions yet. Save a draft to create the first version.</p>
        ) : (
          <div className="space-y-2">
            {versions.map((v) => (
              <div
                key={v.id}
                className="grid min-h-[48px] grid-cols-[44px_92px_minmax(0,1fr)_156px_auto] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm shadow-black/5 dark:shadow-black/40 transition-colors hover:border-input"
              >
                <span className="font-mono text-sm font-semibold text-foreground/85">v{v.version}</span>
                <span className={`inline-flex h-7 w-fit items-center rounded-md border px-2 text-xs font-semibold ${STATUS_BADGES[v.status] || STATUS_BADGES.archived}`}>
                  {v.status}
                </span>
                <span
                  className="min-w-0 truncate text-sm font-medium text-muted-foreground"
                  title={v.notes || 'No version notes'}
                >
                  {v.notes || 'No version notes'}
                </span>
                <span className="whitespace-nowrap text-right text-xs font-medium text-muted-foreground/75">
                  {formatDateOnlyInTimezone(v.createdAt, workspaceTimezone)}
                </span>
                <div className="flex items-center justify-end gap-1 rounded-lg bg-muted/50 px-1.5 py-1">
                  <button
                    type="button"
                    onClick={() => handleViewVersion(v.id)}
                    className="rounded-md p-1.5 transition-colors hover:bg-card hover:shadow-sm"
                    title="View"
                  >
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openDiff(`version:${v.id}`)}
                    className="rounded-md p-1.5 transition-colors hover:bg-card hover:shadow-sm"
                    title="Compare this version with live"
                  >
                    <GitCompare className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300" />
                  </button>
                  {v.status !== 'published' && (
                    <button
                      type="button"
                      onClick={() => handlePublish(v.id)}
                      disabled={publishing}
                      className="rounded-md p-1.5 transition-colors hover:bg-card hover:shadow-sm disabled:opacity-50"
                      title="Publish"
                    >
                      <Upload className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRestore(v.id)}
                    className="rounded-md p-1.5 transition-colors hover:bg-card hover:shadow-sm"
                    title="Restore to editor"
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300" />
                  </button>
                  {v.status !== 'published' && (
                    <button
                      type="button"
                      onClick={() => handleDelete(v.id)}
                      className="rounded-md p-1.5 transition-colors hover:bg-card hover:shadow-sm"
                      title="Delete version"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400 hover:text-red-600 dark:hover:text-red-300" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <PromptEditorModal
        isOpen={editorModalOpen}
        onClose={() => setEditorModalOpen(false)}
        value={editText}
        onChange={setEditText}
        mode={editorMode}
        onModeChange={setEditorMode}
        published={published}
      />

      {viewVersion && (
        <PromptViewModal
          prompt={viewVersion}
          onClose={() => setViewVersion(null)}
          onLoad={loadVersionToEditor}
        />
      )}

      {diffConfig && (
        <PromptDiffModal
          isOpen={!!diffConfig}
          onClose={() => setDiffConfig(null)}
          versions={versions}
          published={published}
          editText={editText}
          initialLeftKey={diffConfig.leftKey}
          initialRightKey={diffConfig.rightKey}
          loadPromptVersion={loadPromptVersion}
          onApplyPrompt={(nextPrompt) => {
            setEditText(nextPrompt);
            setSaveMsg('Loaded diff edits into editor');
            setTimeout(() => setSaveMsg(null), 3000);
          }}
        />
      )}
    </div>
  );
}
