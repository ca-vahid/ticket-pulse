import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

export default function JsonInspector({ data, title, highlightKeys = [] }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderValue = (value, key = null) => {
    const isHighlighted = key && highlightKeys.includes(key);

    if (value === null || value === undefined) {
      return <span className="text-gray-400">null</span>;
    }

    if (typeof value === 'boolean') {
      return <span className="text-purple-600 font-semibold">{value.toString()}</span>;
    }

    if (typeof value === 'number') {
      return <span className="text-blue-600 font-semibold">{value}</span>;
    }

    if (typeof value === 'string') {
      return (
        <span className={isHighlighted ? 'text-green-700 font-semibold' : 'text-gray-800'}>
          &quot;{value}&quot;
        </span>
      );
    }

    if (Array.isArray(value)) {
      return (
        <div className="ml-4">
          {value.map((item, idx) => (
            <div key={idx} className="flex gap-2">
              <span className="text-gray-500">{idx}:</span>
              {renderValue(item)}
            </div>
          ))}
        </div>
      );
    }

    if (typeof value === 'object') {
      return (
        <div className="ml-4 space-y-1">
          {Object.entries(value).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-gray-700 font-medium">{k}:</span>
              {renderValue(v, k)}
            </div>
          ))}
        </div>
      );
    }

    return <span className="text-gray-600">{String(value)}</span>;
  };

  return (
    <div className="bg-gray-50 border border-gray-300 rounded">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-100 border-b border-gray-300">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-gray-200 rounded transition-colors"
          >
            {expanded ? (
              <ChevronDown className="w-4 h-4 text-gray-600" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-600" />
            )}
          </button>
          {title && <span className="text-xs font-semibold text-gray-700">{title}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-200 transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-green-600" />
              <span className="text-green-600">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy JSON</span>
            </>
          )}
        </button>
      </div>

      {/* Content */}
      {expanded && (
        <div className="p-3 font-mono text-xs overflow-x-auto">
          {renderValue(data)}
        </div>
      )}
    </div>
  );
}

