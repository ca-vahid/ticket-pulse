import { useState, useRef, useEffect } from 'react';
import { Filter, X, ChevronDown } from 'lucide-react';

/**
 * Reusable category filter component with multi-select dropdown
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
  placeholder = 'Filter by category',
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

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Dropdown Button */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm transition-colors ${
            selected.length > 0
              ? 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100'
              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <Filter className="w-4 h-4" />
          <span>{placeholder}</span>
          {selected.length > 0 && (
            <span className="bg-blue-600 text-white text-xs rounded-full px-1.5 py-0.5 font-semibold">
              {selected.length}
            </span>
          )}
          <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Dropdown Menu */}
        {isOpen && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-auto">
            {/* Clear All Button */}
            {selected.length > 0 && (
              <div className="border-b border-gray-200 p-2">
                <button
                  onClick={handleClearAll}
                  className="w-full text-left text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded transition-colors"
                >
                  Clear all filters
                </button>
              </div>
            )}

            {/* Category Checkboxes */}
            <div className="p-2">
              {categories.map((category) => (
                <label
                  key={category}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer transition-colors"
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

      {/* Selected Category Chips */}
      {selected.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {selected.map((category) => (
            <div
              key={category}
              className="flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-medium border border-blue-200"
            >
              <span>{category}</span>
              <button
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
