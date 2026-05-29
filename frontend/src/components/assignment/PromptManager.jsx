import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { assignmentAPI } from '../../services/api';
import {
  Save, Upload, RotateCcw, Clock, Loader2, Eye, FileText, CheckCircle,
  Wrench, ChevronDown, ChevronRight, Trash2, Maximize2, X, Code2,
  BookOpen, Columns2, GitCompare, ArrowRight, Plus, Minus, ChevronUp, Undo2,
} from 'lucide-react';
import { formatDateOnlyInTimezone } from '../../utils/dateHelpers';
import { buildLineDiff } from './promptDiff';

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
  published: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  draft: 'bg-amber-100 text-amber-800 border-amber-200',
  archived: 'bg-slate-100 text-slate-600 border-slate-200',
};

const promptMarkdownComponents = {
  h1: (props) => <h1 className="text-lg font-bold text-slate-950 mt-5 mb-2 first:mt-0" {...props} />,
  h2: (props) => <h2 className="text-base font-bold text-slate-900 mt-5 mb-2 pb-1 border-b border-slate-200 first:mt-0" {...props} />,
  h3: (props) => <h3 className="text-sm font-semibold text-slate-900 mt-4 mb-1.5 first:mt-0" {...props} />,
  h4: (props) => <h4 className="text-xs font-semibold uppercase text-slate-500 mt-4 mb-1 first:mt-0" {...props} />,
  p: (props) => <p className="my-2 text-sm leading-relaxed text-slate-700" {...props} />,
  ul: (props) => <ul className="list-disc pl-5 my-2 space-y-1 marker:text-slate-400" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5 my-2 space-y-1 marker:text-slate-500" {...props} />,
  li: (props) => <li className="text-sm leading-relaxed text-slate-700" {...props} />,
  strong: (props) => <strong className="font-semibold text-slate-950" {...props} />,
  em: (props) => <em className="text-slate-700" {...props} />,
  blockquote: (props) => (
    <blockquote className="border-l-4 border-blue-300 bg-blue-50/70 pl-3 pr-3 py-2 my-3 rounded-r-lg text-sm text-slate-700" {...props} />
  ),
  table: (props) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full text-xs border-collapse" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-slate-50" {...props} />,
  th: (props) => <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold text-slate-700" {...props} />,
  td: (props) => <td className="border-t border-slate-100 px-2 py-1.5 text-slate-700 align-top" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <pre className="bg-slate-950 text-slate-100 rounded-lg p-3 my-3 overflow-x-auto text-xs">
          <code {...props}>{children}</code>
        </pre>
      );
    }
    return <code className="bg-slate-100 text-slate-800 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  hr: () => <hr className="my-5 border-slate-200" />,
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
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {modes.map((mode) => {
        const Icon = mode.icon;
        const active = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(mode.id)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
              active ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
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

function MarkdownPreview({ value, className = '' }) {
  if (!String(value || '').trim()) {
    return (
      <div className={`flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-400 ${className}`}>
        Preview will appear here as the prompt is written.
      </div>
    );
  }

  return (
    <div className={`overflow-auto rounded-lg border border-slate-200 bg-white p-4 ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={promptMarkdownComponents}>
        {value}
      </Markdown>
    </div>
  );
}

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
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <ModeToggle value={mode} onChange={onModeChange} />
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{formatStat(stats.lines)} lines</span>
          <span className="h-3 w-px bg-slate-200" />
          <span>{formatStat(stats.words)} words</span>
          <span className="h-3 w-px bg-slate-200" />
          <span>{formatStat(stats.chars)} chars</span>
          {!expanded && (
            <button
              type="button"
              onClick={onExpand}
              className="ml-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-blue-200 hover:text-blue-700"
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
          className={`w-full ${editorHeight} resize-y border-0 bg-white p-4 font-mono text-sm leading-relaxed text-slate-900 outline-none focus:ring-0`}
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
            className={`${editorHeight} resize-y border-0 border-b border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-900 outline-none focus:ring-0 lg:border-b-0 lg:border-r`}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title">
      <div className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h3 id="prompt-editor-title" className="text-base font-bold text-slate-950">Assignment System Prompt</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {published ? `Currently published: v${published.version}` : 'No published prompt found yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
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
    return <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-blue-600" /></div>;
  }

  const TOOL_TYPES = {
    custom: 'bg-blue-100 text-blue-700',
    web_search_20250305: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Wrench className="w-4 h-4" /> Available Tools ({tools.length})
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            These tools are passed to the active provider alongside the system prompt. The model decides which tools to call during analysis.
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {tools.map((tool) => (
          <div key={tool.name} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => toggle(tool.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50"
            >
              {expanded[tool.name]
                ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
                : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />}
              <code className="text-xs font-semibold text-blue-700">{tool.name}</code>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TOOL_TYPES[tool.type] || TOOL_TYPES.custom}`}>
                {tool.type === 'custom' ? 'custom' : 'server'}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                {tool.description.slice(0, 110)}{tool.description.length > 110 ? '...' : ''}
              </span>
            </button>
            {expanded[tool.name] && (
              <div className="border-t border-slate-200 bg-slate-50 px-3 pb-3">
                <p className="mb-2 mt-2 text-xs text-slate-600">{tool.description}</p>
                {Object.keys(tool.parameters).length > 0 && (
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Parameters</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(tool.parameters).map(([key, val]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <code className="flex-shrink-0 font-mono text-blue-600">{key}</code>
                          {tool.required.includes(key) && (
                            <span className="rounded bg-red-100 px-1 text-[9px] font-medium text-red-600">required</span>
                          )}
                          <span className="text-slate-400">{val.type}{val.enum ? ` (${val.enum.join(' | ')})` : ''}</span>
                          {val.description && <span className="text-slate-500">- {val.description}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(tool.parameters).length === 0 && (
                  <p className="text-xs italic text-slate-400">No parameters - called without arguments.</p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-view-title">
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h3 id="prompt-view-title" className="text-base font-bold text-slate-950">Prompt v{prompt.version}</h3>
            <p className="mt-0.5 text-xs text-slate-500">{prompt.status} - {prompt.notes || 'No notes'}</p>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle value={mode} onChange={setMode} modes={EDITOR_MODES.filter((item) => item.id !== 'split')} />
            <button
              type="button"
              onClick={() => onLoad(prompt.systemPrompt)}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 text-sm font-semibold text-blue-700 hover:bg-blue-100"
            >
              <RotateCcw className="h-4 w-4" />
              Load
            </button>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
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
            <pre className="min-h-full overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-4 text-xs leading-relaxed text-slate-100 whitespace-pre-wrap">
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

function splitPromptText(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function DiffLine({ line }) {
  return <span className="whitespace-pre-wrap break-words">{line || ' '}</span>;
}

function SplitDiffView({
  diffRows,
  leftPaneRef,
  rightPaneRef,
  activeRowIndex,
  diffNavControls,
  onUpdateCompareLine,
  onInsertCompareLineAfter,
  onRemoveAddedBlock,
  onRestoreRemovedBlock,
  onUseBaseBlock,
  compareLineCount,
}) {
  return (
    <div className="grid min-h-[560px] overflow-hidden rounded-lg border border-slate-200 bg-white font-mono text-xs lg:grid-cols-2">
      <div className="min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase text-slate-500">
          <span>Base</span>
          {diffNavControls}
        </div>
        <div ref={leftPaneRef} className="h-[52vh] overflow-auto bg-white leading-relaxed lg:h-[64vh]">
          {diffRows.map((row, index) => {
            const isFirstRemovedBlock = row.type === 'removed' && diffRows[index - 1]?.type !== 'removed';
            const isActive = activeRowIndex === index;
            const tone = row.type === 'removed' || row.type === 'changed'
              ? 'bg-red-50 text-red-900'
              : row.type === 'added'
                ? 'bg-slate-50 text-slate-300'
                : 'bg-white text-slate-700';
            return (
              <div
                key={`left-${row.leftLine || 'x'}-${row.rightLine || 'x'}-${index}`}
                data-diff-row={index}
                className={`grid min-w-[560px] grid-cols-[56px_minmax(0,1fr)_96px] border-b border-slate-100 px-2 py-1.5 last:border-b-0 ${tone} ${isActive ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
              >
                <span className="select-none text-right text-slate-400">{row.leftLine || ''}</span>
                <span className="min-w-0 pl-3"><DiffLine line={row.left} /></span>
                <span className="pl-2 text-right">
                  {isFirstRemovedBlock && (
                    <button
                      type="button"
                      onClick={() => onRestoreRemovedBlock(row.leftLine)}
                      className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                      title="Put this removed block back into the compare prompt"
                    >
                      Put back
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-blue-50 px-3 py-2 text-[10px] font-semibold uppercase text-blue-700">
          <span>Compare · Editable</span>
          <button
            type="button"
            onClick={() => onInsertCompareLineAfter(compareLineCount)}
            className="rounded border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-blue-600 hover:bg-blue-50"
          >
            Add line
          </button>
        </div>
        <div ref={rightPaneRef} className="h-[52vh] overflow-auto bg-white leading-relaxed lg:h-[64vh]">
          {diffRows.map((row, index) => {
            const isFirstAddedBlock = row.type === 'added' && diffRows[index - 1]?.type !== 'added';
            const isFirstChangedBlock = row.type === 'changed' && diffRows[index - 1]?.type !== 'changed';
            const isActive = activeRowIndex === index;
            const tone = row.type === 'added' || row.type === 'changed'
              ? 'bg-emerald-50 text-emerald-900'
              : row.type === 'removed'
                ? 'bg-slate-50 text-slate-300'
                : 'bg-white text-slate-700';
            return (
              <div
                key={`right-${row.leftLine || 'x'}-${row.rightLine || 'x'}-${index}`}
                data-diff-row={index}
                className={`grid min-w-[560px] grid-cols-[56px_minmax(0,1fr)_112px] border-b border-slate-100 px-2 py-1.5 last:border-b-0 ${tone} ${isActive ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
              >
                <span className="select-none text-right text-slate-400">{row.rightLine || ''}</span>
                {row.rightLine ? (
                  <span
                    className="min-h-[1.45rem] min-w-0 whitespace-pre-wrap rounded border border-transparent px-3 py-0.5 outline-none transition-colors focus:border-blue-200 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(event) => onUpdateCompareLine(row.rightLine, event.currentTarget.innerText.replace(/\n$/u, ''))}
                  >
                    {row.right || ' '}
                  </span>
                ) : (
                  <span className="min-w-0 px-3 py-0.5"><DiffLine line="" /></span>
                )}
                <span className="flex justify-end gap-1 pl-2 text-right">
                  {isFirstAddedBlock && (
                    <button
                      type="button"
                      onClick={() => onRemoveAddedBlock(row.rightLine)}
                      className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                      title="Remove this added block from the compare prompt"
                    >
                      Remove
                    </button>
                  )}
                  {isFirstChangedBlock && (
                    <button
                      type="button"
                      onClick={() => onUseBaseBlock(index)}
                      className="rounded border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-blue-600 hover:bg-blue-50"
                      title="Replace this changed block with the base prompt text"
                    >
                      Use base
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UnifiedDiffView({ diffRows, paneRef, activeRowIndex }) {
  const unifiedRows = diffRows.flatMap((row, index) => {
    if (row.type === 'equal') return [{ key: `${index}-equal`, sourceRowIndex: index, type: 'equal', marker: ' ', line: row.left, lineNo: row.leftLine }];
    if (row.type === 'changed') {
      return [
        { key: `${index}-removed`, sourceRowIndex: index, type: 'removed', marker: '-', line: row.left, lineNo: row.leftLine },
        { key: `${index}-added`, sourceRowIndex: index, type: 'added', marker: '+', line: row.right, lineNo: row.rightLine },
      ];
    }
    if (row.type === 'removed') return [{ key: `${index}-removed`, sourceRowIndex: index, type: 'removed', marker: '-', line: row.left, lineNo: row.leftLine }];
    return [{ key: `${index}-added`, sourceRowIndex: index, type: 'added', marker: '+', line: row.right, lineNo: row.rightLine }];
  });

  return (
    <div ref={paneRef} className="h-full overflow-auto rounded-lg border border-slate-200 bg-white font-mono text-xs">
      {unifiedRows.map((row) => {
        const tone = row.type === 'removed'
          ? 'bg-red-50 text-red-900'
          : row.type === 'added'
            ? 'bg-emerald-50 text-emerald-900'
            : 'bg-white text-slate-700';
        return (
          <div
            key={row.key}
            data-diff-row={row.sourceRowIndex}
            className={`grid min-w-[760px] grid-cols-[56px_32px_1fr] border-b border-slate-100 last:border-b-0 ${tone} ${activeRowIndex === row.sourceRowIndex ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
          >
            <div className="px-2 py-1.5 text-right text-slate-400">{row.lineNo || ''}</div>
            <div className="px-2 py-1.5 font-bold">{row.marker}</div>
            <div className="px-3 py-1.5"><DiffLine line={row.line} /></div>
          </div>
        );
      })}
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
  const [leftKey, setLeftKey] = useState(initialLeftKey);
  const [rightKey, setRightKey] = useState(initialRightKey);
  const [mode, setMode] = useState('split');
  const [content, setContent] = useState({});
  const [loading, setLoading] = useState(false);
  const [compareDraft, setCompareDraft] = useState('');
  const [draftHistory, setDraftHistory] = useState([]);
  const [activeDiffIndex, setActiveDiffIndex] = useState(-1);
  const leftPaneRef = useRef(null);
  const rightPaneRef = useRef(null);
  const unifiedPaneRef = useRef(null);

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

    if (content[key]) return content[key];

    const id = Number(String(key).replace('version:', ''));
    if (published?.id === id) {
      const resolved = { ...published, label: `Live published v${published.version}` };
      setContent((prev) => ({ ...prev, [key]: resolved }));
      return resolved;
    }

    const prompt = await loadPromptVersion(id);
    const resolved = { ...prompt, label: `${prompt.status} v${prompt.version}` };
    setContent((prev) => ({ ...prev, [key]: resolved }));
    return resolved;
  }, [content, editText, loadPromptVersion, published]);

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
    Promise.all([resolveContent(leftKey), resolveContent(rightKey)])
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, leftKey, rightKey, resolveContent]);

  const left = leftKey === 'current' ? { label: 'Editor draft (current)', systemPrompt: editText } : content[leftKey];
  const right = rightKey === 'current' ? { label: 'Editor draft (current)', systemPrompt: editText } : content[rightKey];
  const leftPrompt = left?.systemPrompt || '';
  const rightSourceText = right?.systemPrompt || '';

  useEffect(() => {
    if (!isOpen || loading) return;
    setCompareDraft(rightSourceText);
    setDraftHistory([]);
    setActiveDiffIndex(-1);
  }, [isOpen, loading, rightKey, rightSourceText]);

  const diffRows = useMemo(() => buildLineDiff(leftPrompt, compareDraft), [compareDraft, leftPrompt]);
  const compareLineCount = compareDraft ? splitPromptText(compareDraft).length : 0;
  const added = diffRows.filter((row) => row.type === 'added' || row.type === 'changed').length;
  const removed = diffRows.filter((row) => row.type === 'removed' || row.type === 'changed').length;
  const diffRowIndexes = useMemo(
    () => diffRows.map((row, index) => (row.type !== 'equal' ? index : null)).filter((index) => index !== null),
    [diffRows],
  );
  const activeRowIndex = activeDiffIndex >= 0 ? diffRowIndexes[activeDiffIndex] : null;

  useEffect(() => {
    if (!diffRowIndexes.length && activeDiffIndex !== -1) {
      setActiveDiffIndex(-1);
      return;
    }
    if (activeDiffIndex > diffRowIndexes.length - 1) {
      setActiveDiffIndex(diffRowIndexes.length - 1);
    }
  }, [activeDiffIndex, diffRowIndexes.length]);

  const scrollToDiff = (direction) => {
    if (!diffRowIndexes.length) return;
    const nextIndex = direction === 'previous'
      ? Math.max(activeDiffIndex - 1, 0)
      : Math.min(activeDiffIndex + 1, diffRowIndexes.length - 1);
    const rowIndex = diffRowIndexes[nextIndex];
    setActiveDiffIndex(nextIndex);
    [leftPaneRef.current, rightPaneRef.current, unifiedPaneRef.current].forEach((pane) => {
      const target = pane?.querySelector(`[data-diff-row="${rowIndex}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  const commitCompareDraft = (nextPrompt) => {
    if (nextPrompt === compareDraft) return;
    setDraftHistory((prev) => [...prev.slice(-19), compareDraft]);
    setCompareDraft(nextPrompt);
  };

  const undoCompareDraft = () => {
    setDraftHistory((prev) => {
      if (!prev.length) return prev;
      const nextHistory = prev.slice(0, -1);
      setCompareDraft(prev[prev.length - 1]);
      return nextHistory;
    });
  };

  const updateCompareLine = (lineNumber, value) => {
    if (!lineNumber) return;
    const lines = splitPromptText(compareDraft);
    while (lines.length < lineNumber) lines.push('');
    lines[lineNumber - 1] = value;
    commitCompareDraft(lines.join('\n'));
  };

  const insertCompareLineAfter = (lineNumber) => {
    const lines = compareDraft ? splitPromptText(compareDraft) : [''];
    const insertAt = lineNumber ? lineNumber : lines.length;
    lines.splice(insertAt, 0, '');
    commitCompareDraft(lines.join('\n'));
  };

  const removeAddedBlock = (lineNumber) => {
    if (!lineNumber) return;
    const targetIndex = diffRows.findIndex((row) => row.type === 'added' && row.rightLine === lineNumber);
    if (targetIndex < 0) return;

    let start = targetIndex;
    let end = targetIndex;
    while (start > 0 && diffRows[start - 1].type === 'added' && diffRows[start - 1].rightLine) start -= 1;
    while (end + 1 < diffRows.length && diffRows[end + 1].type === 'added' && diffRows[end + 1].rightLine) end += 1;

    const removeLines = new Set(diffRows.slice(start, end + 1).map((row) => row.rightLine).filter(Boolean));
    const lines = splitPromptText(compareDraft).filter((_, index) => !removeLines.has(index + 1));
    commitCompareDraft(lines.join('\n'));
  };

  const restoreRemovedBlock = (lineNumber) => {
    if (!lineNumber) return;
    const targetIndex = diffRows.findIndex((row) => row.type === 'removed' && row.leftLine === lineNumber);
    if (targetIndex < 0) return;

    let start = targetIndex;
    let end = targetIndex;
    while (start > 0 && diffRows[start - 1].type === 'removed' && diffRows[start - 1].leftLine) start -= 1;
    while (end + 1 < diffRows.length && diffRows[end + 1].type === 'removed' && diffRows[end + 1].leftLine) end += 1;

    const restoredLines = diffRows.slice(start, end + 1).map((row) => row.left);
    const nextAnchor = diffRows.slice(end + 1).find((row) => row.rightLine);
    const lines = compareDraft ? splitPromptText(compareDraft) : [];
    const insertAt = nextAnchor?.rightLine ? nextAnchor.rightLine - 1 : lines.length;
    lines.splice(insertAt, 0, ...restoredLines);
    commitCompareDraft(lines.join('\n'));
  };

  const useBaseBlock = (rowIndex) => {
    if (rowIndex == null || diffRows[rowIndex]?.type !== 'changed') return;

    let start = rowIndex;
    let end = rowIndex;
    while (start > 0 && diffRows[start - 1].type === 'changed') start -= 1;
    while (end + 1 < diffRows.length && diffRows[end + 1].type === 'changed') end += 1;

    const lines = splitPromptText(compareDraft);
    diffRows.slice(start, end + 1).forEach((row) => {
      if (row.rightLine) {
        lines[row.rightLine - 1] = row.left;
      }
    });
    commitCompareDraft(lines.join('\n'));
  };

  const resetCompareDraft = () => {
    commitCompareDraft(rightSourceText);
  };

  const applyCompareDraftToEditor = () => {
    onApplyPrompt?.(compareDraft);
    onClose();
  };

  const diffNavControls = (
    <div className="flex items-center gap-1 normal-case tracking-normal">
      <span className="mr-1 text-[10px] font-medium text-slate-400">
        {diffRowIndexes.length ? `${Math.max(activeDiffIndex + 1, 0)}/${diffRowIndexes.length}` : '0/0'}
      </span>
      <button
        type="button"
        onClick={() => scrollToDiff('previous')}
        disabled={!diffRowIndexes.length || activeDiffIndex <= 0}
        className="rounded border border-slate-200 bg-white p-0.5 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Previous diff"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => scrollToDiff('next')}
        disabled={!diffRowIndexes.length || activeDiffIndex >= diffRowIndexes.length - 1}
        className="rounded border border-slate-200 bg-white p-0.5 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Next diff"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-diff-title">
      <div className="flex h-[92vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="prompt-diff-title" className="flex items-center gap-2 text-base font-bold text-slate-950">
                <GitCompare className="h-4 w-4 text-blue-600" />
                Prompt Diff
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">Compare any saved prompt against the live published prompt or the current editor draft.</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={undoCompareDraft}
                disabled={!draftHistory.length}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                title="Undo the last compare-side edit"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo
              </button>
              <button
                type="button"
                onClick={resetCompareDraft}
                disabled={compareDraft === rightSourceText}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                title="Reset compare prompt back to the selected source"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                type="button"
                onClick={applyCompareDraftToEditor}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-500 bg-blue-600 px-3 text-xs font-bold text-white shadow-sm shadow-blue-200 hover:bg-blue-700"
                title="Apply the compare prompt edits to the main prompt editor"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Apply to editor
              </button>
              <button
                type="button"
                onClick={onClose}
                autoFocus
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_1fr_auto] lg:items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-600">Base</span>
              <select
                value={leftKey}
                onChange={(event) => setLeftKey(event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800"
              >
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <ArrowRight className="hidden h-5 w-5 text-slate-300 lg:block" />
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-600">Compare</span>
              <select
                value={rightKey}
                onChange={(event) => setRightKey(event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800"
              >
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <ModeToggle value={mode} onChange={setMode} modes={DIFF_MODES} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-700">
            {optionLabel(left)} to {optionLabel(right)}
            {compareDraft !== rightSourceText && (
              <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">compare edited</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            {diffNavControls}
            <span className="inline-flex items-center gap-1 text-emerald-700"><Plus className="h-3.5 w-3.5" /> {added} added/changed</span>
            <span className="inline-flex items-center gap-1 text-red-700"><Minus className="h-3.5 w-3.5" /> {removed} removed/changed</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {loading && (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
              Loading prompt versions...
            </div>
          )}
          {!loading && mode === 'split' && (
            <SplitDiffView
              diffRows={diffRows}
              leftPaneRef={leftPaneRef}
              rightPaneRef={rightPaneRef}
              activeRowIndex={activeRowIndex}
              diffNavControls={null}
              onUpdateCompareLine={updateCompareLine}
              onInsertCompareLineAfter={insertCompareLineAfter}
              onRemoveAddedBlock={removeAddedBlock}
              onRestoreRemovedBlock={restoreRemovedBlock}
              onUseBaseBlock={useBaseBlock}
              compareLineCount={compareLineCount}
            />
          )}
          {!loading && mode === 'unified' && (
            <UnifiedDiffView
              diffRows={diffRows}
              paneRef={unifiedPaneRef}
              activeRowIndex={activeRowIndex}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function PromptManager({ workspaceTimezone = 'America/Los_Angeles' }) {
  const [versions, setVersions] = useState([]);
  const [published, setPublished] = useState(null);
  const [promptCache, setPromptCache] = useState({});
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
      if (data.published?.id) {
        setPromptCache((prev) => ({ ...prev, [String(data.published.id)]: data.published }));
      }
      if (data.published?.systemPrompt) {
        setEditText((prev) => prev || data.published.systemPrompt);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const loadPromptVersion = useCallback(async (id) => {
    const key = String(id);
    if (promptCache[key]) return promptCache[key];
    const res = await assignmentAPI.getPrompt(id);
    const prompt = res?.data || null;
    if (prompt) {
      setPromptCache((prev) => ({ ...prev, [key]: prompt }));
    }
    return prompt;
  }, [promptCache]);

  const handleSaveDraft = async () => {
    if (!editText.trim()) return;
    try {
      setSaving(true);
      setSaveMsg(null);
      const res = await assignmentAPI.createPrompt({ systemPrompt: editText, notes: notes || null });
      const draft = res?.data;
      if (draft?.id) setPromptCache((prev) => ({ ...prev, [String(draft.id)]: draft }));
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
      if (prompt?.id) setPromptCache((prev) => ({ ...prev, [String(prompt.id)]: prompt }));
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
      if (draft?.id) setPromptCache((prev) => ({ ...prev, [String(draft.id)]: draft }));
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
      setPromptCache((prev) => {
        const next = { ...prev };
        delete next[String(id)];
        return next;
      });
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
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <FileText className="h-4 w-4" /> System Prompt
            </h4>
            {published && (
              <p className="mt-0.5 text-xs text-slate-400">
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
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3.5 text-xs font-bold text-violet-700 transition-colors hover:border-violet-300 hover:bg-violet-100"
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
            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving || !editText.trim()}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Draft
          </button>
        </div>
        {saveMsg && (
          <p className="mt-2 flex items-center gap-1 text-sm text-emerald-600">
            <CheckCircle className="h-4 w-4" /> {saveMsg}
          </p>
        )}
      </section>

      <ToolListPanel />

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Clock className="h-4 w-4" /> Version History
          </h4>
          <span className="text-xs text-slate-400">{versions.length} saved versions</span>
        </div>
        {versions.length === 0 ? (
          <p className="text-sm text-slate-400">No versions yet. Save a draft to create the first version.</p>
        ) : (
          <div className="space-y-2">
            {versions.map((v) => (
              <div
                key={v.id}
                className="grid min-h-[48px] grid-cols-[44px_92px_minmax(0,1fr)_156px_auto] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm shadow-slate-100/60 transition-colors hover:border-slate-300"
              >
                <span className="font-mono text-sm font-semibold text-slate-700">v{v.version}</span>
                <span className={`inline-flex h-7 w-fit items-center rounded-md border px-2 text-xs font-semibold ${STATUS_BADGES[v.status] || STATUS_BADGES.archived}`}>
                  {v.status}
                </span>
                <span
                  className="min-w-0 truncate text-sm font-medium text-slate-500"
                  title={v.notes || 'No version notes'}
                >
                  {v.notes || 'No version notes'}
                </span>
                <span className="whitespace-nowrap text-right text-xs font-medium text-slate-400">
                  {formatDateOnlyInTimezone(v.createdAt, workspaceTimezone)}
                </span>
                <div className="flex items-center justify-end gap-1 rounded-lg bg-slate-50 px-1.5 py-1">
                  <button
                    type="button"
                    onClick={() => handleViewVersion(v.id)}
                    className="rounded-md p-1.5 transition-colors hover:bg-white hover:shadow-sm"
                    title="View"
                  >
                    <Eye className="h-3.5 w-3.5 text-slate-500" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openDiff(`version:${v.id}`)}
                    className="rounded-md p-1.5 transition-colors hover:bg-white hover:shadow-sm"
                    title="Compare this version with live"
                  >
                    <GitCompare className="h-3.5 w-3.5 text-blue-600" />
                  </button>
                  {v.status !== 'published' && (
                    <button
                      type="button"
                      onClick={() => handlePublish(v.id)}
                      disabled={publishing}
                      className="rounded-md p-1.5 transition-colors hover:bg-white hover:shadow-sm disabled:opacity-50"
                      title="Publish"
                    >
                      <Upload className="h-3.5 w-3.5 text-emerald-600" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRestore(v.id)}
                    className="rounded-md p-1.5 transition-colors hover:bg-white hover:shadow-sm"
                    title="Restore to editor"
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-blue-600" />
                  </button>
                  {v.status !== 'published' && (
                    <button
                      type="button"
                      onClick={() => handleDelete(v.id)}
                      className="rounded-md p-1.5 transition-colors hover:bg-white hover:shadow-sm"
                      title="Delete version"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400 hover:text-red-600" />
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
