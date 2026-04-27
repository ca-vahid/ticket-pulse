# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**Ticket Pulse** is a real-time FreshService operations dashboard for workload visibility, team-safe analytics, and AI-assisted ticket assignment review. Primary users are IT coordinators and managers who need to balance day-to-day ticket assignment, understand team demand, and review assignment automation outcomes across one or more FreshService workspaces.

**Current Status**: Post-MVP/v2 application. The live repo includes multi-workspace support, daily/weekly/monthly dashboard views, timeline exploration, CSAT, noise filtering, vacation/availability context, AI assignment pipeline review, daily review recommendations, ticket thread caching, assignment episodes/bounce tracking, historical backfills, and Analytics & Insights.

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
- **Daily/Weekly/Monthly Views**: Toggle between daily, weekly, and monthly ticket views
- **Self-Picked Detection**: Algorithm identifies tickets picked vs assigned
- **Load Level Indicators**: Visual workload indicators (light/medium/heavy)
- **Compact View Mode**: Space-efficient display option
- **Hidden Technicians**: Ability to hide inactive technicians
- **Date Navigation**: Calendar picker and prev/next navigation
- **Sync Controls**: Manual sync with FreshService API
- **Week Sync and Backfill**: Backfill historical date ranges with progress tracking
- **Progress Tracking**: Real-time sync progress with percentage, step details, and item counts

### Analytics and Insights
- **Route**: `/analytics`
- **API**: `/api/analytics/*`
- **Approach**: Deterministic, explainable v1 analytics; no LLM summaries, predictions, scheduled reports, or automated remediation.
- **Views**: Overview, Demand & Flow, Team Balance, Quality, Automation Ops, and Insights.
- **Data Rules**:
  - Default range is last 30 days in selected workspace timezone.
  - Resolution analytics use `resolutionTimeSeconds` because it is highly populated.
  - Assignment timing uses `firstAssignedAt`, falling back to `createdAt` only where explicitly labeled.
  - Category analytics use `ticketCategory`; `category`, `subCategory`, `department`, and `internalCategoryId` are sparse.
  - CSAT metrics must show response/sample count because survey coverage is low.
  - First-response analytics are omitted until `firstPublicAgentReplyAt` is populated.
  - People analytics must stay team-safe; avoid public winner/loser leaderboards.

### Assignment Review and Automation
- **Assignment Review**: `/assignments` includes review queue, history, daily review, competencies, prompts, and configuration.
- **Pipeline Storage**: `assignment_pipeline_runs` and `assignment_pipeline_steps` capture AI recommendations, decisions, sync state, errors, tool steps, token usage, and duration telemetry.
- **Daily Review**: `assignment_daily_review_runs`, recommendations, consolidation runs/items/events support day-level review and approval workflows.
- **Ticket Threads**: `ticket_thread_entries` caches FreshService activity/conversation bodies for review evidence.
- **Assignment Episodes**: `ticket_assignment_episodes` tracks ownership windows, reassignments, rejected/bounced tickets, and active ownership state.
- **Noise Filtering**: `noise_rules` and ticket `isNoise` fields identify low-value tickets that should not distort operational metrics.
- **Vacation/Availability**: Vacation Tracker tables and technician schedule fields provide leave/capacity context.

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
- **workspaces / workspace_access**: Multi-workspace scoping and per-workspace access roles.
- **technicians**: Workspace-scoped agent records, including photo, timezone, map visibility, and work schedule fields.
- **requesters**: FreshService requester metadata connected to tickets.
- **tickets**: Main helpdesk record with FreshService IDs, subject/body, status/priority, assignment fields, requester, category/custom category, due dates, resolution timing, CSAT, noise, and bounce counters.
- **ticket_activities**: Assignment/status/group/rejection audit events from FreshService activity streams.
- **ticket_thread_entries**: Cached FreshService activity/conversation/thread content for analysis evidence.
- **ticket_assignment_episodes**: Ownership windows with start/end method, rejected/reassigned tracking, and active ownership state.
- **assignment_pipeline_runs / assignment_pipeline_steps**: AI assignment recommendation, decision, sync, error, and tool-step telemetry.
- **assignment_daily_review_runs / recommendations / consolidation tables**: Daily assignment review outputs, approval state, and consolidation workflow.
- **sync_logs / backfill_runs**: Incremental sync, Vacation Tracker sync, and long-running historical backfill observability.
- **noise_rules**: Workspace-scoped noise matching rules.
- **technician_leaves / Vacation Tracker tables**: Leave and availability context.
- **competency tables**: Internal category taxonomy, technician competencies, prompt versions, analysis and calibration runs.

