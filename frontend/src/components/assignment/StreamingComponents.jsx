import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Loader2, CheckCircle, Wrench, ChevronDown, ChevronRight, Copy, Check,
} from 'lucide-react';

export function CopyBadge({ label, value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(String(value));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded text-xs text-gray-500 font-mono transition-colors"
      title={`Copy ${label}`}
    >
      {label} #{value}
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

export const mdComponents = {
  table: (props) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-gray-200" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-gray-50" {...props} />,
  th: (props) => <th className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-600" {...props} />,
  td: (props) => <td className="border border-gray-200 px-2 py-1 text-gray-700" {...props} />,
  h1: (props) => <h1 className="text-lg font-bold mt-3 mb-1" {...props} />,
  h2: (props) => <h2 className="text-base font-bold mt-3 mb-1" {...props} />,
  h3: (props) => <h3 className="text-sm font-bold mt-2 mb-1" {...props} />,
  h4: (props) => <h4 className="text-sm font-semibold mt-2 mb-0.5" {...props} />,
  p: (props) => <p className="my-1" {...props} />,
  ul: (props) => <ul className="list-disc ml-5 my-1 space-y-0.5" {...props} />,
  ol: (props) => <ol className="list-decimal ml-5 my-1 space-y-0.5" {...props} />,
  li: (props) => <li className="text-sm" {...props} />,
  hr: () => <hr className="my-3 border-gray-200" />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return <pre className="bg-gray-100 rounded p-2 my-1 overflow-x-auto text-xs"><code {...props}>{children}</code></pre>;
    }
    return <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  blockquote: (props) => <blockquote className="border-l-3 border-blue-300 pl-3 my-1 text-gray-600 italic" {...props} />,
};

export function ToolCallCard({ name, input, result, durationMs }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 border rounded-lg bg-gray-50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        <span className="text-xs font-medium text-blue-700">{name}</span>
        {result ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> : <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
        {durationMs != null && <span className="text-xs text-gray-400 ml-auto">{durationMs}ms</span>}
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {input && (
            <div>
              <span className="text-xs text-gray-400 font-medium">Input:</span>
              <pre className="text-xs bg-white rounded p-1.5 border overflow-x-auto max-h-28">{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {result && (
            <div>
              <span className="text-xs text-gray-400 font-medium">Result:</span>
              <pre className="text-xs bg-white rounded p-1.5 border overflow-x-auto max-h-40">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StreamContent({ events, toolCalls, thinkingKb, status, accentColor = 'blue' }) {
  const segments = [];
  let textSoFar = '';
  let toolIndex = 0;

  for (const event of events) {
    if (event.type === 'text') {
      textSoFar += event.text;
    } else if (event.type === 'tool_call') {
      if (textSoFar) {
        segments.push({ type: 'text', content: textSoFar });
        textSoFar = '';
      }
      const tc = toolCalls[toolIndex] || { name: event.name, input: event.input };
      segments.push({ type: 'tool', ...tc });
      toolIndex++;
    }
  }
  if (textSoFar) {
    segments.push({ type: 'text', content: textSoFar });
  }

  const cursorColor = accentColor === 'purple' ? 'bg-purple-500' : 'bg-blue-500';

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <div key={i} className="text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {seg.content}
              </Markdown>
            </div>
          );
        }
        if (seg.type === 'tool') {
          return (
            <ToolCallCard
              key={i}
              name={seg.name}
              input={seg.input}
              result={seg.result}
              durationMs={seg.durationMs}
            />
          );
        }
        return null;
      })}
      {status === 'running' && thinkingKb !== null && (
        <div className="flex items-center gap-2 py-1 text-xs text-gray-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span className="font-mono tabular-nums">processing {thinkingKb.toFixed(1)} KB...</span>
        </div>
      )}
      {status === 'running' && thinkingKb === null && events.length > 0 && (
        <span className={`inline-block w-2 h-4 ${cursorColor} animate-pulse ml-0.5`} />
      )}
    </>
  );
}

export function cleanTranscript(raw) {
  if (!raw) return '';
  return raw
    .replace(/```json\n([\s\S]*?)```/g, (_, json) => {
      try { const parsed = JSON.parse(json); return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'; } catch { return _; }
    })
    .replace(/\s*\*\(\d+\.\d+KB\)\*\s*/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export function processStreamEvent(event, { setEvents, setToolCalls, setThinkingKb, scrollToBottom, onRunStarted, onQueued, onResult, onError, onComplete }) {
  if (event.type !== 'thinking' && event.type !== 'turn_start') {
    setEvents((prev) => [...prev, event]);
  }

  switch (event.type) {
  case 'run_started':
    onRunStarted?.(event);
    break;
  case 'queued':
    onQueued?.(event);
    break;
  case 'text':
    setThinkingKb(null);
    setTimeout(scrollToBottom, 10);
    break;
  case 'thinking':
    setThinkingKb(event.kb);
    break;
  case 'tool_call':
    setToolCalls((prev) => [...prev, {
      id: event.toolUseId || `${event.name}-${Date.now()}`,
      name: event.name,
      input: event.input,
      result: null,
      durationMs: null,
    }]);
    setTimeout(scrollToBottom, 10);
    break;
  case 'tool_result':
    setToolCalls((prev) => prev.map((tc) => {
      if (event.toolUseId && tc.id === event.toolUseId) {
        return { ...tc, result: event.data, durationMs: event.durationMs };
      }
      if (!event.toolUseId && tc.name === event.name && !tc.result) {
        return { ...tc, result: event.data, durationMs: event.durationMs };
      }
      return tc;
    }));
    break;
  case 'error':
    onError?.(event);
    break;
  case 'recommendation':
  case 'assessment':
    onResult?.(event);
    break;
  case 'complete':
  case 'done':
    onComplete?.(event);
    break;
  default:
    break;
  }
}
