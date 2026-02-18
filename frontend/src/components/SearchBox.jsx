import { Search, X } from 'lucide-react';

/**
 * Reusable search box component
 * @param {string} value - Current search term
 * @param {function} onChange - Callback when search term changes
 * @param {string} placeholder - Input placeholder text
 * @param {number|null} resultsCount - Number of results (null to hide count)
 * @param {string} className - Additional CSS classes
 */
export default function SearchBox({
  value = '',
  onChange,
  placeholder = 'Search tickets...',
  resultsCount = null,
  className = '',
}) {
  const handleClear = () => {
    onChange('');
  };

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Search Input */}
      <div className="flex-1 relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Search className="w-4 h-4 text-gray-400" />
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {value && (
          <button
            onClick={handleClear}
            className="absolute inset-y-0 right-0 pr-3 flex items-center hover:text-gray-700 text-gray-400 transition-colors"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Results Count */}
      {resultsCount !== null && value && (
        <div className="text-sm text-gray-600 whitespace-nowrap">
          {resultsCount === 0 ? (
            <span className="text-red-600 font-medium">No results</span>
          ) : (
            <span className="text-blue-600 font-medium">
              {resultsCount} {resultsCount === 1 ? 'result' : 'results'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
