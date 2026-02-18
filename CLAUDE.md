# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ticket Pulse** is a real-time IT helpdesk dashboard that provides visibility into FreshService ticket distribution across technicians. The primary user is an IT Coordinator who needs to fairly assign 20-30 tickets daily while balancing workload across ~11 technicians.

**Current Status**: MVP implemented with real-time dashboard, search/filter functionality, and weekly view. Production-ready.

## Tech Stack

**Backend:**
- Node.js 20 LTS + Express.js 4.19+
- Prisma 5.19+ ORM with PostgreSQL 16+
- express-session + connect-pg-simple (auth)
- bcrypt (password hashing)
- Winston (logging)
- Zod (validation)
- node-cron (background jobs)

**Frontend:**
- React 18.3+ with Vite
- Tailwind CSS 3.4+
- Axios for HTTP
- Context API + useReducer (state management)
- Server-Sent Events (SSE) for real-time updates

**Infrastructure:**
- Azure App Service (hosting)
- Azure Database for PostgreSQL
- Azure Key Vault (secrets)
- Application Insights (monitoring)
- GitHub Actions (CI/CD)

## Implemented Features

### Search and Filter System (Completed Oct 2025)
**Dashboard Page:**
- **SearchBox Component**: Real-time search by ticket subject, ID, or requester name
- **CategoryFilter Component**: Multi-select dropdown for filtering by ticket category
- **Dynamic Stats Recalculation**: All stats cards and individual technician metrics update when filtering
- **Session Persistence**: Filters persist in sessionStorage during navigation
- **Weekly View Support**: Full filtering works in both daily and weekly views
- **Daily Breakdown Grid**: Weekly view's Mon-Sun calendar updates with filtered counts

**Technical Implementation:**
- Frontend filtering with dynamic stat recalculation (`recalculateTechStats` helper)
- Backend sends `weeklyTickets` array for weekly view filtering
- Separate handling for `tickets` (daily) vs `weeklyTickets` (weekly) fields
- Defensive programming with explicit existence checks (not truthiness)

**Known Issues to Fix:**
- TechnicianDetail page doesn't receive filtered context when navigating from filtered Dashboard
- TechnicianDetail page lacks search/filter components

### Core Dashboard Features
- **Real-time Updates**: SSE (Server-Sent Events) for live data refresh
- **Daily/Weekly Views**: Toggle between daily and weekly ticket views
- **Self-Picked Detection**: Algorithm identifies tickets picked vs assigned
- **Load Level Indicators**: Visual workload indicators (light/medium/heavy)
- **Compact View Mode**: Space-efficient display option
- **Hidden Technicians**: Ability to hide inactive technicians
- **Date Navigation**: Calendar picker and prev/next navigation
- **Sync Controls**: Manual sync with FreshService API
- **Week Sync**: Backfill historical weeks with real-time progress tracking (8-15 min for ~300 tickets)
- **Progress Tracking**: Real-time sync progress with percentage, step details, and item counts

## Planned Architecture

### Directory Structure
```
ticket-pulse/
├── backend/
│   ├── src/
│   │   ├── app.js              # Express app initialization
│   │   ├── config/             # Configuration management
│   │   ├── controllers/        # Route handlers
│   │   ├── middleware/         # Auth, error handling, logging
│   │   ├── routes/             # API route definitions
│   │   ├── services/           # Business logic & repositories
│   │   └── utils/              # Helpers (logger, timezone utils)
│   ├── prisma/
│   │   ├── schema.prisma       # Database schema
│   │   └── migrations/         # Database migrations
│   └── tests/                  # Jest unit + integration tests
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Main React component
│   │   ├── components/         # Reusable UI components
│   │   ├── pages/              # Page-level components
│   │   ├── hooks/              # Custom hooks (useSSE)
│   │   ├── context/            # Global state (Auth, Dashboard, Settings)
│   │   └── utils/              # API client, formatting helpers
│   └── public/                 # Static assets
└── docs/
    ├── product.md              # Complete PRD (2,551 lines)
    └── todo.md                 # Development tasks (4,024 lines)
```

### Core Data Flow

