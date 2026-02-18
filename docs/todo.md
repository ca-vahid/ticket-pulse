\# FreshService Dashboard - Development To-Do List

\## Multi-Phase Implementation Plan



\*\*Project:\*\* FreshService Real-Time IT Dashboard

\*\*Timeline:\*\* 5 weeks (MVP) + ongoing enhancements

\*\*Team:\*\* Development Team

\*\*Created:\*\* October 17, 2025

\*\*Last Updated:\*\* October 18, 2025



---

## ✅ Recently Completed (October 28, 2024)

### Major Improvements - Code Quality & Data Accuracy

- [x] **Sync Service Refactor** - Eliminated 400 lines of duplicated code (49% reduction)
  - Extracted 5 core private methods as single source of truth
  - `_prepareTicketsForDatabase()` - Transform and map technician IDs
  - `_analyzeTicketActivities()` - Batch analyze with rate limiting
  - `_updateTicketsWithAnalysis()` - Update self-picked/assigned data
  - `_upsertTickets()` - Safe database upserts
  - `_buildSyncFilters()` - Consistent API filters
  - **Impact**: All sync methods (syncTickets, syncWeek, backfillPickupTimes) now use identical core logic
  - **File**: `backend/src/services/syncService.js` - 819 lines → 550 lines (33% reduction)

- [x] **Ticket Mapping Issue Fix** - Fixed 748 historical tickets with NULL assignedTechId
  - Root cause: `syncWeek()` was missing technician ID mapping step
  - Created one-time repair script: `backend/repair-unmapped-tickets.js`
  - **Results**: Aug 25-31 week increased from 27 to 354 tickets (13x improvement)
  - Fixed 190 tickets with valid responders, 558 genuinely unassigned
  - **Impact**: Historical weeks now show correct ticket counts

- [x] **Calendar Count Fix** - Standardized date field usage across endpoints
  - Root cause: Calendar used `createdAt`, technician breakdown used `firstAssignedAt`
  - 88 tickets (24%) created on different day than assigned, causing discrepancies
  - **Solution**: Both now use `firstAssignedAt` (with `createdAt` fallback)
  - **File**: `backend/src/routes/dashboard.routes.js` - `/weekly-stats` endpoint
  - **Results**: Calendar day totals now exactly match sum of technician counts

### Frontend UX Improvements

- [x] **Smart View Mode Transitions** - Preserve historical context when switching views
  - Weekly → Daily: Shows matching day of week from selected historical week
  - Daily → Weekly: Shows week containing selected date
  - **File**: `frontend/src/pages/Dashboard.jsx` - Added `handleSwitchToDaily()` and `handleSwitchToWeekly()`

- [x] **localStorage Persistence** - Selected date/week/view survives browser refresh
  - Automatically saves `dashboardSelectedDate`, `dashboardSelectedWeek`, `dashboardViewMode`
  - Works across browser refreshes, crashes, and navigation
  - **File**: `frontend/src/pages/Dashboard.jsx` - Added 3 useEffect hooks for auto-save

### Documentation & Cleanup

- [x] **Consolidated Documentation** - Created `CHANGELOG.md` with all improvements
- [x] **Cleaned Up MD Files** - Removed 4 individual improvement docs, kept consolidated version
- [x] **Updated README** - Added CHANGELOG.md reference

### Diagnostic Tools Created

- `backend/repair-unmapped-tickets.js` - One-time historical data repair
- `backend/analyze-date-fields.js` - Date field analysis
- `backend/verify-calendar-counts.js` - Verification script
- `backend/count-unmapped.js` - Count unmapped tickets

**See [CHANGELOG.md](../CHANGELOG.md) for detailed documentation of all improvements.**

---

## ✅ Completed (October 18, 2025)

### Backend Enhancements
- [x] **Incremental Background Sync** - Only fetches tickets updated since last sync (5-min buffer)
- [x] **FreshService API Rate Limiting** - 1.1s delay between requests to prevent HTTP 429 errors
- [x] **Extended API Timeouts** - 5-minute timeout for sync operations
- [x] **Sync Progress Tracking** - Real-time progress updates broadcast via SSE

### Frontend UI/UX Improvements
- [x] **Compact View Mode** - Toggle between Normal (2-3 techs visible) and Compact (6-8 techs visible)
  - Smaller circles, reduced padding, smaller text
  - Preference persisted in localStorage
- [x] **Load Level Grouping** - Technicians grouped by Heavy/Medium/Light workload
  - Collapsible sections (Light collapsed by default)
  - Section state persisted in localStorage
- [x] **Ultra-Compact Header** - Single-row grid layout (~40% height reduction)
- [x] **Ultra-Compact Banner** - All stats in one row (~80% height reduction)
- [x] **Day-of-Week Navigation** - Clickable Mon-Sun buttons to jump within current week
- [x] **Date Persistence** - "Back to Dashboard" preserves selected date instead of resetting to today
- [x] **Sync Progress Logging** - Expandable "Sync Details" panel with color-coded logs
- [x] **Background Sync Awareness** - Manual sync button greys out when background sync running

### Performance Improvements
- Sync time reduced from 2-5 minutes to 2-5 seconds (~95% reduction)
- Dashboard vertical space reduced by ~71% (450px → 130px)
- Eliminated API timeout and rate limit errors

---



\## Quick Reference - Phase Overview



| Phase | Duration | Focus | Status |

|-------|----------|-------|--------|

| \*\*Phase 0\*\* | Week 1 (Days 1-3) | Infrastructure Setup | ⏸️ Not Started |

| \*\*Phase 1\*\* | Week 1-2 (Days 4-10) | Backend Development | ⏸️ Not Started |

| \*\*Phase 2\*\* | Week 2-3 (Days 11-17) | Frontend Development | ⏸️ Not Started |

| \*\*Phase 3\*\* | Week 3-4 (Days 18-24) | Integration \& Testing | ⏸️ Not Started |

| \*\*Phase 4\*\* | Week 4-5 (Days 25-30) | Deployment \& Launch | ⏸️ Not Started |

| \*\*Phase 5\*\* | Post-Launch | Future Enhancements | ⏸️ Not Started |



---



\# PHASE 0: Infrastructure Setup \& Project Initialization

\*\*Duration:\*\* Days 1-3 (3 days)  

\*\*Goal:\*\* Set up all infrastructure, tooling, and project scaffolding



\## 0.1 Azure Infrastructure Provisioning



\### 0.1.1 Resource Group Setup

\- \[ ] Create Azure Resource Group: `rg-freshservice-dashboard-prod`

\- \[ ] Create Azure Resource Group: `rg-freshservice-dashboard-dev` (for development/staging)

\- \[ ] Document resource group naming conventions

\- \[ ] Set up resource tags (environment, project, cost-center)



\### 0.1.2 Azure Database for PostgreSQL

\- \[ ] Provision Azure Database for PostgreSQL (Flexible Server)

&nbsp; - Name: `psql-freshservice-dashboard-prod`

&nbsp; - Tier: Basic (1 vCore, 2GB RAM) or General Purpose

&nbsp; - Region: Same as App Service

&nbsp; - PostgreSQL Version: 16

\- \[ ] Configure firewall rules (allow Azure services)

\- \[ ] Create database: `freshservice\_dashboard`

\- \[ ] Create database user with appropriate permissions

\- \[ ] Enable automated backups (7-day retention)

\- \[ ] Test connection from local machine

\- \[ ] Document connection string format



\### 0.1.3 Azure App Service

\- \[ ] Create App Service Plan: `asp-freshservice-dashboard`

&nbsp; - OS: Linux

&nbsp; - Runtime: Node 20 LTS

&nbsp; - Tier: B1 (Basic) for staging, P1V2 for production

\- \[ ] Create App Service: `app-freshservice-dashboard-prod`

\- \[ ] Enable "Always On" setting

\- \[ ] Enable HTTPS only

\- \[ ] Configure custom domain (if applicable)

\- \[ ] Set up deployment slots (staging, production)



\### 0.1.4 Azure Key Vault

\- \[ ] Create Key Vault: `kv-freshservice-dashboard`

\- \[ ] Configure access policies (App Service managed identity)

\- \[ ] Add secrets:

&nbsp; - `FreshServiceApiKey` (get from IT Manager)

&nbsp; - `DashboardPassword` (bcrypt hash)

&nbsp; - `SessionSecret` (generate random 32-byte string)

&nbsp; - `DatabaseConnectionString`

\- \[ ] Test secret retrieval from local environment

\- \[ ] Document secret naming conventions



\### 0.1.5 Application Insights

\- \[ ] Create Application Insights: `appi-freshservice-dashboard`

\- \[ ] Get instrumentation key / connection string

\- \[ ] Configure log retention (90 days)

\- \[ ] Set up basic alerts:

&nbsp; - Server response time > 2s

&nbsp; - Failed requests > 5%

&nbsp; - Exception rate spike



\### 0.1.6 FreshService API Configuration

\- \[ ] Get FreshService API key from IT Manager

\- \[ ] Document FreshService domain: `yourcompany.freshservice.com`

\- \[ ] Get IT workspace ID from FreshService admin

\- \[ ] Test API access with Postman:

&nbsp; - GET `/api/v2/tickets`

&nbsp; - GET `/api/v2/agents`

&nbsp; - GET `/api/v2/ticket\_activities`

\- \[ ] Document API rate limits (5000/hour on Enterprise plan)

\- \[ ] Verify workspace filtering works correctly



\*\*Acceptance Criteria:\*\*

\- All Azure resources provisioned and accessible

\- Database connection successful

\- FreshService API calls return valid data

\- Key Vault secrets accessible

\- Cost estimate validated (~$100-150/month)



---



\## 0.2 Project Setup \& Repository



\### 0.2.1 Git Repository

\- \[ ] Create GitHub repository: `freshservice-dashboard`

\- \[ ] Initialize with README.md

\- \[ ] Set up branch protection rules (main branch)

\- \[ ] Create branches: `develop`, `staging`, `production`

\- \[ ] Add .gitignore for Node.js projects

\- \[ ] Add LICENSE file (if applicable)



\### 0.2.2 Project Structure

\- \[ ] Create root directory structure:

```

freshservice-dashboard/

├── backend/

│   ├── src/

│   │   ├── config/

│   │   ├── controllers/

│   │   ├── middleware/

│   │   ├── routes/

│   │   ├── services/

│   │   ├── utils/

│   │   └── app.js

│   ├── prisma/

│   │   ├── schema.prisma

│   │   └── migrations/

│   ├── tests/

│   ├── package.json

│   └── .env.example

├── frontend/

│   ├── src/

│   │   ├── components/

│   │   ├── pages/

│   │   ├── hooks/

│   │   ├── context/

│   │   ├── utils/

│   │   └── App.jsx

│   ├── public/

│   ├── package.json

│   └── vite.config.js

├── docs/

│   ├── PRD.md

│   ├── API.md

│   └── DEPLOYMENT.md

├── .github/

│   └── workflows/

│       └── deploy.yml

├── docker-compose.yml (for local dev)

├── package.json (root)

└── README.md

```



\### 0.2.3 Backend Initialization

\- \[ ] Initialize Node.js project in `/backend`

```bash

cd backend

npm init -y

```

\- \[ ] Install core dependencies:

```bash

npm install express prisma @prisma/client axios bcrypt express-session connect-pg-simple winston node-cron dotenv cors helmet

```

\- \[ ] Install dev dependencies:

```bash

npm install --save-dev nodemon jest supertest eslint prettier @types/node

```

\- \[ ] Create `.env.example` with all required environment variables

\- \[ ] Set up ESLint configuration (Airbnb style guide)

\- \[ ] Set up Prettier configuration

\- \[ ] Add npm scripts to package.json:

&nbsp; - `start`: Production server

&nbsp; - `dev`: Development with nodemon

&nbsp; - `test`: Run Jest tests

&nbsp; - `lint`: ESLint check

&nbsp; - `format`: Prettier format



\### 0.2.4 Frontend Initialization

\- \[ ] Initialize React project with Vite in `/frontend`

```bash

cd frontend

npm create vite@latest . -- --template react

```

\- \[ ] Install core dependencies:

```bash

npm install axios react-router-dom date-fns date-fns-tz lucide-react

```

\- \[ ] Install Tailwind CSS:

```bash

npm install -D tailwindcss postcss autoprefixer

npx tailwindcss init -p

```

\- \[ ] Install dev dependencies:

```bash

npm install --save-dev @testing-library/react @testing-library/jest-dom vitest

```

\- \[ ] Configure Tailwind CSS in `tailwind.config.js`

\- \[ ] Set up ESLint for React

\- \[ ] Add npm scripts:

&nbsp; - `dev`: Vite dev server

&nbsp; - `build`: Production build

&nbsp; - `preview`: Preview production build

&nbsp; - `test`: Run Vitest



\### 0.2.5 Development Tools

\- \[ ] Set up Husky for git hooks

\- \[ ] Configure pre-commit hook (lint + format)

\- \[ ] Set up Docker Compose for local PostgreSQL:

```yaml

version: '3.8'

services:

&nbsp; postgres:

&nbsp;   image: postgres:16

&nbsp;   environment:

&nbsp;     POSTGRES\_DB: freshservice\_dashboard

&nbsp;     POSTGRES\_USER: dev

&nbsp;     POSTGRES\_PASSWORD: devpassword

&nbsp;   ports:

&nbsp;     - "5432:5432"

&nbsp;   volumes:

&nbsp;     - postgres\_data:/var/lib/postgresql/data

```

\- \[ ] Create `.env.development` for local development

\- \[ ] Test Docker Compose setup



\### 0.2.6 Documentation

\- \[ ] Copy PRD.md to `/docs`

\- \[ ] Create README.md with:

&nbsp; - Project overview

&nbsp; - Setup instructions

&nbsp; - Development workflow

&nbsp; - Environment variables reference

\- \[ ] Create CONTRIBUTING.md with:

&nbsp; - Code style guide

&nbsp; - Git workflow (branching strategy)

&nbsp; - PR template

\- \[ ] Create API.md placeholder (will be filled during backend dev)



\*\*Acceptance Criteria:\*\*

\- Repository initialized with proper structure

\- All dependencies installed

\- Linting and formatting configured

\- Local development environment works (Docker + PostgreSQL)

\- Team can clone and run locally



---



\## 0.3 Database Schema Setup



\### 0.3.1 Prisma Initialization

\- \[ ] Initialize Prisma in `/backend/prisma`

```bash

cd backend

npx prisma init

```

\- \[ ] Configure DATABASE\_URL in `.env`

\- \[ ] Copy Prisma schema from PRD to `schema.prisma`:

&nbsp; - Technician model

&nbsp; - Ticket model

&nbsp; - TicketActivity model

&nbsp; - AppSettings model

&nbsp; - SyncLog model



\### 0.3.2 Database Migrations

\- \[ ] Create initial migration:

```bash

npx prisma migrate dev --name init

```

\- \[ ] Verify migration files created in `/prisma/migrations`

\- \[ ] Run migration against local PostgreSQL

\- \[ ] Generate Prisma Client:

```bash

npx prisma generate

```

\- \[ ] Test Prisma Client in Node REPL



\### 0.3.3 Seed Data (Optional for Testing)

\- \[ ] Create `/backend/prisma/seed.js`

\- \[ ] Add sample technicians (12 techs with different timezones)

\- \[ ] Add sample tickets (mix of open, resolved, self-picked, assigned)

\- \[ ] Add seed script to package.json:

```json

"prisma": {

&nbsp; "seed": "node prisma/seed.js"

}

```

\- \[ ] Run seed:

```bash

npx prisma db seed

```



\### 0.3.4 Database Verification

\- \[ ] Connect to database using Prisma Studio:

```bash

npx prisma studio

```

\- \[ ] Verify all tables created correctly

\- \[ ] Check indexes are in place

\- \[ ] Test basic CRUD operations

\- \[ ] Document database schema in `/docs/DATABASE.md`



\*\*Acceptance Criteria:\*\*

\- Prisma schema matches PRD specifications

\- All migrations run successfully

\- Database accessible from backend code

\- Seed data loads correctly (if created)



---



\# PHASE 1: Backend Development

\*\*Duration:\*\* Days 4-10 (7 days)  

\*\*Goal:\*\* Build complete backend API, authentication, and FreshService integration



\## 1.1 Configuration \& Utilities



\### 1.1.1 Configuration Management

\- \[ ] Create `/backend/src/config/index.js`:

&nbsp; - Load environment variables

&nbsp; - Validate required env vars on startup

&nbsp; - Export config object with all settings

\- \[ ] Create `/backend/src/config/constants.js`:

&nbsp; - Color thresholds (green/yellow/red)

&nbsp; - Status mappings

&nbsp; - Priority mappings

&nbsp; - Timezone defaults

\- \[ ] Test configuration loading with different .env files



\### 1.1.2 Logger Setup

\- \[ ] Create `/backend/src/utils/logger.js` using Winston

\- \[ ] Configure log levels (info, warn, error)

\- \[ ] Set up file transports:

&nbsp; - `combined.log` (all logs)

&nbsp; - `error.log` (errors only)

\- \[ ] Add console transport for development

\- \[ ] Integrate with Application Insights (if applicable)

\- \[ ] Test logging at different levels



\### 1.1.3 Error Handling Utilities

\- \[ ] Create `/backend/src/utils/errors.js`:

&nbsp; - Custom error classes (ValidationError, AuthError, APIError)

&nbsp; - Error formatting functions

\- \[ ] Create `/backend/src/middleware/errorHandler.js`:

&nbsp; - Global error handler middleware

&nbsp; - Log errors with Winston

&nbsp; - Return appropriate HTTP status codes

&nbsp; - Never expose stack traces in production



\### 1.1.4 Timezone Utilities

\- \[ ] Create `/backend/src/utils/timezone.js`:

&nbsp; - Function to get "today" in PST (start/end timestamps)

&nbsp; - Function to convert UTC to PST

&nbsp; - Function to convert UTC to tech's local timezone

&nbsp; - Function to format timestamps for display

\- \[ ] Test timezone functions with edge cases:

&nbsp; - Daylight saving time transitions

&nbsp; - Leap years

&nbsp; - Midnight boundaries



\*\*Acceptance Criteria:\*\*

\- Configuration loads correctly from environment

\- Logger writes to files and console

\- Error handling catches and formats errors properly

\- Timezone functions return correct values



---



\## 1.2 Database Layer (Prisma Repositories)



\### 1.2.1 Technician Repository

\- \[ ] Create `/backend/src/services/technicianRepository.js`

\- \[ ] Implement methods:

&nbsp; - `getAllActive()` - Get all active technicians

&nbsp; - `getById(id)` - Get technician by ID

&nbsp; - `getByFreshserviceId(fsId)` - Get by FreshService ID

&nbsp; - `create(data)` - Create new technician

&nbsp; - `update(id, data)` - Update technician

&nbsp; - `deactivate(id)` - Soft delete (set isActive = false)

\- \[ ] Add error handling and logging

\- \[ ] Write unit tests for each method



\### 1.2.2 Ticket Repository

\- \[ ] Create `/backend/src/services/ticketRepository.js`

\- \[ ] Implement methods:

&nbsp; - `getAllToday(timezone)` - Get all tickets created today in given timezone

&nbsp; - `getByTechnicianId(techId)` - Get tickets for specific tech

&nbsp; - `getOpenByTechnicianId(techId)` - Get open tickets for tech

&nbsp; - `getResolvedTodayByTechnicianId(techId)` - Get resolved tickets today

&nbsp; - `create(data)` - Create new ticket

&nbsp; - `update(id, data)` - Update ticket

&nbsp; - `upsert(data)` - Create or update based on freshserviceTicketId

&nbsp; - `getUnassignedCount()` - Count unassigned tickets

\- \[ ] Optimize queries with proper includes and selects

\- \[ ] Write unit tests



\### 1.2.3 Ticket Activity Repository

\- \[ ] Create `/backend/src/services/ticketActivityRepository.js`

\- \[ ] Implement methods:

&nbsp; - `create(data)` - Log new activity

&nbsp; - `getByTicketId(ticketId)` - Get activities for ticket

&nbsp; - `getLatestAssignmentActivity(ticketId)` - Get last assignment

\- \[ ] Write unit tests



\### 1.2.4 App Settings Repository