### Important Relationships
- Tickets → Technicians (many-to-one via assignedTechId)
- Tickets → TicketActivities (one-to-many)
- Tickets → Requesters (many-to-one via requesterId)
- Tickets → AssignmentPipelineRuns / AssignmentEpisodes / TicketThreadEntries
- Workspaces scope all tenant-specific operational tables.
- Analytics caveat: some historical fields are sparse (`assignedAt`, `firstPublicAgentReplyAt`, `department`, `internalCategoryId`), so prefer populated fields documented above.

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
# Install/update frontend dependencies (repo uses pnpm lockfile)
pnpm install --dir frontend

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
- `POST /api/auth/login` - Legacy password login when enabled
- `POST /api/auth/sso` - SSO login with ID token
- `POST /api/auth/logout` - Logout and destroy session
- `GET /api/auth/session` - Check active authenticated session

### Dashboard
- `GET /api/dashboard` - Get all technicians with stats (cached 5s)
- `GET /api/dashboard/weekly` - Weekly dashboard data
- `GET /api/dashboard/monthly` - Monthly dashboard data
- `GET /api/dashboard/technician/:id` - Get technician details + tickets (supports ?date= and ?timezone=)
- `GET /api/dashboard/technician/:id/weekly` - Get technician weekly stats (supports ?weekStart= and ?timezone=)
- `GET /api/dashboard/technician/:id/monthly` - Get technician monthly stats
- `GET /api/dashboard/weekly-stats` - Get weekly calendar day counts
- `GET /api/dashboard/timeline` - Timeline/coverage data
- `GET /api/dashboard/ticket/:id/history` - Ticket ownership/activity history

### Analytics
- `GET /api/analytics/overview` - KPI snapshot, assignment mix, data quality
- `GET /api/analytics/demand-flow` - Created/resolved trend, heatmap, source/category/requester breakdowns
- `GET /api/analytics/team-balance` - Team-safe distribution, load balance, open aging, leave context
- `GET /api/analytics/quality` - Resolution distributions, open aging, CSAT trends/drilldowns
- `GET /api/analytics/automation-ops` - Pipeline funnel, step failures/durations, sync/backfill/daily-review health
- `GET /api/analytics/insights` - Deterministic explainable insight cards
- Common params: `range=7d|30d|90d|12m|custom`, `start`, `end`, `compare=previous|none`, `timezone`, `excludeNoise=true|false`, `groupBy=day|week|month`

### Sync
- `POST /api/sync/trigger` - Trigger full incremental sync (30s timeout)
- `POST /api/sync/week` - Backfill historical week (15 min timeout, body: { startDate, endDate })
- `GET /api/sync/status` - Get current sync status and progress
- `GET /api/sync/logs` - Get sync execution logs
- `GET /api/sync/stats` - Get sync statistics
- `POST /api/sync/backfill` - Start historical backfill
- `GET /api/sync/backfill/current` - Get current backfill
- `GET /api/sync/backfill/history` - Get past backfill runs
- `POST /api/sync/backfill/:id/cancel` - Cancel running backfill

### Workspace, Assignment, Visuals, and Integrations
- `GET/POST/PUT /api/workspaces*` - Workspace selection, discovery, activation, and access management
- `GET/POST/PUT/DELETE /api/assignment*` - Review queue, assignment runs, prompt management, competencies, daily review, and consolidation workflows
- `GET/PATCH/POST /api/visuals*` - Agent map/location/visibility/schedule data
- `GET/POST/PUT /api/vacation-tracker*` - Vacation Tracker config, sync, leave types, and user mappings
- `GET/POST/PUT/DELETE /api/noise-rules*` - Noise rule management, test, seed, and backfill
- `GET/POST /api/autoresponse*` - Auto-response tooling
- `GET /api/sse/events` - SSE stream for real-time updates

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

### Still Out of Scope / Treat Carefully
- Ticket creation/editing remains out of scope; Ticket Pulse is still read-heavy for FreshService ticket operations except approved assignment sync actions.
- Predictive ML and LLM-generated analytics summaries are out of scope for Analytics v1.
- Scheduled analytics report delivery is deferred.
- Historical first-response analytics should not be claimed until `firstPublicAgentReplyAt` is populated.
- Public technician leaderboards are intentionally avoided; frame people metrics as team balance and coaching signals.

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

## Current Roadmap Notes

- The original MVP phase roadmap is complete and stale; do not treat it as the live implementation plan.
- Analytics & Insights v1 is implemented as deterministic live aggregation at `/analytics`.
- Future analytics work should focus on scheduled exports, materialized snapshots only if live aggregation becomes too slow, and first-response analytics after source data is populated.
- Keep AGENTS.md synchronized when new major surfaces are added; this repo evolves quickly and old MVP assumptions are actively misleading.