1. **Background Sync Job** (node-cron, every 30s):
   - Polls FreshService API for tickets and agents
   - Analyzes ticket activities to detect self-picked vs assigned
   - Upserts data into PostgreSQL
   - Broadcasts updates via SSE

2. **Frontend Real-Time Updates**:
   - EventSource connects to `/api/dashboard/stream`
   - Receives SSE updates when data changes
   - React Context updates trigger component re-renders
   - Dashboard reflects changes within 2 seconds

3. **Self-Picked Detection Algorithm**:
   - Fetch ticket activities from FreshService
   - Find first "assigned to technician" activity
   - If performer == assignee → self-picked
   - If performer != assignee → coordinator-assigned

### Key Architectural Patterns

- **Repository Pattern**: Database abstraction (TechnicianRepository, TicketRepository)
- **Service Layer**: Business logic separation (TicketSyncService, TechnicianSyncService)
- **SSE (Server-Sent Events)**: Real-time push updates to frontend (not WebSockets)
- **Context API + useReducer**: Frontend global state management
- **Protected Routes**: Authentication middleware guards all non-public endpoints
- **Scheduled Jobs**: node-cron for background FreshService polling

## Database Schema (Prisma)

### Core Tables
- **technicians**: IT staff (id, freshserviceId, name, email, timezone, location, isActive)
- **tickets**: Help desk tickets (id, freshserviceTicketId, subject, status, priority, assignedTechId, isSelfPicked)
- **ticket_activities**: Assignment audit trail (id, ticketId, activityType, performedBy, performedAt)
- **app_settings**: Configuration key-value store (refreshInterval, defaultTimezone)
- **sync_logs**: Background job execution logs (syncType, status, recordsProcessed, errorMessage)

### Important Relationships
- Tickets → Technicians (many-to-one via assignedTechId)
- Tickets → TicketActivities (one-to-many)
- Indexes on: tickets.status, tickets.assignedTechId, activities.ticketId

## Development Commands

### Backend
```bash
# Development with nodemon auto-reload
npm run dev --prefix backend

# Run tests
npm test --prefix backend

# Run tests with coverage
npm run test:coverage --prefix backend

# Generate Prisma Client (after schema changes)
npx prisma generate --prefix backend

# Create migration
npx prisma migrate dev --name <migration_name> --prefix backend

# Run Prisma Studio (database GUI)
npx prisma studio --prefix backend

# Lint
npm run lint --prefix backend

# Format
npm run format --prefix backend
```

### Frontend
```bash
# Development with Vite HMR
npm run dev --prefix frontend

# Production build
npm run build --prefix frontend

# Preview production build
npm run preview --prefix frontend

# Run tests
npm test --prefix frontend

# Lint
npm run lint --prefix frontend
```

### Full Stack
```bash
# Install all dependencies
npm install && npm install --prefix backend && npm install --prefix frontend

# Run both backend + frontend concurrently
npm run dev

# Run all tests
npm test

# Lint entire project
npm run lint
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with password (body: { password })
- `POST /api/auth/logout` - Logout and destroy session
- `GET /api/auth/check` - Check if user is authenticated

### Dashboard
- `GET /api/dashboard` - Get all technicians with stats (cached 5s)
- `GET /api/dashboard/stream` - SSE stream for real-time updates
- `GET /api/dashboard/technician/:id` - Get technician details + tickets (supports ?date= and ?timezone=)
- `GET /api/dashboard/technician/:id/weekly` - Get technician weekly stats (supports ?weekStart= and ?timezone=)
- `GET /api/dashboard/weekly-stats` - Get weekly calendar day counts

### Sync
- `POST /api/sync/trigger` - Trigger full incremental sync (30s timeout)
- `POST /api/sync/week` - Backfill historical week (15 min timeout, body: { startDate, endDate })
- `GET /api/sync/status` - Get current sync status and progress
- `GET /api/sync/logs` - Get sync execution logs
- `GET /api/sync/stats` - Get sync statistics

### Settings
- `GET /api/settings` - Get application settings
- `PUT /api/settings` - Update settings (body: { refreshInterval, defaultTimezone })

### Health
- `GET /api/health` - Health check (public, checks DB + FreshService API)

All endpoints except `/api/health` require authentication.

## Environment Variables

### Backend (.env)
```
NODE_ENV=development|production
PORT=3000
DATABASE_URL=postgresql://user:pass@host:5432/db
SESSION_SECRET=<random_string>
FRESHSERVICE_API_KEY=<api_key>
FRESHSERVICE_DOMAIN=<domain>.freshservice.com
FRESHSERVICE_WORKSPACE_ID=<workspace_id>
AZURE_KEY_VAULT_URL=https://<vault>.vault.azure.net/
APPLICATION_INSIGHTS_KEY=<insights_key>
ADMIN_PASSWORD_HASH=<bcrypt_hash>
```

### Frontend (.env)
```
VITE_API_URL=http://localhost:3000
```

## Key Implementation Details

### FreshService API Integration
- **Base URL**: `https://<domain>.freshservice.com/api/v2`
- **Auth**: Basic auth with API key (base64-encoded `<api_key>:X`)
- **Rate Limit**: 1 request/second safe threshold (official limit 5000 req/hour but bursts cause 429 errors)
- **Retry Logic**: Exponential backoff (5s, 10s, 20s) for HTTP 429 errors
- **Key Endpoints**:
  - `GET /tickets?workspace_id={id}&include=requester,stats&per_page=100` - Paginated (100/page max)
  - `GET /agents?workspace_id={id}&per_page=100` - Paginated
  - `GET /tickets/{id}/activities` - **No bulk endpoint**, must call per-ticket sequentially
