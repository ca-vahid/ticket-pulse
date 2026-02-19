/**
 * Export utilities for tickets data
 * Supports CSV and rich XLSX (Excel) export with formatting
 */

import * as XLSX from 'xlsx';

/**
 * Priority labels for display
 */
const PRIORITY_LABELS = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

/**
 * Format a date for export (ISO format or empty string)
 */
const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Format a datetime for export (ISO format with time)
 */
const formatDateTime = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

/**
 * Format resolution time from seconds to human-readable
 */
const formatResolutionTime = (seconds) => {
  if (!seconds || seconds === 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/**
 * Format time spent from minutes to human-readable
 */
const formatTimeSpent = (minutes) => {
  if (!minutes || minutes === 0) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
};

/**
 * Transform tickets into flat export rows
 * @param {Array} tickets - Array of ticket objects
 * @param {Array} technicians - Array of technician objects (for name lookup)
 * @returns {Array} Array of flat row objects for export
 */
export const formatTicketsForExport = (tickets, technicians = []) => {
  if (!tickets || tickets.length === 0) return [];

  // Build technician lookup map
  const techMap = new Map();
  technicians.forEach(tech => {
    if (tech && tech.id) {
      techMap.set(tech.id, tech.name);
    }
  });

  return tickets.map(ticket => {
    // Get technician name from ticket or lookup
    const techName = ticket.technicianName || 
                     ticket.assignedTechName || 
                     (ticket.assignedTechId ? techMap.get(ticket.assignedTechId) : '') ||
                     '';

    // Column order: Ticket ID, Requester Name, Subject, then rest
    return {
      'Ticket ID': ticket.freshserviceTicketId || '',
      'Requester': ticket.requesterName || '',
      'Subject': ticket.subject || '',
      'Description': ticket.descriptionText || ticket.description || '',
      'Status': ticket.status || '',
      'Priority': PRIORITY_LABELS[ticket.priority] || ticket.priority || '',
      'Technician': techName,
      'Category': ticket.ticketCategory || '',
      'Location': ticket.department || '',
      'Created': formatDateTime(ticket.createdAt),
      'First Assigned': formatDateTime(ticket.firstAssignedAt),
      'Closed': formatDateTime(ticket.closedAt || ticket.resolvedAt),
      'Self-Picked': ticket.isSelfPicked ? 'Yes' : 'No',
      'Assigned By': ticket.assignedBy || '',
      'Resolution Time': formatResolutionTime(ticket.resolutionTimeSeconds),
      'Time Spent': formatTimeSpent(ticket.timeSpentMinutes),
      'Requester Email': ticket.requesterEmail || '',
      'CSAT': ticket.csatScore !== null && ticket.csatScore !== undefined 
        ? `${ticket.csatScore}/${ticket.csatTotalScore || 4}` 
        : '',
      'CSAT Feedback': ticket.csatFeedback || '',
    };
  });
};

/**
 * Build summary statistics from tickets
 * @param {Array} tickets - Array of ticket objects
 * @param {Array} technicians - Array of technician objects
 * @returns {Array} Array of summary row objects
 */
export const buildSummaryData = (tickets, _technicians = []) => {
  if (!tickets || tickets.length === 0) {
    return [{ 'Metric': 'No tickets to summarize', 'Value': '' }];
  }

  const summary = [];

  // Date range
  const dates = tickets
    .map(t => new Date(t.createdAt))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);
  
  if (dates.length > 0) {
    summary.push({ 'Metric': 'Date Range', 'Value': `${formatDate(dates[0])} to ${formatDate(dates[dates.length - 1])}` });
  }

  // Total tickets
  summary.push({ 'Metric': 'Total Tickets', 'Value': tickets.length });

  // By status
  summary.push({ 'Metric': '', 'Value': '' }); // Empty row
  summary.push({ 'Metric': 'BY STATUS', 'Value': '' });
  const statusCounts = {};
  tickets.forEach(t => {
    const status = t.status || 'Unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  Object.entries(statusCounts).forEach(([status, count]) => {
    summary.push({ 'Metric': `  ${status}`, 'Value': count });
  });

  // By priority
  summary.push({ 'Metric': '', 'Value': '' });
  summary.push({ 'Metric': 'BY PRIORITY', 'Value': '' });
  const priorityCounts = {};
  tickets.forEach(t => {
    const priority = PRIORITY_LABELS[t.priority] || 'Unknown';
    priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;
  });
  Object.entries(priorityCounts).forEach(([priority, count]) => {
    summary.push({ 'Metric': `  ${priority}`, 'Value': count });
  });

  // Self-picked vs Assigned
  summary.push({ 'Metric': '', 'Value': '' });
  summary.push({ 'Metric': 'ASSIGNMENT', 'Value': '' });
  const selfPicked = tickets.filter(t => t.isSelfPicked).length;
  const assigned = tickets.length - selfPicked;
  summary.push({ 'Metric': '  Self-Picked', 'Value': selfPicked });
  summary.push({ 'Metric': '  Assigned', 'Value': assigned });
  const selfPickPct = tickets.length > 0 ? Math.round((selfPicked / tickets.length) * 100) : 0;
  summary.push({ 'Metric': '  Self-Pick Rate', 'Value': `${selfPickPct}%` });

  // CSAT
  const csatTickets = tickets.filter(t => t.csatScore !== null && t.csatScore !== undefined);
  if (csatTickets.length > 0) {
    summary.push({ 'Metric': '', 'Value': '' });
    summary.push({ 'Metric': 'CSAT', 'Value': '' });
    summary.push({ 'Metric': '  Responses', 'Value': csatTickets.length });
    const avgScore = csatTickets.reduce((sum, t) => sum + t.csatScore, 0) / csatTickets.length;
    summary.push({ 'Metric': '  Average Score', 'Value': avgScore.toFixed(2) });
  }

  // By technician (if multiple)
  const techTickets = {};
  tickets.forEach(t => {
    const techName = t.technicianName || t.assignedTechName || 'Unassigned';
    techTickets[techName] = (techTickets[techName] || 0) + 1;
  });
  
  if (Object.keys(techTickets).length > 1) {
    summary.push({ 'Metric': '', 'Value': '' });
    summary.push({ 'Metric': 'BY TECHNICIAN', 'Value': '' });
    Object.entries(techTickets)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tech, count]) => {
        summary.push({ 'Metric': `  ${tech}`, 'Value': count });
      });
  }

  return summary;
};

