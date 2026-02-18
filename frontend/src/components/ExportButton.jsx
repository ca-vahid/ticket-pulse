import { useState, useRef, useEffect } from 'react';
import { Download, FileSpreadsheet, FileText, ChevronDown, Loader2 } from 'lucide-react';
import { exportToCSV, exportToXLSX, generateExportFilename } from '../utils/exportUtils';

/**
 * Split export button - main button exports XLSX, dropdown notch offers CSV
 * @param {Array} tickets - Tickets to export
 * @param {Array} technicians - Technician data for export
 * @param {string} viewMode - Current view mode ('daily', 'weekly', 'monthly', or technician name)
 * @param {Date} selectedDate - Selected date (for daily view)
 * @param {Date} selectedWeek - Selected week start (for weekly view)
 * @param {Date} selectedMonth - Selected month (for monthly view)
 * @param {string} className - Additional CSS classes
 */
export default function ExportButton({
  tickets = [],
  technicians = [],
  viewMode = 'daily',
  selectedDate,
  selectedWeek,
  selectedMonth,
  className = '',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const ticketCount = tickets?.length || 0;
  const isDisabled = ticketCount === 0 || isExporting;

  const handleExport = async (format) => {
    if (isDisabled) return;

    setIsExporting(true);
    setIsOpen(false);

    try {
      const filename = generateExportFilename(viewMode, selectedDate, selectedWeek, selectedMonth);

      // Small delay for UI feedback
      await new Promise(resolve => setTimeout(resolve, 100));

      if (format === 'csv') {
        exportToCSV(tickets, technicians, filename);
      } else if (format === 'xlsx') {
        exportToXLSX(tickets, technicians, filename);
      }
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  // Direct XLSX export when clicking main button
  const handleMainClick = () => {
    if (!isDisabled) {
      handleExport('xlsx');
    }
  };

  // Toggle dropdown when clicking the notch
  const handleDropdownClick = (e) => {
    e.stopPropagation();
    if (!isDisabled) {
      setIsOpen(!isOpen);
    }
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Split Button Container - Icon style like other toolbar buttons */}
      <div className="flex items-center">
        {/* Main Export Button (XLSX) - Icon only */}
        <button
          onClick={handleMainClick}
          disabled={isDisabled}
          className={`
            p-1.5 rounded-l transition-colors
            ${isDisabled 
      ? 'text-gray-300 cursor-not-allowed' 
      : 'hover:bg-gray-100 cursor-pointer'
    }
          `}
          title={ticketCount === 0 ? 'No tickets to export' : `Export ${ticketCount} ticket${ticketCount !== 1 ? 's' : ''} as Excel`}
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </button>

        {/* Dropdown Notch - small chevron */}
        <button
          onClick={handleDropdownClick}
          disabled={isDisabled}
          className={`
            p-1 rounded-r transition-colors -ml-1
            ${isDisabled 
      ? 'text-gray-300 cursor-not-allowed' 
      : isOpen
        ? 'bg-gray-100 cursor-pointer'
        : 'hover:bg-gray-100 cursor-pointer'
    }
          `}
          title="More export options"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Dropdown Menu */}
      {isOpen && !isDisabled && (
        <div className="absolute right-0 mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          <button
            onClick={() => handleExport('xlsx')}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-blue-600" />
            <div className="text-left">
              <div className="font-medium">Export as Excel</div>
              <div className="text-xs text-gray-500">{ticketCount} tickets</div>
            </div>
          </button>
          <button
            onClick={() => handleExport('csv')}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <FileText className="w-4 h-4 text-green-600" />
            <div className="text-left">
              <div className="font-medium">Export as CSV</div>
              <div className="text-xs text-gray-500">{ticketCount} tickets</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