- **Important Limitations**:
  - `updated_since` filter returns ALL tickets updated since that date (no `updated_before` parameter exists)
  - Activities must be fetched individually per ticket (major bottleneck for historical syncs)
  - Pagination required for all list endpoints (100 items per page maximum)

**See SYNC_OPERATIONS.md for detailed API integration guide and best practices.**

### Self-Picked Detection Logic
```javascript
// Pseudocode from PRD
function isSelfPicked(ticket) {
  activities = fetchActivities(ticket.id)
  firstAssignment = activities.find(a =>
    a.action === 'assigned' && a.field === 'agent_id'
  )

  if (!firstAssignment) return false

  performer = firstAssignment.performed_by.id
  assignee = firstAssignment.to_value

  return performer === assignee
}
```

### Workload Calculation
- **Light Load (Green)**: < 5 open tickets
- **Medium Load (Yellow)**: 5-9 open tickets
- **Heavy Load (Red)**: ≥ 10 open tickets

### Caching Strategy
- Dashboard data cached in-memory for 5 seconds
- Background sync every 30 seconds (configurable via settings)
- SSE broadcasts invalidate cache

## Testing Requirements

### Backend Tests
- Unit tests for all services and repositories
- Integration tests for API endpoints
- Mock FreshService API responses
- Test self-picked detection algorithm
- Coverage target: 80%+

### Frontend Tests
- Component tests with React Testing Library
- Hook tests (useSSE)
- Context provider tests
- Integration tests with MSW (Mock Service Worker)
- Accessibility tests (WCAG AA compliance)

## Deployment to Azure

### First-Time Setup
```bash
# 1. Create resource group
az group create --name rg-freshservice-dashboard --location eastus

# 2. Create PostgreSQL server
az postgres server create \
  --resource-group rg-freshservice-dashboard \
  --name pg-freshservice-dashboard \
  --sku-name B_Gen5_1 \
  --version 16

# 3. Create App Service plan
az appservice plan create \
  --resource-group rg-freshservice-dashboard \
  --name asp-freshservice-dashboard \
  --sku B1 --is-linux

# 4. Create web app
az webapp create \
  --resource-group rg-freshservice-dashboard \
  --plan asp-freshservice-dashboard \
  --name app-freshservice-dashboard \
  --runtime "NODE|20-lts"

# 5. Configure deployment from GitHub
az webapp deployment source config \
  --name app-freshservice-dashboard \
  --resource-group rg-freshservice-dashboard \
  --repo-url https://github.com/<org>/<repo> \
  --branch main --manual-integration
```

### CI/CD Pipeline (GitHub Actions)
- Triggers on push to `main` branch
- Runs linting, tests, build
- Deploys backend + frontend to Azure App Service
- Runs Prisma migrations
- Smoke tests health endpoint

## Performance Targets