/**
 * Export tickets to CSV format
 * @param {Array} tickets - Array of ticket objects
 * @param {Array} technicians - Array of technician objects
 * @param {string} filename - Filename without extension
 */
export const exportToCSV = (tickets, technicians, filename) => {
  const data = formatTicketsForExport(tickets, technicians);
  if (data.length === 0) {
    alert('No tickets to export');
    return;
  }

  // Create worksheet and workbook
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tickets');

  // Generate CSV and download
  XLSX.writeFile(wb, `${filename}.csv`, { bookType: 'csv' });
};

/**
 * Apply conditional formatting styles to cells
 * Note: xlsx library has limited styling support in the free version
 * We'll use cell comments and formatting where possible
 */
const applyConditionalFormatting = (ws, data) => {
  // Get column indexes
  const headers = Object.keys(data[0] || {});
  headers.indexOf('Status');
  headers.indexOf('Priority');
  
  // xlsx free version doesn't support full conditional formatting
  // But we can set column widths for better readability
  const colWidths = headers.map(h => {
    if (h === 'Description') return { wch: 60 };
    if (h === 'Subject') return { wch: 50 };
    if (h === 'CSAT Feedback') return { wch: 40 };
    if (h === 'Requester Email') return { wch: 30 };
    if (h === 'Requester') return { wch: 22 };
    if (h === 'Technician') return { wch: 20 };
    if (h === 'Category') return { wch: 18 };
    if (h === 'Location') return { wch: 18 };
    if (h === 'Ticket ID') return { wch: 10 };
    if (h === 'Created' || h === 'Closed' || h === 'First Assigned') return { wch: 18 };
    return { wch: 12 };
  });
  ws['!cols'] = colWidths;
};

