import { useState, useRef, useEffect } from 'react';
import { Filter, X, ChevronDown } from 'lucide-react';

/**
 * Reusable category filter component with multi-select dropdown.
 * Trigger is a pill with a circular icon badge — matches the visual
 * language of the "Timeline Explorer" / "Assignment" buttons in the page
 * header so filter controls feel consistent.
 *
 * @param {Array<string>} categories - Available categories
 * @param {Array<string>} selected - Currently selected categories
 * @param {function} onChange - Callback when selection changes (receives array of selected categories)
 * @param {string} placeholder - Dropdown button text
 * @param {string} className - Additional CSS classes
 */
export default function CategoryFilter({
  categories = [],
  selected = [],
  onChange,
  placeholder = 'Category',
  className = '',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleToggleCategory = (category) => {
    if (selected.includes(category)) {
      onChange(selected.filter(c => c !== category));
    } else {
      onChange([...selected, category]);
    }
  };

  const handleClearAll = () => {
    onChange([]);
    setIsOpen(false);
  };

  const handleRemoveCategory = (category) => {
    onChange(selected.filter(c => c !== category));
  };

  // If no categories available, don't render
  if (categories.length === 0) {
    return null;
  }

  const hasSelection = selected.length > 0;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Pill-style trigger with circular icon badge — matches Timeline / Assignment buttons */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`group flex items-center gap-1.5 pl-1.5 pr-3 py-1.5 rounded-full text-xs font-semibold transition-all border whitespace-nowrap ${
            hasSelection
              ? 'border-blue-300 bg-blue-100 text-blue-800 hover:bg-blue-200 hover:border-blue-400 hover:shadow-sm'
              : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 hover:shadow-sm'
          }`}
          title={hasSelection ? `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'} selected` : 'Filter by category'}
        >
          <span className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center group-hover:bg-blue-700 transition-colors flex-shrink-0">
            <Filter className="w-3 h-3 text-white" />
          </span>
          <span>{placeholder}</span>
          {hasSelection && (
            <span className="bg-blue-600 text-white text-[10px] leading-none rounded-full px-1.5 py-0.5 font-bold">
              {selected.length}
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Dropdown Menu */}
        {isOpen && (
          <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 min-w-[220px] max-h-[320px] overflow-auto">
            {hasSelection && (
              <div className="border-b border-gray-200 p-2 sticky top-0 bg-white">
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="w-full text-left text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded transition-colors font-medium"
                >
                  Clear all filters
                </button>
              </div>
            )}

            <div className="p-2">
              {categories.map((category) => (
                <label
                  key={category}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-blue-50 rounded cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(category)}
                    onChange={() => handleToggleCategory(category)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">{category}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Selected category chips — only render when there's space; on the
          tight merged row this can wrap below if needed */}
      {hasSelection && (
        <div className="flex items-center gap-1 flex-wrap">
          {selected.map((category) => (
            <div
              key={category}
              className="flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full text-[11px] font-medium border border-blue-200"
            >
              <span>{category}</span>
              <button
                type="button"
                onClick={() => handleRemoveCategory(category)}
                className="hover:text-blue-900 transition-colors"
                title={`Remove ${category} filter`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
