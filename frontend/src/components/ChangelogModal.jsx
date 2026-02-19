import { useState, useEffect, useCallback } from 'react';
import { X, Search, Sparkles, RefreshCw, Bug, Shield, Info } from 'lucide-react';
import { changelog, APP_VERSION } from '../data/changelog';

const TYPE_CONFIG = {
  new: {
    label: 'New',
    icon: Sparkles,
    badgeBg: 'bg-emerald-50',
    badgeText: 'text-emerald-700',
    badgeBorder: 'border-emerald-200',
    pillBg: 'bg-emerald-500',
    dotColor: 'bg-emerald-500',
  },
  improved: {
    label: 'Improved',
    icon: RefreshCw,
    badgeBg: 'bg-blue-50',
    badgeText: 'text-blue-700',
    badgeBorder: 'border-blue-200',
    pillBg: 'bg-blue-500',
    dotColor: 'bg-blue-500',
  },
  fixed: {
    label: 'Fixed',
    icon: Bug,
    badgeBg: 'bg-red-50',
    badgeText: 'text-red-700',
    badgeBorder: 'border-red-200',
    pillBg: 'bg-red-500',
    dotColor: 'bg-red-500',
  },
  security: {
    label: 'Security',
    icon: Shield,
    badgeBg: 'bg-amber-50',
    badgeText: 'text-amber-700',
    badgeBorder: 'border-amber-200',
    pillBg: 'bg-amber-500',
    dotColor: 'bg-amber-500',
  },
};

export default function ChangelogModal({ isOpen, onClose }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState(new Set());

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const toggleFilter = (type) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const filterEntries = (entries) => {
    return entries.filter(entry => {
      const matchesSearch = !searchTerm ||
        entry.text.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesFilter = activeFilters.size === 0 || activeFilters.has(entry.type);
      return matchesSearch && matchesFilter;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden mx-4">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 px-6 py-5 text-white">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                <Info className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold">What&apos;s New in Ticket Pulse</h2>
                <p className="text-blue-200 text-sm">Release History &amp; Changelog</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-white/20 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-6 pt-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search changelog..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
            />
          </div>
        </div>

        {/* Filter Pills */}
        <div className="px-6 pb-3 flex items-center gap-2">
          {Object.entries(TYPE_CONFIG).map(([type, config]) => {
            const Icon = config.icon;
            const isActive = activeFilters.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleFilter(type)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                  isActive
                    ? `${config.badgeBg} ${config.badgeText} ${config.badgeBorder} ring-2 ring-offset-1 ring-${type === 'new' ? 'emerald' : type === 'improved' ? 'blue' : type === 'fixed' ? 'red' : 'amber'}-300`
                    : `bg-white text-gray-600 border-gray-200 hover:bg-gray-50`
                }`}
              >
                <Icon className="w-3 h-3" />
                {config.label}
              </button>
            );
          })}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100" />

        {/* Changelog Entries */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {changelog.map((release) => {
            const filtered = filterEntries(release.entries);
            if (filtered.length === 0) return null;

            return (
              <div key={release.version}>
                {/* Version Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-1 bg-blue-600 text-white text-xs font-bold rounded-lg">
                      v{release.version}
                    </span>
                    {release.version === APP_VERSION && (
                      <span className="text-xs text-gray-400 font-medium">Latest</span>
                    )}
                  </div>
                  <span className="text-sm text-gray-400">{release.date}</span>
                </div>

                {/* Entries */}
                <div className="space-y-2.5 ml-1">
                  {filtered.map((entry, idx) => {
                    const config = TYPE_CONFIG[entry.type];
                    return (
                      <div key={idx} className="flex items-start gap-3 group">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border whitespace-nowrap mt-0.5 ${config.badgeBg} ${config.badgeText} ${config.badgeBorder}`}>
                          <config.icon className="w-3 h-3" />
                          {config.label}
                        </span>
                        <p className="text-sm text-gray-700 leading-relaxed">{entry.text}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Empty State */}
          {changelog.every(r => filterEntries(r.entries).length === 0) && (
            <div className="text-center py-8 text-gray-400">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No entries match your search</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