- **Dashboard Load**: < 2 seconds (first paint)
- **API Response Time**: < 200ms (p95)
- **Data Freshness**: Updates visible within 30 seconds
- **Database Queries**: < 500ms (p95)
- **Uptime**: 99.5% during business hours (8am-6pm PST)

## Security Considerations

- **Authentication**: Single password (bcrypt hashed) for MVP
- **HTTPS Only**: All traffic over SSL/TLS
- **Secrets**: Stored in Azure Key Vault, never in code
- **Sessions**: HTTP-only cookies, 8-hour expiration, secure flag
- **CORS**: Restricted to app domain only
- **SQL Injection**: Prevented by Prisma parameterized queries
- **XSS**: React auto-escapes, CSP headers enforced

## Important Product Constraints

### MVP Scope (Must Have)
- Password-protected login
- Real-time dashboard with all techs + workload breakdown
- Self-picked vs assigned ticket counts
- Click-through to individual tech details
- Settings page (refresh interval, timezone)
- Auto-refresh every 30s
- Timezone support (PST default)

### Explicitly Out of Scope (MVP)
- Multi-user authentication (future Phase 3)
- Historical analytics/trends (future Phase 2)
- Ticket creation/editing (read-only dashboard)
- Mobile responsive design (desktop-first, 1920x1080 target)
- Email notifications
- SLA tracking
- Multi-workspace support

## Success Metrics (30 Days Post-Launch)

- **Efficiency**: Assignment time reduced 70% (2 min → 30 sec)
- **Fairness**: Workload standard deviation reduced 40%
- **Satisfaction**: Coordinator NPS > 8/10
- **Reliability**: Uptime > 99.5%, data accuracy < 1% discrepancy
- **Adoption**: > 90% of assignments use dashboard

## Troubleshooting

### Dashboard shows stale data
1. Check `/api/health` endpoint status
2. Verify FreshService API connection in Application Insights
3. Review `sync_logs` table for recent errors
4. Confirm background job is running (check logs for cron execution)

### Slow performance
1. Check Application Insights for slow queries
2. Verify database connection pool size
3. Review API response times in `/api/dashboard`
4. Check FreshService API rate limiting

### Self-picked counts seem wrong
1. Verify FreshService activities API returns complete data
2. Check `ticket_activities` table for assignment records
3. Review self-picked detection logic in TicketSyncService
4. Compare with manual FreshService UI check

### Week sync failing with 429 errors
1. Check concurrency setting in `syncWeek()` (should be 1, not 3+)
2. Verify retry logic is enabled in `fetchTicketActivities()`
3. Check backend logs for exponential backoff delays (5s, 10s, 20s)
4. Review rate limiting section in SYNC_OPERATIONS.md

### Week sync taking longer than expected
1. Normal timing: 8-15 minutes for 300-400 tickets
2. 79% of time spent on sequential activity fetching (unavoidable)
3. Check progress in backend logs or frontend UI
4. If timeout after 9 minutes, increase frontend timeout to 15 minutes (see `api.js`)

### Historical week showing no data after sync
1. Verify correct week was synced (check backend logs for date range)
2. Check if `handleSyncWeek` uses correct date source (`selectedWeek` in weekly mode)
3. Review SYNC_WEEK_BUG_FIX.md for common date mismatch issues
4. Query database directly to confirm tickets were saved with correct dates

## Key Documentation

- **Sync Operations Guide**: `SYNC_OPERATIONS.md` (11,000+ words, comprehensive sync implementation guide)
- **Product Requirements**: `/docs/product.md` (2,551 lines, comprehensive PRD)
- **Development Tasks**: `/docs/todo.md` (4,024 lines, phase-by-phase breakdown)
- **FreshService API**: https://api.freshservice.com/v2/
- **Prisma Docs**: https://www.prisma.io/docs
- **React Context API**: https://react.dev/reference/react/useContext
- **Server-Sent Events**: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events

## Development Phase Roadmap

- **Phase 0**: Planning & setup (complete)
- **Phase 1**: Backend implementation (weeks 1-2)
- **Phase 2**: Frontend implementation (weeks 2-3)
- **Phase 3**: Integration & testing (week 4)
- **Phase 4**: Deployment & launch (week 5)

Estimated MVP delivery: 5 weeks from project start.