/**
 * Export tickets to XLSX format with rich features
 * @param {Array} tickets - Array of ticket objects
 * @param {Array} technicians - Array of technician objects
 * @param {string} filename - Filename without extension
 * @param {Object} options - Export options
 */
export const exportToXLSX = (tickets, technicians, filename, _options = {}) => {
  const data = formatTicketsForExport(tickets, technicians);
  if (data.length === 0) {
    alert('No tickets to export');
    return;
  }

  // Sort by technician for grouping
  data.sort((a, b) => {
    const techA = a['Technician'] || '';
    const techB = b['Technician'] || '';
    return techA.localeCompare(techB);
  });

  // Create workbook
  const wb = XLSX.utils.book_new();

  // Sheet 1: Tickets with data
  const wsTickets = XLSX.utils.json_to_sheet(data);
  
  // Apply column widths
  applyConditionalFormatting(wsTickets, data);

  // Add auto-filter
  const headers = Object.keys(data[0] || {});
  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  const lastRow = data.length + 1; // +1 for header row
  wsTickets['!autofilter'] = { ref: `A1:${lastCol}${lastRow}` };

  XLSX.utils.book_append_sheet(wb, wsTickets, 'Tickets');

  // Sheet 2: Summary
  const summaryData = buildSummaryData(tickets, technicians);
  const wsSummary = XLSX.utils.json_to_sheet(summaryData);
  wsSummary['!cols'] = [{ wch: 25 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // Generate XLSX and download
  XLSX.writeFile(wb, `${filename}.xlsx`, { 
    bookType: 'xlsx',
    bookSST: false,
    type: 'binary',
  });
};

/**
 * Generate a unique suffix for filenames (time-based + random chars)
 * Format: HHmmss-XXXXX (e.g., 143527-a7b2c)
 */
const generateUniqueSuffix = () => {
  const now = new Date();
  const timeStr = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  
  // Add 5 random alphanumeric characters for extra uniqueness
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomStr = '';
  for (let i = 0; i < 5; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return `${timeStr}-${randomStr}`;
};

/**
 * Generate filename based on view and date
 * @param {string} viewMode - 'daily', 'weekly', 'monthly', or technician name
 * @param {Date} selectedDate - Selected date
 * @param {Date} selectedWeek - Selected week start (for weekly view)
 * @param {Date} selectedMonth - Selected month (for monthly view)
 * @returns {string} Filename without extension
 */
export const generateExportFilename = (viewMode, selectedDate, selectedWeek, selectedMonth) => {
  const formatDateStr = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const formatMonthStr = (d) => {
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).replace(' ', '-');
  };

  const formatWeekStr = (weekStart) => {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    return `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}-${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`.replace(/\s+/g, '');
  };

  const uniqueSuffix = generateUniqueSuffix();

  switch (viewMode) {
  case 'daily':
    return `tickets-daily-${formatDateStr(selectedDate || new Date())}_${uniqueSuffix}`;
  case 'weekly':
    return `tickets-weekly-${formatWeekStr(selectedWeek || new Date())}_${uniqueSuffix}`;
  case 'monthly':
    return `tickets-monthly-${formatMonthStr(selectedMonth || new Date())}_${uniqueSuffix}`;
  default: {
    // Technician name or other custom view
    const safeName = viewMode.replace(/[^a-zA-Z0-9]/g, '');
    return `tickets-${safeName}-${formatDateStr(new Date())}_${uniqueSuffix}`;
  }
  }
};

export default {
  formatTicketsForExport,
  buildSummaryData,
  exportToCSV,
  exportToXLSX,
  generateExportFilename,
};

