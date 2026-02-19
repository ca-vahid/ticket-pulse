export const APP_VERSION = '1.0.0';

export const changelog = [
  {
    version: '1.0.0',
    date: 'February 18, 2026',
    entries: [
      { type: 'new', text: 'Real-time IT helpdesk dashboard with SSE live updates' },
      { type: 'new', text: 'Daily, weekly, and monthly ticket views with calendar navigation' },
      { type: 'new', text: 'Self-picked vs assigned ticket detection algorithm' },
      { type: 'new', text: 'Smart search with OR/AND operators and category filtering' },
      { type: 'new', text: 'Azure AD SSO authentication replacing password login' },
      { type: 'new', text: 'Azure deployment with App Service, Static Web Apps, and PostgreSQL' },
      { type: 'new', text: 'GitHub Actions CI/CD for automated backend and frontend deployments' },
      { type: 'new', text: 'Profile photo sync from Azure AD (Entra ID)' },
      { type: 'new', text: 'CSAT score tracking with feedback display' },
      { type: 'new', text: 'Technician map visualization page' },
      { type: 'new', text: 'Excel/XLSX ticket export with formatting' },
      { type: 'new', text: 'LLM-powered auto-response configuration panel' },
      { type: 'improved', text: 'Activity analysis progress logging every 50 tickets during sync' },
      { type: 'improved', text: 'Compact and grid view modes for technician cards' },
      { type: 'fixed', text: 'Timezone bug causing tomorrow\'s tickets to appear in Pacific evening' },
      { type: 'fixed', text: 'SPA routing 404 on page refresh with staticwebapp.config.json' },
      { type: 'fixed', text: 'Cross-origin session cookies for Static Web App to App Service' },
      { type: 'fixed', text: 'Database schema drift resolved with catch-all migration' },
      { type: 'fixed', text: 'Photo sync using incorrect API base URL on production' },
    ],
  },
];