\- \[ ] Create `/backend/src/services/settingsRepository.js`

\- \[ ] Implement methods:

&nbsp; - `get(key)` - Get setting by key

&nbsp; - `set(key, value)` - Set setting value

&nbsp; - `getAll()` - Get all settings

\- \[ ] Initialize default settings on first run:

&nbsp; - `refreshInterval`: 30

&nbsp; - `showLocalTimezone`: false

&nbsp; - `workspaceName`: "IT"

\- \[ ] Write unit tests



\### 1.2.5 Sync Log Repository

\- \[ ] Create `/backend/src/services/syncLogRepository.js`

\- \[ ] Implement methods:

&nbsp; - `createLog(syncType)` - Start new sync log

&nbsp; - `updateLog(id, data)` - Update sync log with results

&nbsp; - `getLatest(syncType)` - Get last sync log for type

&nbsp; - `cleanOldLogs()` - Delete logs older than 30 days

\- \[ ] Write unit tests



\*\*Acceptance Criteria:\*\*

\- All repository methods work correctly with Prisma

\- Error handling in place

\- Unit tests pass with >80% coverage

\- Queries are optimized (check with Prisma query logging)



---



\## 1.3 FreshService Integration



\### 1.3.1 FreshService API Client

\- \[ ] Create `/backend/src/services/freshserviceClient.js`

\- \[ ] Set up Axios instance with:

&nbsp; - Base URL from config

&nbsp; - Basic auth header (API key)

&nbsp; - Request/response interceptors for logging

&nbsp; - Retry logic with exponential backoff

&nbsp; - Timeout (30 seconds)

\- \[ ] Implement methods:

&nbsp; - `getTickets(params)` - Fetch tickets with filters

&nbsp; - `getAgents(params)` - Fetch agents/technicians

&nbsp; - `getTicketActivities(ticketId)` - Fetch ticket activities

&nbsp; - `getWorkspace(workspaceId)` - Get workspace details

\- \[ ] Test API client with real FreshService instance

\- \[ ] Handle rate limiting (5000 requests/hour)

\- \[ ] Write unit tests with mocked responses



\### 1.3.2 Ticket Sync Service

\- \[ ] Create `/backend/src/services/ticketSyncService.js`

\- \[ ] Implement `syncTickets()` function:

&nbsp; 1. Get "today" timestamp range in PST

&nbsp; 2. Fetch tickets from FreshService (created or updated today)

&nbsp; 3. Filter by IT workspace

&nbsp; 4. For each ticket:

&nbsp;    - Fetch ticket activities to determine self-picked vs assigned

&nbsp;    - Upsert ticket in database

&nbsp;    - Log activity if assignment changed

&nbsp; 5. Update sync log with results

\- \[ ] Implement self-picked detection algorithm:

```javascript

function isSelfPicked(ticket, activities) {

&nbsp; const assignmentActivity = activities.find(a => a.action === 'assigned');

&nbsp; if (!assignmentActivity) return false;

&nbsp; return assignmentActivity.performed\_by\_id === ticket.responder\_id;

}

```

\- \[ ] Handle pagination (FreshService returns 30 tickets per page)

\- \[ ] Add detailed logging for debugging

\- \[ ] Write unit tests with mocked FreshService responses



\### 1.3.3 Technician Sync Service

\- \[ ] Create `/backend/src/services/technicianSyncService.js`

\- \[ ] Implement `syncTechnicians()` function:

&nbsp; 1. Fetch all agents from FreshService IT workspace

&nbsp; 2. Filter active agents only

&nbsp; 3. For each agent:

&nbsp;    - Upsert technician in database

&nbsp;    - Map timezone from location (or use default PST)

&nbsp; 4. Mark technicians not in FreshService as inactive

&nbsp; 5. Update sync log

\- \[ ] Add timezone mapping logic:

```javascript

function getTechnicianTimezone(location) {

&nbsp; const timezoneMap = {

&nbsp;   'Halifax': 'America/Halifax',

&nbsp;   'Toronto': 'America/Toronto',

&nbsp;   'Vancouver': 'America/Vancouver',

&nbsp;   // ... more mappings

&nbsp; };

&nbsp; return timezoneMap\[location] || 'America/Los\_Angeles'; // default PST

}

```

\- \[ ] Write unit tests



\### 1.3.4 Sync Scheduler

\- \[ ] Create `/backend/src/services/syncScheduler.js`

\- \[ ] Use `node-cron` to schedule syncs

\- \[ ] Implement scheduled jobs:

&nbsp; - Ticket sync: Every 30 seconds (configurable from settings)

&nbsp; - Technician sync: Every 5 minutes

&nbsp; - Cleanup old sync logs: Daily at midnight

\- \[ ] Add job management functions:

&nbsp; - `startScheduler()` - Start all jobs

&nbsp; - `stopScheduler()` - Stop all jobs

&nbsp; - `updateTicketSyncInterval(seconds)` - Dynamically update interval

\- \[ ] Prevent overlapping syncs (check if previous sync still running)

\- \[ ] Handle errors gracefully (log and continue)

\- \[ ] Test scheduler with different intervals



\*\*Acceptance Criteria:\*\*

\- FreshService API client successfully fetches data

\- Ticket sync accurately imports tickets

\- Self-picked detection works with 95%+ accuracy (manual verification)

\- Technician sync imports all agents correctly

\- Scheduler runs on schedule without crashes

\- Error handling prevents cascade failures



---



\## 1.4 REST API Endpoints



\### 1.4.1 Authentication Routes

\- \[ ] Create `/backend/src/routes/auth.js`

\- \[ ] Implement `POST /api/auth/login`:

&nbsp; - Accept password in request body

&nbsp; - Compare with bcrypt hash from Key Vault

&nbsp; - Create session if password correct

&nbsp; - Return session info and expiration

\- \[ ] Implement `POST /api/auth/logout`:

&nbsp; - Destroy session

&nbsp; - Return success message

\- \[ ] Implement `GET /api/auth/check`:

&nbsp; - Check if session is valid

&nbsp; - Return authentication status

\- \[ ] Write integration tests using Supertest



\### 1.4.2 Authentication Middleware

\- \[ ] Create `/backend/src/middleware/auth.js`

\- \[ ] Implement `requireAuth` middleware:

&nbsp; - Check if session exists and is valid

&nbsp; - If not authenticated, return 401 Unauthorized

&nbsp; - If authenticated, call next()

\- \[ ] Test middleware with various scenarios



\### 1.4.3 Dashboard Routes

\- \[ ] Create `/backend/src/routes/dashboard.js`

\- \[ ] Implement `GET /api/dashboard`:

&nbsp; - Get all active technicians

&nbsp; - For each tech, calculate:

&nbsp;   - Total tickets today

&nbsp;   - Self-picked count

&nbsp;   - Assigned count

&nbsp;   - Open ticket count

&nbsp;   - Load level (green/yellow/red)

&nbsp; - Calculate overall stats:

&nbsp;   - Total tickets today

&nbsp;   - Unassigned tickets

&nbsp;   - Average per tech

&nbsp;   - Last updated timestamp

&nbsp; - Return JSON response

&nbsp; - Add caching (cache for 5 seconds to reduce DB load)

\- \[ ] Implement helper function to calculate load level:

```javascript

function getLoadLevel(openCount) {

&nbsp; if (openCount <= 3) return 'light';

&nbsp; if (openCount <= 6) return 'medium';

&nbsp; return 'heavy';

}

```

\- \[ ] Sort technicians by open count (ascending)

\- \[ ] Write integration tests



\### 1.4.4 Technician Detail Routes

\- \[ ] Create `/backend/src/routes/technicians.js`

\- \[ ] Implement `GET /api/technicians/:id`:

&nbsp; - Get technician by ID

&nbsp; - Get all tickets for tech (open and resolved today)

&nbsp; - For each ticket, include:

&nbsp;   - Basic info (id, subject, status, priority)

&nbsp;   - Assignment info (assignedAt, isSelfPicked, assignedBy)

&nbsp;   - FreshService URL

&nbsp; - Sort tickets by priority (P1 first), then by assignedAt

&nbsp; - Return JSON response

\- \[ ] Write integration tests



\### 1.4.5 Settings Routes

\- \[ ] Create `/backend/src/routes/settings.js`

\- \[ ] Implement `GET /api/settings`:

&nbsp; - Get all settings from database

&nbsp; - Return as JSON object

\- \[ ] Implement `PUT /api/settings`:

&nbsp; - Accept settings object in body

&nbsp; - Validate settings (e.g., refreshInterval must be 15, 30, 60, or 120)

&nbsp; - Update settings in database

&nbsp; - If refreshInterval changed, update sync scheduler

&nbsp; - Return updated settings

\- \[ ] Write integration tests



\### 1.4.6 Health Check Route

\- \[ ] Create `/backend/src/routes/health.js`

\- \[ ] Implement `GET /api/health` (public, no auth):

&nbsp; - Check database connection (simple query)

&nbsp; - Check FreshService API (simple GET request)

&nbsp; - Get last sync timestamp

&nbsp; - Return health status:

&nbsp;   - `healthy` if all checks pass

&nbsp;   - `unhealthy` if any check fails

&nbsp; - Include uptime and individual check statuses

\- \[ ] Add monitoring integration (Application Insights)

\- \[ ] Write integration tests



\*\*Acceptance Criteria:\*\*

\- All API endpoints return correct data

\- Authentication protects sensitive routes

\- Response times meet NFR targets (<200ms p95)

\- Integration tests pass with >70% coverage

\- API documentation updated in `/docs/API.md`



---



\## 1.5 Server-Sent Events (SSE)



\### 1.5.1 SSE Endpoint

\- \[ ] Create `/backend/src/routes/sse.js`

\- \[ ] Implement `GET /api/dashboard/stream`:

&nbsp; - Set headers for SSE:

&nbsp;   - `Content-Type: text/event-stream`

&nbsp;   - `Cache-Control: no-cache`

&nbsp;   - `Connection: keep-alive`

&nbsp; - Send initial dashboard data

&nbsp; - Keep connection open

&nbsp; - Handle client disconnect gracefully

\- \[ ] Test SSE connection with curl or Postman



\### 1.5.2 SSE Event Manager

