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
      return <span className="text-muted-foreground/75">null</span>;
    }

    if (typeof value === 'boolean') {
      return <span className="text-purple-600 dark:text-purple-300 font-semibold">{value.toString()}</span>;
    }

    if (typeof value === 'number') {
      return <span className="text-blue-600 dark:text-blue-300 font-semibold">{value}</span>;
    }

    if (typeof value === 'string') {
      return (
        <span className={isHighlighted ? 'text-green-700 dark:text-green-200 font-semibold' : 'text-foreground'}>
          &quot;{value}&quot;
        </span>
      );
    }

    if (Array.isArray(value)) {
      return (
        <div className="ml-4">
          {value.map((item, idx) => (
            <div key={idx} className="flex gap-2">
              <span className="text-muted-foreground">{idx}:</span>
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
              <span className="text-foreground/85 font-medium">{k}:</span>
              {renderValue(v, k)}
            </div>
          ))}
        </div>
      );
    }

    return <span className="text-muted-foreground">{String(value)}</span>;
  };

  return (
    <div className="bg-muted/50 border border-input rounded">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted border-b border-input">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-secondary rounded transition-colors"
          >
            {expanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          {title && <span className="text-xs font-semibold text-foreground/85">{title}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-secondary transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-green-600 dark:text-green-300" />
              <span className="text-green-600 dark:text-green-300">Copied!</span>
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