\- \[ ] Create `/backend/src/services/sseManager.js`

\- \[ ] Implement client management:

&nbsp; - Store active SSE connections in memory

&nbsp; - Add client: `addClient(res)`

&nbsp; - Remove client: `removeClient(res)`

&nbsp; - Broadcast to all clients: `broadcast(eventType, data)`

\- \[ ] Implement event types:

&nbsp; - `update`: Dashboard data changed

&nbsp; - `ping`: Keep-alive heartbeat (every 15 seconds)

&nbsp; - `error`: Error occurred (e.g., FreshService down)

\- \[ ] Test with multiple concurrent clients



\### 1.5.3 SSE Integration with Sync

\- \[ ] Modify `ticketSyncService.js` to broadcast updates:

&nbsp; - After successful sync, call `sseManager.broadcast('update', dashboardData)`

&nbsp; - On sync error, call `sseManager.broadcast('error', errorMessage)`

\- \[ ] Add heartbeat timer to keep connections alive

\- \[ ] Test real-time updates (change data in FreshService, verify dashboard updates)



\*\*Acceptance Criteria:\*\*

\- SSE connection stays open

\- Multiple clients can connect simultaneously

\- Dashboard data broadcasts to all clients after sync

\- Heartbeat prevents connection timeout

\- Clients reconnect automatically on disconnect



---



\## 1.6 Session Management



\### 1.6.1 Session Store Setup

\- \[ ] Install `express-session` and `connect-pg-simple`

\- \[ ] Create session table in PostgreSQL (via connect-pg-simple)

\- \[ ] Configure session middleware in `app.js`:

&nbsp; - Use PostgreSQL session store

&nbsp; - Set session secret from Key Vault

&nbsp; - Set cookie options:

&nbsp;   - `httpOnly: true`

&nbsp;   - `secure: true` (in production)

&nbsp;   - `maxAge: 8 hours`

&nbsp;   - `sameSite: 'strict'`

\- \[ ] Test session creation and persistence



\### 1.6.2 Remember Me Feature

\- \[ ] Add optional `rememberMe` field to login request

\- \[ ] If `rememberMe` is true, set `maxAge: 30 days`

\- \[ ] Test remember me functionality



\*\*Acceptance Criteria:\*\*

\- Sessions persist across server restarts

\- Session expires after 8 hours of inactivity

\- Remember me extends session to 30 days

\- Sessions are secure (httpOnly, secure in prod)



---



\## 1.7 Backend Testing



\### 1.7.1 Unit Tests

\- \[ ] Write unit tests for all repositories (>80% coverage)

\- \[ ] Write unit tests for FreshService client (mocked responses)

\- \[ ] Write unit tests for utilities (timezone, errors, etc.)

\- \[ ] Run tests:

```bash

npm test

```

\- \[ ] Generate coverage report:

```bash

npm test -- --coverage

```

\- \[ ] Ensure coverage meets target (>70%)



\### 1.7.2 Integration Tests

\- \[ ] Write integration tests for all API endpoints

\- \[ ] Use Supertest for HTTP requests

\- \[ ] Test authentication flow

\- \[ ] Test dashboard data endpoint

\- \[ ] Test settings CRUD

\- \[ ] Test SSE connection

\- \[ ] Run integration tests against test database



\### 1.7.3 Manual Testing

\- \[ ] Test FreshService sync manually:

&nbsp; - Create test ticket in FreshService

&nbsp; - Wait 30 seconds

&nbsp; - Verify ticket appears in database

\- \[ ] Test self-picked detection:

&nbsp; - Self-assign a ticket in FreshService

&nbsp; - Verify it's marked as self-picked

&nbsp; - Have coordinator assign a ticket

&nbsp; - Verify it's marked as assigned

\- \[ ] Test timezone handling:

&nbsp; - Create tickets at different times

&nbsp; - Verify "today" calculation is correct in PST



\*\*Acceptance Criteria:\*\*

\- Unit test coverage >70%

\- All integration tests pass

\- Manual testing validates key functionality

\- Test documentation updated



---



\## 1.8 Backend Documentation



\### 1.8.1 API Documentation

\- \[ ] Update `/docs/API.md` with all endpoints:

&nbsp; - Request/response examples

&nbsp; - Authentication requirements

&nbsp; - Error codes

&nbsp; - Rate limits (if applicable)

\- \[ ] Add Postman collection (export and commit)



\### 1.8.2 Code Documentation

\- \[ ] Add JSDoc comments to all public functions

\- \[ ] Document complex algorithms (self-picked detection)

\- \[ ] Add inline comments for tricky code



\### 1.8.3 Deployment Documentation

\- \[ ] Document environment variables in README

\- \[ ] Create deployment checklist

\- \[ ] Document database migration process



\*\*Acceptance Criteria:\*\*

\- API documentation is complete and accurate

\- Code is well-commented

\- Deployment process is documented



---



\# PHASE 2: Frontend Development

\*\*Duration:\*\* Days 11-17 (7 days)  

\*\*Goal:\*\* Build complete React frontend with all UI components



\## 2.1 Frontend Setup \& Configuration



\### 2.1.1 Tailwind Configuration

\- \[ ] Configure Tailwind in `tailwind.config.js`:

&nbsp; - Add custom colors (green, yellow, red for load levels)

&nbsp; - Add custom fonts (if needed)

&nbsp; - Configure dark mode (optional)

\- \[ ] Import Tailwind in main CSS file

\- \[ ] Test Tailwind classes work



\### 2.1.2 Routing Setup

\- \[ ] Install React Router

\- \[ ] Create `/frontend/src/routes.jsx`:

&nbsp; - `/login` - Login page

&nbsp; - `/` - Dashboard (protected)

&nbsp; - `/technicians/:id` - Tech detail page (protected)

&nbsp; - `/settings` - Settings page (protected)

\- \[ ] Create `ProtectedRoute` component for auth-required routes

\- \[ ] Test routing works



\### 2.1.3 API Client Setup

\- \[ ] Create `/frontend/src/utils/api.js`:

&nbsp; - Axios instance with base URL

&nbsp; - Include credentials (cookies)

&nbsp; - Request/response interceptors

&nbsp; - Error handling

\- \[ ] Export API methods:

&nbsp; - `login(password)`

&nbsp; - `logout()`

&nbsp; - `checkAuth()`

&nbsp; - `getDashboard()`

&nbsp; - `getTechnician(id)`

&nbsp; - `getSettings()`

&nbsp; - `updateSettings(settings)`

\- \[ ] Test API client in browser console



\### 2.1.4 Global State Management

\- \[ ] Create Context for authentication:

&nbsp; - `/frontend/src/context/AuthContext.jsx`

&nbsp; - Store: `isAuthenticated`, `loading`, `error`

&nbsp; - Methods: `login()`, `logout()`, `checkAuth()`

\- \[ ] Create Context for dashboard data:

&nbsp; - `/frontend/src/context/DashboardContext.jsx`

&nbsp; - Store: `stats`, `technicians`, `lastUpdated`, `loading`, `error`

&nbsp; - Methods: `fetchDashboard()`, `updateSettings()`

\- \[ ] Create Context for settings:

&nbsp; - `/frontend/src/context/SettingsContext.jsx`

&nbsp; - Store: `refreshInterval`, `showLocalTimezone`

&nbsp; - Methods: `updateSettings()`, `loadSettings()`

\- \[ ] Wrap App with Context Providers



\*\*Acceptance Criteria:\*\*

\- Tailwind CSS works correctly

\- Routing configured with protected routes

\- API client communicates with backend

\- Context Providers manage state correctly



---



\## 2.2 Authentication \& Layout



\### 2.2.1 Login Page

\- \[ ] Create `/frontend/src/pages/LoginPage.jsx`

\- \[ ] Design login form:

&nbsp; - Password input (type="password")

&nbsp; - "Remember Me" checkbox

&nbsp; - Login button

&nbsp; - Error message display

\- \[ ] Implement login logic:

&nbsp; - Call `AuthContext.login(password)`

&nbsp; - Handle success (redirect to dashboard)

&nbsp; - Handle error (show error message)

\- \[ ] Style with Tailwind (centered, professional)

\- \[ ] Test login flow



\### 2.2.2 App Layout Component

\- \[ ] Create `/frontend/src/components/Layout.jsx`

\- \[ ] Design layout:

&nbsp; - Header with logo/title

&nbsp; - "Last updated" timestamp

&nbsp; - Auto-refresh indicator

&nbsp; - Settings button

&nbsp; - Logout button

\- \[ ] Make header sticky on scroll

\- \[ ] Style with Tailwind

\- \[ ] Test layout on different screen sizes



\### 2.2.3 Protected Route Component

\- \[ ] Create `/frontend/src/components/ProtectedRoute.jsx`

\- \[ ] Check authentication status

\- \[ ] If not authenticated, redirect to login

\- \[ ] If authenticated, render children

\- \[ ] Show loading spinner while checking auth

\- \[ ] Test protected route behavior



\*\*Acceptance Criteria:\*\*

\- Login page looks professional

\- Login flow works correctly

\- Protected routes block unauthenticated users

\- Layout provides consistent structure



---



\## 2.3 Dashboard Page Components



\### 2.3.1 Dashboard Page Container

\- \[ ] Create `/frontend/src/pages/DashboardPage.jsx`

\- \[ ] Fetch dashboard data on mount:

&nbsp; - Call `DashboardContext.fetchDashboard()`

\- \[ ] Show loading state

\- \[ ] Show error state (with retry button)

\- \[ ] Render dashboard components

\- \[ ] Test page loads correctly



\### 2.3.2 Dashboard Stats Component

\- \[ ] Create `/frontend/src/components/DashboardStats.jsx`

\- \[ ] Display overview stats:

&nbsp; - Total Tickets Today

&nbsp; - Unassigned Tickets

&nbsp; - Average per Tech

&nbsp; - Last Updated timestamp

&nbsp; - Refresh interval setting

\- \[ ] Style as horizontal bar at top

\- \[ ] Use large, bold numbers

\- \[ ] Add icons (lucide-react)

\- \[ ] Test with different data values



\### 2.3.3 Technician Card Component

\- \[ ] Create `/frontend/src/components/TechnicianCard.jsx`

\- \[ ] Props: `technician` object

\- \[ ] Display:

&nbsp; - Tech name

&nbsp; - Location

&nbsp; - Load level indicator (colored badge)

&nbsp; - Total tickets today

&nbsp; - Self-picked count

&nbsp; - Assigned count

&nbsp; - Open tickets count

&nbsp; - "View" button

\- \[ ] Apply color coding:

&nbsp; - Green background for light load

&nbsp; - Yellow background for medium load

&nbsp; - Red background for heavy load

\- \[ ] Make card clickable (navigate to detail page)

\- \[ ] Add hover effects

\- \[ ] Style with Tailwind

\- \[ ] Test with different load levels



\### 2.3.4 Technician Grid Component

\- \[ ] Create `/frontend/src/components/TechnicianGrid.jsx`

\- \[ ] Render grid of TechnicianCard components

\- \[ ] Sort technicians by open count (ascending)

\- \[ ] Make responsive (4 columns on desktop, 2 on tablet, 1 on mobile)

\- \[ ] Handle empty state (no technicians)

\- \[ ] Test with 12 technicians



\*\*Acceptance Criteria:\*\*

\- Dashboard page displays all data correctly

\- Stats component shows accurate metrics

\- Technician cards are color-coded correctly

\- Grid is responsive and sorted properly

\- Loading and error states work



---



\## 2.4 Technician Detail Page



\### 2.4.1 Detail Page Container

\- \[ ] Create `/frontend/src/pages/TechnicianDetailPage.jsx`

\- \[ ] Get technician ID from URL params

\- \[ ] Fetch technician data on mount:

&nbsp; - Call `api.getTechnician(id)`

\- \[ ] Show loading state

\- \[ ] Show error state (with back button)

\- \[ ] Render detail components

\- \[ ] Test page loads correctly



\### 2.4.2 Technician Header Component

\- \[ ] Create `/frontend/src/components/TechnicianHeader.jsx`

\- \[ ] Display:

&nbsp; - Back to Dashboard button

&nbsp; - Tech name

&nbsp; - Location / Timezone

&nbsp; - Summary stats (today's total, open, resolved)

\- \[ ] Style with Tailwind

\- \[ ] Test navigation



\### 2.4.3 Ticket List Component

\- \[ ] Create `/frontend/src/components/TicketList.jsx`

\- \[ ] Props: `tickets` array, `title` string

\- \[ ] Display list of tickets in table:

&nbsp; - Columns: Ticket ID, Priority, Subject, Assigned, Self-picked

&nbsp; - Ticket ID is link to FreshService (open in new tab)

&nbsp; - Priority shown as badge (P1, P2, P3, P4)

&nbsp; - Self-picked shown as checkmark icon

&nbsp; - Time since assigned (e.g., "2h ago")

\- \[ ] Sort by priority, then by assigned time

\- \[ ] Handle empty state

\- \[ ] Style with Tailwind

\- \[ ] Test with different ticket data



\### 2.4.4 Resolved Tickets Section

\- \[ ] Create collapsible section for resolved tickets

\- \[ ] Show count in header (e.g., "Resolved Today (5)")

\- \[ ] Collapsed by default

\- \[ ] Click to expand/collapse

\- \[ ] Display resolved tickets with resolution time

\- \[ ] Test expand/collapse behavior



\*\*Acceptance Criteria:\*\*

\- Detail page shows tech info and tickets

\- Ticket list displays all fields correctly

\- Links to FreshService work

\- Resolved section collapses/expands

\- Back button returns to dashboard



---



\## 2.5 Settings Component



\### 2.5.1 Settings Modal/Page

\- \[ ] Create `/frontend/src/components/SettingsModal.jsx`

\- \[ ] Display as modal overlay (or dedicated page)

\- \[ ] Show settings form:

&nbsp; - Refresh Interval dropdown (15s, 30s, 60s, 120s)

&nbsp; - Show Local Timezone toggle switch

&nbsp; - Reset to Defaults button

&nbsp; - Save button

&nbsp; - Cancel button

\- \[ ] Load current settings on mount

\- \[ ] Handle form submission:

&nbsp; - Call `SettingsContext.updateSettings()`

&nbsp; - Show success message

&nbsp; - Close modal

\- \[ ] Handle reset to defaults

\- \[ ] Style with Tailwind (professional modal)

\- \[ ] Test settings persist



\### 2.5.2 Settings Button

\- \[ ] Add settings button to header

\- \[ ] Click opens settings modal

\- \[ ] Use settings icon from lucide-react

\- \[ ] Test button and modal interaction



\*\*Acceptance Criteria:\*\*

\- Settings modal opens/closes correctly

\- Settings save and apply immediately

\- Reset to defaults works

\- UI is user-friendly



---



\## 2.6 Real-Time Updates (SSE)



\### 2.6.1 SSE Hook

\- \[ ] Create `/frontend/src/hooks/useSSE.js`

\- \[ ] Connect to SSE endpoint:

&nbsp; - Open EventSource connection to `/api/dashboard/stream`

&nbsp; - Listen for `update` events

&nbsp; - Listen for `ping` events (heartbeat)

&nbsp; - Listen for `error` events

\- \[ ] Handle connection errors (retry logic)

\- \[ ] Update dashboard context when event received

\- \[ ] Close connection on unmount

\- \[ ] Test SSE connection



\### 2.6.2 Auto-Refresh Indicator

\- \[ ] Create `/frontend/src/components/RefreshIndicator.jsx`

\- \[ ] Show spinning icon when data is refreshing

\- \[ ] Show "Last updated: Xs ago" timestamp

\- \[ ] Update timestamp every second

\- \[ ] Pulse on data update

\- \[ ] Style with Tailwind

\- \[ ] Test indicator updates



\### 2.6.3 Integrate SSE with Dashboard

\- \[ ] Use `useSSE` hook in DashboardPage

\- \[ ] Update dashboard data when SSE event received

\- \[ ] Show visual feedback (flash/pulse) on update

\- \[ ] Test real-time updates:

&nbsp; - Change data in FreshService

&nbsp; - Verify dashboard updates within 30 seconds

&nbsp; - No page refresh needed



\*\*Acceptance Criteria:\*\*

\- SSE connection establishes successfully

\- Dashboard updates in real-time

\- Visual indicators show when data updates

\- Connection recovers from errors



---



\## 2.7 Error Handling \& Loading States



\### 2.7.1 Loading Spinner Component

\- \[ ] Create `/frontend/src/components/LoadingSpinner.jsx`

\- \[ ] Design spinning loader (CSS animation or SVG)

\- \[ ] Make configurable (size, color)

\- \[ ] Use throughout app for loading states

\- \[ ] Test appearance



\### 2.7.2 Error Message Component

\- \[ ] Create `/frontend/src/components/ErrorMessage.jsx`

\- \[ ] Display error message with icon

\- \[ ] Include retry button (if applicable)

\- \[ ] Style with red/warning colors

\- \[ ] Use throughout app for error states

\- \[ ] Test with different error messages



\### 2.7.3 Empty State Component

\- \[ ] Create `/frontend/src/components/EmptyState.jsx`

\- \[ ] Display when no data available

\- \[ ] Show helpful message and illustration

\- \[ ] Use for empty ticket lists, no technicians, etc.

\- \[ ] Test appearance



\### 2.7.4 Global Error Boundary

\- \[ ] Create `/frontend/src/components/ErrorBoundary.jsx`

\- \[ ] Catch React errors

\- \[ ] Display user-friendly error page

\- \[ ] Log errors to console (or analytics)

\- \[ ] Wrap entire app with ErrorBoundary

\- \[ ] Test by throwing error in component



\*\*Acceptance Criteria:\*\*

\- Loading states show appropriate spinners

\- Errors display user-friendly messages

\- Empty states guide users

\- App doesn't crash on errors (ErrorBoundary)



---



\## 2.8 Accessibility \& Responsive Design



\### 2.8.1 Accessibility Audit

\- \[ ] Add proper semantic HTML (header, main, nav, etc.)

\- \[ ] Ensure all interactive elements are keyboard accessible

\- \[ ] Add ARIA labels where needed

\- \[ ] Test with keyboard only (no mouse)

\- \[ ] Test with screen reader (NVDA/JAWS)

\- \[ ] Ensure color contrast meets WCAG AA standards

\- \[ ] Add focus indicators (visible focus rings)



\### 2.8.2 Responsive Design

\- \[ ] Test dashboard on different screen sizes:

&nbsp; - Desktop (1920x1080)

&nbsp; - Laptop (1440x900)

&nbsp; - Tablet (768x1024)

&nbsp; - Mobile (375x667) - not required but test degradation

\- \[ ] Ensure tech cards stack appropriately

\- \[ ] Ensure text is readable at all sizes

\- \[ ] Test with browser zoom (100%, 150%, 200%)

\- \[ ] Fix any layout issues



\*\*Acceptance Criteria:\*\*

\- App is fully keyboard accessible

\- Meets WCAG AA accessibility standards

\- Responsive on all target screen sizes

\- No layout breaking on zoom



---



\## 2.9 Frontend Testing



\### 2.9.1 Component Unit Tests

\- \[ ] Write tests for key components using React Testing Library:

&nbsp; - TechnicianCard

&nbsp; - TicketList

&nbsp; - DashboardStats

&nbsp; - LoginPage

\- \[ ] Test rendering, user interactions, edge cases

\- \[ ] Run tests:

```bash

npm test

```

\- \[ ] Ensure coverage >60%



\### 2.9.2 Integration Tests

\- \[ ] Test user flows:

&nbsp; - Login → Dashboard → Tech Detail → Back

&nbsp; - Settings change → Dashboard updates

&nbsp; - Auto-refresh updates dashboard

\- \[ ] Use React Testing Library for integration tests

\- \[ ] Mock API calls with MSW (Mock Service Worker)



\### 2.9.3 Visual Testing

\- \[ ] Manually test UI in browser

\- \[ ] Check all pages look correct

\- \[ ] Test different data scenarios (0 tickets, 100 tickets, etc.)

\- \[ ] Test error states

\- \[ ] Verify color coding

\- \[ ] Check typography and spacing



\*\*Acceptance Criteria:\*\*

\- Component tests pass with >60% coverage

\- Integration tests validate key user flows

\- Visual appearance matches PRD wireframes

\- No obvious UI bugs



---



\## 2.10 Frontend Documentation



\### 2.10.1 Component Documentation

\- \[ ] Add JSDoc comments to all components

\- \[ ] Document props with PropTypes or TypeScript

\- \[ ] Create component usage examples



\### 2.10.2 User Guide

\- \[ ] Create `/docs/USER\_GUIDE.md`:

&nbsp; - How to log in

&nbsp; - How to read the dashboard

&nbsp; - How to view tech details

&nbsp; - How to adjust settings

&nbsp; - Troubleshooting common issues

\- \[ ] Add screenshots of UI



\*\*Acceptance Criteria:\*\*

\- Components are well-documented

\- User guide is clear and helpful



---



\# PHASE 3: Integration \& Testing

\*\*Duration:\*\* Days 18-24 (7 days)  

\*\*Goal:\*\* Integrate frontend and backend, comprehensive testing



\## 3.1 Full Stack Integration



\### 3.1.1 Local Development Setup

\- \[ ] Create `/docker-compose.yml` for full stack:

&nbsp; - PostgreSQL container

&nbsp; - Backend API container (or run locally)

&nbsp; - Frontend dev server (or run locally)

\- \[ ] Create unified start script in root package.json:

```json

{

&nbsp; "scripts": {

&nbsp;   "dev": "concurrently \\"npm run dev --prefix backend\\" \\"npm run dev --prefix frontend\\"",

&nbsp;   "test": "npm test --prefix backend \&\& npm test --prefix frontend"

&nbsp; }

}

```

\- \[ ] Test full stack runs locally

\- \[ ] Document setup in README



\### 3.1.2 Frontend-Backend Integration Testing

\- \[ ] Test login flow end-to-end

\- \[ ] Test dashboard loads data from backend

\- \[ ] Test tech detail page fetches correct data

\- \[ ] Test settings save to backend and apply

\- \[ ] Test SSE connection works

\- \[ ] Test error handling (disconnect backend, see frontend errors)

\- \[ ] Fix any integration issues



\### 3.1.3 FreshService Integration Testing

\- \[ ] Connect to real FreshService instance

\- \[ ] Run full sync (technicians + tickets)

\- \[ ] Verify data accuracy:

&nbsp; - Compare 20 random tickets in dashboard vs FreshService

&nbsp; - Check self-picked detection accuracy (manual spot-check)

&nbsp; - Verify timezone handling (tickets appear on correct day)

\- \[ ] Test edge cases:

&nbsp; - Ticket assigned, then reassigned

&nbsp; - Tech self-picks, then unassigns

&nbsp; - Ticket created at midnight (timezone boundary)

\- \[ ] Document any discrepancies



\*\*Acceptance Criteria:\*\*

\- Full stack runs smoothly locally

\- Frontend and backend communicate correctly

\- FreshService data syncs accurately (99%+ accuracy)

\- Edge cases handled properly



---



\## 3.2 End-to-End Testing



\### 3.2.1 E2E Test Setup

\- \[ ] Install Playwright:

```bash

npm install --save-dev @playwright/test

```

\- \[ ] Create `/e2e` folder for E2E tests

\- \[ ] Configure Playwright in `playwright.config.js`:

&nbsp; - Set base URL (localhost:3000)

&nbsp; - Configure browsers (Chromium, Firefox, WebKit)

&nbsp; - Set test timeout (30 seconds)



\### 3.2.2 E2E Test Scenarios

\- \[ ] Write test: Login flow

&nbsp; - Navigate to `/login`

&nbsp; - Enter password

&nbsp; - Click login

&nbsp; - Verify redirected to dashboard

\- \[ ] Write test: Dashboard displays data

&nbsp; - Login

&nbsp; - Verify stats visible

&nbsp; - Verify tech cards visible

&nbsp; - Verify cards sorted by open count

\- \[ ] Write test: Tech detail navigation

&nbsp; - Login

&nbsp; - Click tech card

&nbsp; - Verify detail page loads

&nbsp; - Verify tickets displayed

&nbsp; - Click back, verify returns to dashboard

\- \[ ] Write test: Settings update

&nbsp; - Login

&nbsp; - Open settings

&nbsp; - Change refresh interval

&nbsp; - Save

&nbsp; - Verify setting applied (check local storage or API)

\- \[ ] Write test: Auto-refresh

&nbsp; - Login

&nbsp; - Wait 30+ seconds

&nbsp; - Verify "Last updated" timestamp changes

&nbsp; - Verify dashboard data updates (if data changed)

\- \[ ] Write test: Logout

&nbsp; - Login

&nbsp; - Click logout

&nbsp; - Verify redirected to login page

&nbsp; - Try accessing dashboard, verify redirected to login



\### 3.2.3 Run E2E Tests

\- \[ ] Run tests locally:

```bash

npx playwright test

```

\- \[ ] Run tests in CI (GitHub Actions)

\- \[ ] Generate test report

\- \[ ] Fix any failing tests



\*\*Acceptance Criteria:\*\*

\- All E2E tests pass consistently

\- Critical user flows validated

\- Tests run in CI pipeline



---



\## 3.3 Performance Testing



\### 3.3.1 Frontend Performance

\- \[ ] Use Lighthouse to audit frontend:

&nbsp; - Run on login page

&nbsp; - Run on dashboard page

&nbsp; - Target scores: Performance >90, Accessibility >90

\- \[ ] Optimize based on Lighthouse recommendations:

&nbsp; - Minimize bundle size

&nbsp; - Lazy load components if needed

&nbsp; - Optimize images

&nbsp; - Add caching headers

\- \[ ] Test page load time:

&nbsp; - Dashboard should load in <2 seconds

&nbsp; - Tech detail page should load in <1 second



\### 3.3.2 Backend Performance

\- \[ ] Load test API endpoints with Apache Bench or k6:

&nbsp; - `/api/dashboard` - simulate 10 concurrent requests

&nbsp; - `/api/technicians/:id` - simulate 10 concurrent requests

\- \[ ] Measure response times:

&nbsp; - Target: p95 <200ms

\- \[ ] Profile slow queries with Prisma query logging

\- \[ ] Optimize queries if needed (add indexes, reduce includes)

\- \[ ] Test sync job performance:

&nbsp; - Measure time to sync 100 tickets

&nbsp; - Target: <30 seconds



\### 3.3.3 Database Performance

\- \[ ] Check query execution plans

\- \[ ] Add indexes if missing:

&nbsp; - `tickets.assigned\_tech\_id`

&nbsp; - `tickets.created\_at`

&nbsp; - `tickets.status`

\- \[ ] Test query performance with EXPLAIN ANALYZE

\- \[ ] Ensure database backups are configured



\*\*Acceptance Criteria:\*\*

\- Frontend Lighthouse score >90 for Performance and Accessibility

\- Backend API responds in <200ms (p95)

\- Dashboard loads in <2 seconds

\- Sync job completes in <30 seconds



---



\## 3.4 Security Testing



\### 3.4.1 Authentication Security

\- \[ ] Test login with incorrect password (verify fails)

\- \[ ] Test session expiration (wait 8 hours, verify logged out)

\- \[ ] Test protected routes without auth (verify 401)

\- \[ ] Verify password is hashed (never stored in plaintext)

\- \[ ] Test CSRF protection (if implemented)



\### 3.4.2 API Security

\- \[ ] Verify HTTPS is enforced (redirects HTTP to HTTPS)

\- \[ ] Check for SQL injection vulnerabilities (Prisma should prevent)

\- \[ ] Test for XSS vulnerabilities (React should prevent)

\- \[ ] Verify API keys not exposed in client-side code

\- \[ ] Check CORS configuration (restrict to allowed origins)



\### 3.4.3 Session Security

\- \[ ] Verify session cookies are httpOnly

\- \[ ] Verify session cookies are secure (only over HTTPS)

\- \[ ] Verify sameSite attribute is set

\- \[ ] Test session fixation attack (create session, try to hijack)



\### 3.4.4 Secrets Management

\- \[ ] Verify all secrets in Azure Key Vault (not in code)

\- \[ ] Verify .env files not committed to git

\- \[ ] Check for hardcoded passwords or API keys (grep codebase)



\*\*Acceptance Criteria:\*\*

\- No critical security vulnerabilities found

\- Authentication is secure

\- Sessions are secure

\- Secrets are not exposed



---



\## 3.5 User Acceptance Testing (UAT)



\### 3.5.1 UAT with IT Coordinator

\- \[ ] Schedule UAT session with IT Coordinator (primary user)

\- \[ ] Provide access to staging environment

\- \[ ] Walk through key features:

&nbsp; - Login

&nbsp; - View dashboard

&nbsp; - Understand color coding

&nbsp; - View tech details

&nbsp; - Adjust settings

\- \[ ] Observe coordinator using the dashboard

\- \[ ] Collect feedback:

&nbsp; - What works well?

&nbsp; - What's confusing?

&nbsp; - What's missing?

&nbsp; - Any bugs?

\- \[ ] Document feedback in `/docs/UAT\_FEEDBACK.md`



\### 3.5.2 Address Feedback

\- \[ ] Prioritize feedback (critical vs nice-to-have)

\- \[ ] Implement critical fixes

\- \[ ] Create tickets for nice-to-have items (Phase 2 backlog)

\- \[ ] Re-test with coordinator if major changes made



\### 3.5.3 UAT with IT Manager

\- \[ ] Schedule UAT session with IT Manager (product owner)

\- \[ ] Demonstrate all features

\- \[ ] Verify product meets PRD requirements

\- \[ ] Collect feedback

\- \[ ] Address any concerns



\*\*Acceptance Criteria:\*\*

\- IT Coordinator can use dashboard effectively

\- IT Coordinator gives positive feedback (NPS >7)

\- Critical bugs are fixed

\- Product owner approves for launch



---



\## 3.6 Bug Fixing \& Polish



\### 3.6.1 Bug Triage

\- \[ ] Review all reported bugs from testing

\- \[ ] Categorize by severity:

&nbsp; - Critical: Blocks launch

&nbsp; - High: Significant impact

&nbsp; - Medium: Minor impact

&nbsp; - Low: Cosmetic

\- \[ ] Prioritize critical and high severity bugs



\### 3.6.2 Fix Critical Bugs

\- \[ ] Fix all critical bugs

\- \[ ] Test fixes thoroughly

\- \[ ] Document fixes in changelog



\### 3.6.3 UI Polish

\- \[ ] Review UI for consistency:

&nbsp; - Colors match design

&nbsp; - Fonts consistent

&nbsp; - Spacing consistent

&nbsp; - Animations smooth

\- \[ ] Fix any visual inconsistencies

\- \[ ] Test on different browsers (Chrome, Edge, Firefox)

\- \[ ] Test on different operating systems (Windows, macOS)



\### 3.6.4 Performance Optimization

\- \[ ] Profile frontend with React DevTools Profiler

\- \[ ] Optimize re-renders (memoization if needed)

\- \[ ] Optimize bundle size:

&nbsp; - Run `npm run build` and check bundle size

&nbsp; - Use code splitting if bundle >500KB

\- \[ ] Test loading performance on slow connection (throttle network in DevTools)



\*\*Acceptance Criteria:\*\*

\- All critical bugs fixed

\- High priority bugs fixed

\- UI is polished and consistent

\- Performance meets NFR targets



---



\# PHASE 4: Deployment \& Launch

\*\*Duration:\*\* Days 25-30 (6 days)  

\*\*Goal:\*\* Deploy to production and launch



\## 4.1 Pre-Deployment Checklist



\### 4.1.1 Code Review

\- \[ ] Review all code for quality:

&nbsp; - Consistent style (ESLint/Prettier)

&nbsp; - No console.logs in production code

&nbsp; - No commented-out code

&nbsp; - No TODOs or FIXMEs

\- \[ ] Run linter:

```bash

npm run lint --prefix backend

npm run lint --prefix frontend

```

\- \[ ] Fix any linting errors



\### 4.1.2 Security Audit

\- \[ ] Run npm audit:

```bash

npm audit --prefix backend

npm audit --prefix frontend

```

\- \[ ] Fix critical vulnerabilities

\- \[ ] Update dependencies to latest stable versions



\### 4.1.3 Environment Configuration

\- \[ ] Create production `.env` file with:

&nbsp; - `NODE\_ENV=production`

&nbsp; - Database connection string (Azure PostgreSQL)

&nbsp; - FreshService API key (from Key Vault)

&nbsp; - Session secret (from Key Vault)

&nbsp; - Application Insights connection string

\- \[ ] Verify all secrets in Key Vault

\- \[ ] Test loading secrets from Key Vault



\### 4.1.4 Database Preparation

\- \[ ] Run migrations on production database:

```bash

npx prisma migrate deploy

```

\- \[ ] Verify all tables created

\- \[ ] Run initial data sync (technicians + tickets)

\- \[ ] Verify data looks correct



\*\*Acceptance Criteria:\*\*

\- Code is clean and linted

\- No security vulnerabilities

\- Environment configured correctly

\- Production database ready



---



\## 4.2 CI/CD Pipeline Setup



\### 4.2.1 GitHub Actions Workflow

\- \[ ] Create `.github/workflows/deploy.yml`

\- \[ ] Configure workflow triggers:

&nbsp; - Push to `main` branch → deploy to production

&nbsp; - Push to `develop` branch → deploy to staging

\- \[ ] Add workflow steps:

&nbsp; 1. Checkout code

&nbsp; 2. Set up Node.js 20

&nbsp; 3. Install dependencies (backend + frontend)

&nbsp; 4. Run tests (backend + frontend)

&nbsp; 5. Build frontend (`npm run build`)

&nbsp; 6. Run Prisma migrations

&nbsp; 7. Deploy to Azure App Service

\- \[ ] Configure secrets in GitHub:

&nbsp; - `AZURE\_WEBAPP\_PUBLISH\_PROFILE`

&nbsp; - `DATABASE\_URL`

\- \[ ] Test workflow by pushing to develop branch



\### 4.2.2 Azure Deployment Configuration

\- \[ ] Configure App Service deployment:

&nbsp; - Set Node.js version to 20

&nbsp; - Set startup command: `node backend/src/app.js`

&nbsp; - Configure app settings (environment variables)

\- \[ ] Set up deployment slots:

&nbsp; - Production slot

&nbsp; - Staging slot

\- \[ ] Configure slot swap settings



\### 4.2.3 Automated Testing in CI

\- \[ ] Ensure tests run in CI pipeline

\- \[ ] Configure test results reporting

\- \[ ] Set up pipeline to fail if tests fail

\- \[ ] Add code coverage reporting (optional)



\*\*Acceptance Criteria:\*\*

\- CI/CD pipeline configured

\- Tests run automatically on push

\- Deployment to staging works

\- Ready to deploy to production



---



\## 4.3 Production Deployment



\### 4.3.1 Initial Deployment

\- \[ ] Deploy backend to Azure App Service:

&nbsp; - Push code to `main` branch (triggers CI/CD)

&nbsp; - Monitor deployment logs

&nbsp; - Verify deployment successful

\- \[ ] Test production backend:

&nbsp; - Check `/api/health` endpoint

&nbsp; - Verify database connection

&nbsp; - Verify FreshService sync running

\- \[ ] Deploy frontend:

&nbsp; - Frontend build served by backend (static files)

&nbsp; - Verify frontend loads in browser

\- \[ ] Test full application in production:

&nbsp; - Login

&nbsp; - View dashboard

&nbsp; - Navigate to tech detail

&nbsp; - Test settings

&nbsp; - Verify real-time updates



\### 4.3.2 SSL/TLS Configuration

\- \[ ] Ensure HTTPS is enabled (Azure App Service auto-provides)

\- \[ ] Test HTTPS redirect (HTTP → HTTPS)

\- \[ ] Verify SSL certificate is valid



\### 4.3.3 Domain Configuration (Optional)

\- \[ ] If using custom domain:

&nbsp; - Configure DNS records

&nbsp; - Add custom domain to App Service

&nbsp; - Enable SSL for custom domain

&nbsp; - Test custom domain works



\*\*Acceptance Criteria:\*\*

\- Application deployed to production

\- HTTPS working correctly

\- All features work in production

\- No errors in Application Insights



---



\## 4.4 Monitoring \& Alerts



\### 4.4.1 Application Insights Setup

\- \[ ] Verify Application Insights is logging:

&nbsp; - Requests

&nbsp; - Exceptions

&nbsp; - Dependencies (database, FreshService API)

&nbsp; - Custom events (sync jobs)

\- \[ ] Create dashboards:

&nbsp; - Request rate

&nbsp; - Response times

&nbsp; - Error rate

&nbsp; - Sync job success rate

\- \[ ] Test dashboards show real data



\### 4.4.2 Alert Configuration

\- \[ ] Set up alerts in Application Insights:

&nbsp; - Server response time >2 seconds (send email to IT Manager)

&nbsp; - Failed requests >5% (send email)

&nbsp; - Exception rate spike (send email)

&nbsp; - FreshService API failures (send email)

\- \[ ] Test alerts by triggering conditions (if possible)

\- \[ ] Configure alert recipients



\### 4.4.3 Health Monitoring

\- \[ ] Set up uptime monitoring (ping `/api/health` every 5 minutes)

\- \[ ] Configure uptime alerts (send email if down)

\- \[ ] Test health endpoint responds correctly



\*\*Acceptance Criteria:\*\*

\- Application Insights logging all data

\- Dashboards show real-time metrics

\- Alerts configured and tested

\- Uptime monitoring active



---



\## 4.5 Documentation



\### 4.5.1 Deployment Documentation

\- \[ ] Create `/docs/DEPLOYMENT.md`:

&nbsp; - Prerequisites

&nbsp; - Step-by-step deployment guide

&nbsp; - Environment variables reference

&nbsp; - Troubleshooting common issues

\- \[ ] Document rollback procedure



\### 4.5.2 Operations Documentation

\- \[ ] Create `/docs/OPERATIONS.md`:

&nbsp; - How to monitor the application

&nbsp; - How to check sync job status

&nbsp; - How to manually trigger sync

&nbsp; - How to investigate errors

&nbsp; - How to restart the application

\- \[ ] Document common maintenance tasks



\### 4.5.3 User Documentation

\- \[ ] Finalize `/docs/USER\_GUIDE.md`

\- \[ ] Add screenshots of production UI

\- \[ ] Document all features

\- \[ ] Create troubleshooting section for users



\### 4.5.4 README Update

\- \[ ] Update root README.md:

&nbsp; - Project description

&nbsp; - Features

&nbsp; - Tech stack

&nbsp; - Setup instructions (local dev)

&nbsp; - Deployment instructions

&nbsp; - Contributing guidelines

&nbsp; - License



\*\*Acceptance Criteria:\*\*

\- All documentation is complete and accurate

\- Operations team can deploy and maintain app

\- Users have clear guide



---



\## 4.6 Launch



\### 4.6.1 Soft Launch

\- \[ ] Grant IT Coordinator access to production

\- \[ ] Provide login credentials

\- \[ ] Walk through how to use dashboard

\- \[ ] Ask coordinator to use alongside FreshService for 1 week

\- \[ ] Monitor usage and errors daily



\### 4.6.2 Feedback Collection

\- \[ ] After 3 days, collect feedback:

&nbsp; - What's working well?

&nbsp; - Any bugs?

&nbsp; - Any confusion?

&nbsp; - Any missing features?

\- \[ ] Address critical feedback quickly

\- \[ ] Log non-critical feedback for Phase 2



\### 4.6.3 Full Launch

\- \[ ] After 1 week, full launch:

&nbsp; - IT Coordinator relies on dashboard for all assignments

&nbsp; - Stop using FreshService reports

\- \[ ] Announce launch to IT team (optional)

\- \[ ] Monitor usage for first week:

&nbsp; - Check error rates

&nbsp; - Check performance metrics

&nbsp; - Check user satisfaction

\- \[ ] Celebrate launch! 🎉



\*\*Acceptance Criteria:\*\*

\- IT Coordinator successfully uses dashboard

\- No critical bugs in production

\- Performance meets NFR targets

\- User satisfaction >8/10



---



\## 4.7 Post-Launch Monitoring



\### 4.7.1 Week 1 Monitoring

\- \[ ] Check Application Insights daily:

&nbsp; - Any exceptions?

&nbsp; - Any performance issues?

&nbsp; - Sync job success rate

\- \[ ] Check in with IT Coordinator daily:

&nbsp; - Any issues?

&nbsp; - Any questions?

\- \[ ] Fix any urgent bugs immediately



\### 4.7.2 Week 2-4 Monitoring

\- \[ ] Check Application Insights 2-3 times per week

\- \[ ] Check in with IT Coordinator weekly

\- \[ ] Collect usage metrics:

&nbsp; - Average page load time

&nbsp; - Dashboard refresh rate

&nbsp; - Error rate

\- \[ ] Compare metrics to KPI targets (from PRD)



\### 4.7.3 30-Day Review

\- \[ ] After 30 days, measure KPIs:

&nbsp; - Time to assign (target: <2 minutes, 70% reduction)

&nbsp; - Load balance (standard deviation <2.0)

&nbsp; - Coordinator NPS (target: >8/10)

&nbsp; - Dashboard uptime (target: >99.5%)

&nbsp; - Data accuracy (target: <1% discrepancy)

\- \[ ] Conduct retrospective with team:

&nbsp; - What went well?

&nbsp; - What could be improved?

&nbsp; - Lessons learned

\- \[ ] Document findings in `/docs/30DAY\_REVIEW.md`



\*\*Acceptance Criteria:\*\*

\- No major issues in first 30 days

\- KPIs meet or exceed targets

\- IT Coordinator is satisfied (NPS >8)

\- Team retrospective completed



---



\# PHASE 5: Future Enhancements (Post-Launch)

\*\*Duration:\*\* Ongoing  

\*\*Goal:\*\* Implement Phase 2 and 3 features from PRD



\## 5.1 Phase 2 Features (Analytics \& Insights)



\### 5.1.1 Average Resolution Time

\- \[ ] Update ticket sync to calculate resolution time:

&nbsp; - `resolution\_time\_minutes = resolvedAt - assignedAt`

\- \[ ] Add resolution time to tech cards

\- \[ ] Add average resolution time to tech detail page

\- \[ ] Create chart showing resolution time trend



\### 5.1.2 Ticket Age Indicators

\- \[ ] Calculate ticket age (time since created)

\- \[ ] Add "age" column to ticket lists

\- \[ ] Color-code by age:

&nbsp; - Green: <4 hours

&nbsp; - Yellow: 4-8 hours

&nbsp; - Red: >8 hours

\- \[ ] Add sorting by age



\### 5.1.3 Priority Breakdown

\- \[ ] Add priority breakdown to dashboard stats:

&nbsp; - Count of P1, P2, P3, P4 tickets

\- \[ ] Create donut chart showing priority distribution

\- \[ ] Add priority filter to tech detail page



\### 5.1.4 Historical Trends

\- \[ ] Store daily statistics in new table:

&nbsp; - Date, total tickets, avg per tech, etc.

\- \[ ] Create trends page showing:

&nbsp; - Tickets per day (last 7 days)

&nbsp; - Average per tech (last 7 days)

&nbsp; - Week-over-week comparison

\- \[ ] Add charts (line charts, bar charts)



\### 5.1.5 Performance Leaderboard

\- \[ ] Create leaderboard page showing:

&nbsp; - Top performers (most tickets resolved)

&nbsp; - Fastest resolvers (best avg resolution time)

&nbsp; - Most proactive (highest self-pick rate)

\- \[ ] Make it optional (can disable for privacy)

\- \[ ] Add friendly competition element



\*\*Estimated Effort:\*\* 2-3 weeks



---



\## 5.2 Phase 3 Features (Advanced)



\### 5.2.1 Predictive Analytics

\- \[ ] Implement ML model to predict:

&nbsp; - Which tech will finish soonest

&nbsp; - Which tech should get next ticket

\- \[ ] Display predictions on dashboard

\- \[ ] A/B test: coordinator assignments vs ML recommendations

\- \[ ] Measure improvement in load balance



\### 5.2.2 Smart Assignment Recommendations

\- \[ ] Add "Recommended" badge to tech cards

\- \[ ] Use algorithm based on:

&nbsp; - Current open tickets

&nbsp; - Average resolution time

&nbsp; - Self-pick rate

&nbsp; - Skills/expertise (if tracked)

\- \[ ] Allow coordinator to override recommendations



\### 5.2.3 Slack/Teams Notifications

\- \[ ] Integrate with Slack/Teams

\- \[ ] Send notifications:

&nbsp; - Tech gets assigned a ticket

&nbsp; - New unassigned ticket in queue

&nbsp; - SLA breach warning

\- \[ ] Make notifications configurable (opt-in)



\### 5.2.4 Multi-User Access

\- \[ ] Add user management:

&nbsp; - Admin role (IT Manager)

&nbsp; - Coordinator role (can view + assign)

&nbsp; - Tech role (can view own tickets only)

\- \[ ] Implement role-based permissions

\- \[ ] Add user management UI

\- \[ ] Test with multiple users



\### 5.2.5 Mobile Responsiveness

\- \[ ] Make dashboard fully responsive for mobile

\- \[ ] Create mobile-optimized layouts

\- \[ ] Test on iOS and Android

\- \[ ] Consider native app (React Native) in future



\*\*Estimated Effort:\*\* 4-6 weeks



---



\## 5.3 Phase 4 Features (Expansion)



\### 5.3.1 Multiple Workspace Support

\- \[ ] Support multiple FreshService workspaces (not just IT)

\- \[ ] Add workspace selector to dashboard

\- \[ ] Sync tickets from all workspaces

\- \[ ] Filter dashboard by workspace



\### 5.3.2 SLA Tracking

\- \[ ] Import SLA policies from FreshService

\- \[ ] Track SLA compliance per ticket

\- \[ ] Show SLA status on dashboard (on-track, at-risk, breached)

\- \[ ] Send alerts for SLA breaches



\### 5.3.3 Custom Reporting

\- \[ ] Create report builder:

&nbsp; - Select date range

&nbsp; - Select metrics (tickets resolved, avg time, etc.)

&nbsp; - Select grouping (by tech, by priority, by date)

\- \[ ] Export reports as Excel or PDF

\- \[ ] Schedule automated reports (email weekly)



\### 5.3.4 Integration with Other Tools

\- \[ ] Integrate with Jira (if used)

\- \[ ] Integrate with ServiceNow (if used)

\- \[ ] Support webhooks for custom integrations

\- \[ ] Create API for third-party tools



\*\*Estimated Effort:\*\* 6-8 weeks



---



\# APPENDIX



\## A. Definition of Done



A feature/task is considered "Done" when:

\- \[ ] Code is written and follows style guide

\- \[ ] Unit tests written and passing (>70% coverage)

\- \[ ] Integration tests written and passing (if applicable)

\- \[ ] Code reviewed by peer (if applicable)

\- \[ ] Manually tested in local environment

\- \[ ] Tested in staging environment

\- \[ ] No critical bugs

\- \[ ] Documentation updated

\- \[ ] Deployed to production (if applicable)

\- \[ ] User acceptance testing passed (if applicable)



---



\## B. Risk Mitigation



\### Critical Risks \& Mitigation Strategies



| Risk | Mitigation |

|------|------------|

| FreshService API changes | Version API calls, monitor release notes, automated tests |

| Self-picked detection inaccurate | Validate with spot-checks, iterate algorithm, allow manual override |

| Azure outage | Graceful degradation (show stale data), status page, backup plan |

| Database performance issues | Optimize queries, add indexes, scale tier if needed |

| Coordinator doesn't adopt | Involve in design, provide training, continuous feedback |

| Timezone bugs | Extensive testing, use battle-tested libraries, edge case testing |



---



\## C. Communication Plan



\### Daily Standup (During Development)

\- What did you do yesterday?

\- What will you do today?

\- Any blockers?



\### Weekly Check-ins (With IT Coordinator)

\- Demo progress

\- Collect feedback

\- Answer questions



\### Bi-weekly Sprint Reviews (With IT Manager)

\- Demo completed features

\- Review progress vs timeline

\- Adjust priorities if needed



---



\## D. Success Criteria Summary



\### MVP Launch Criteria

\- \[ ] Dashboard loads in <2 seconds

\- \[ ] Data syncs within 30 seconds

\- \[ ] Zero critical bugs after 1 week UAT

\- \[ ] Coordinator completes 5 assignments successfully

\- \[ ] Self-picked detection >95% accurate



\### Post-Launch KPIs (30 days)

\- \[ ] Time to assign: <2 minutes (70% reduction)

\- \[ ] Load balance: Std dev <2.0 (40% improvement)

\- \[ ] Coordinator NPS: >8/10

\- \[ ] Dashboard uptime: >99.5%

\- \[ ] Data accuracy: <1% discrepancy

\- \[ ] Adoption rate: >90% of assignments



---



\## E. Quick Reference - Key Contacts



| Role | Contact | Responsibility |

|------|---------|----------------|

| Product Owner | IT Manager | Final decisions, approvals |

| Primary User | IT Coordinator | Requirements, UAT, feedback |

| Tech Lead | TBD | Architecture, code review |

| DevOps | TBD | Azure, deployment, monitoring |

| FreshService Admin | TBD | API access, workspace config |



---



\## F. Tools \& Resources



\### Development Tools

\- VS Code

\- Postman / Thunder Client

\- Prisma Studio

\- Git / GitHub

\- Docker Desktop



\### Azure Resources

\- Azure Portal: https://portal.azure.com

\- Application Insights: (link after setup)

\- Key Vault: (link after setup)



\### Documentation

\- PRD: `/docs/PRD.md`

\- API Docs: `/docs/API.md`

\- User Guide: `/docs/USER\_GUIDE.md`

\- Deployment Guide: `/docs/DEPLOYMENT.md`



\### External Resources

\- FreshService API Docs: https://api.freshservice.com/v2/

\- Prisma Docs: https://www.prisma.io/docs

\- React Docs: https://react.dev

\- Tailwind Docs: https://tailwindcss.com/docs



---



\*\*END OF TODO LIST\*\*



This to-do list should be copied to a project management tool (Jira, GitHub Projects, Trello, etc.) for tracking progress. Each checkbox represents a discrete task that can be assigned and completed.



Good luck with the development! 🚀

