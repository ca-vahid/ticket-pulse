\# Product Requirements Document (PRD)

\## FreshService Real-Time IT Dashboard



\*\*Version:\*\* 1.0  

\*\*Last Updated:\*\* October 17, 2025  

\*\*Product Owner:\*\* IT Manager  

\*\*Status:\*\* Planning Phase



---



\## 1. Executive Summary



\### Product Name

\*\*FreshService Real-Time IT Dashboard\*\* (Internal codename: "LoadBalancer")



\### Vision Statement

Empower IT coordinators with instant visibility into technician workload distribution, enabling fair, informed, and efficient ticket assignment decisions that improve team performance and reduce technician burnout.



\### One-Liner

A real-time dashboard that shows IT coordinators exactly who should get the next ticket, based on current workload, self-picked vs assigned tickets, and historical performance metrics.



---



\## 2. Problem Statement



\### Current State (The Pain)

Our IT team of 12 technicians uses FreshService for helpdesk ticketing. When tickets arrive, they either go into a queue for self-pickup or get manually assigned by the IT coordinator. \*\*The critical problem:\*\* our IT coordinator has zero real-time visibility into workload distribution.



\*\*Today's Reality:\*\*

\- Coordinator doesn't know how many tickets each tech has right now

\- Can't see who picked tickets themselves vs who was assigned

\- FreshService's built-in reporting is slow, outdated, and visually poor

\- Making assignment decisions is based on guesswork or memory

\- Risk of overloading some techs while others are underutilized

\- No way to track if assignments are fair throughout the day



\### Impact

\- \*\*Inefficiency:\*\* Coordinators waste time clicking through FreshService to check individual tech queues

\- \*\*Unfairness:\*\* Some techs get overloaded while others coast

\- \*\*Frustration:\*\* Techs feel assignments are arbitrary or unfair

\- \*\*Slower Response:\*\* Delays in assignment mean slower ticket resolution

\- \*\*No Accountability:\*\* Can't track who self-picks vs who waits for assignments



\### Why Existing Solutions Don't Work

\- \*\*FreshService Native Reports:\*\* Too slow, requires manual refresh, outdated UI, not real-time

\- \*\*Manual Tracking:\*\* Spreadsheets or memory-based tracking is error-prone and not scalable

\- \*\*Third-party Tools:\*\* Generic dashboards don't understand our specific workflow (self-picked vs assigned)



---



\## 3. Target Users



\### Primary User: IT Coordinator

\*\*Profile:\*\*

\- Name: Sarah (fictional persona)

\- Role: IT Coordinator / Ticket Dispatcher

\- Responsibilities: Assign incoming tickets, balance workload, ensure SLAs are met

\- Pain: Makes 20-30 assignment decisions per day without data

\- Goals: Fair distribution, keep everyone busy but not overwhelmed, meet SLAs



\*\*User Story:\*\*

> "As an IT Coordinator, I need to see at a glance which technician has the lightest load right now, so I can assign the next ticket fairly and efficiently without manually checking everyone's queue in FreshService."



\### Secondary Users (Future)

\- \*\*IT Manager:\*\* Monitor team performance, identify bottlenecks

\- \*\*Technicians:\*\* Self-awareness of their own workload vs peers

\- \*\*C-Suite:\*\* High-level IT operations metrics



---



\## 4. Goals \& Success Metrics



\### Business Goals

1\. \*\*Reduce ticket assignment time\*\* by 70% (from ~2 minutes to ~30 seconds per assignment)

2\. \*\*Improve workload fairness\*\* - standard deviation of tickets per tech drops by 40%

3\. \*\*Increase coordinator confidence\*\* in assignment decisions (qualitative survey)

4\. \*\*Enable data-driven decisions\*\* instead of gut-feel assignments



\### Success Metrics (KPIs)



\*\*Primary Metrics:\*\*

\- \*\*Time to Assign:\*\* Average time from ticket creation to assignment < 2 minutes

\- \*\*Load Balance Index:\*\* Standard deviation of tickets per tech per day < 2.0

\- \*\*Coordinator Satisfaction:\*\* NPS score > 8/10 after 30 days



\*\*Secondary Metrics:\*\*

\- \*\*Dashboard Load Time:\*\* < 2 seconds on initial load

\- \*\*Data Freshness:\*\* Dashboard shows data within 30 seconds of changes in FreshService

\- \*\*Uptime:\*\* 99.5% availability during business hours (7 AM - 6 PM PST)

\- \*\*Adoption:\*\* Coordinator uses dashboard for 90%+ of manual assignments



\*\*Anti-Metrics (What We Don't Want):\*\*

\- Don't optimize for total tickets closed at the expense of quality

\- Don't create unhealthy competition between techs

\- Don't make assignments feel robotic (coordinator should still use judgment)



---



\## 5. Scope



\### In Scope (Phase 1 - MVP)



\*\*Core Features:\*\*

1\. Real-time technician workload dashboard

2\. Today's ticket count per technician

3\. Self-picked vs assigned ticket breakdown

4\. Visual load indicators (color-coded)

5\. Click-through to see individual tickets per tech

6\. Auto-refresh with configurable interval (default 30s)

7\. Simple password authentication

8\. IT workspace filtering

9\. Timezone support (PST default, with option for tech's local timezone)



\*\*Must-Have Data Points:\*\*

\- Total tickets assigned today

\- Self-picked tickets count

\- Assigned tickets count

\- Currently open tickets

\- Ticket status (open, in-progress, resolved)

\- Ticket priority

\- Assignment timestamp

\- Last activity timestamp



\### Out of Scope (Phase 1)



\*\*Explicitly NOT included in MVP:\*\*

\- Average resolution time per tech \*(Phase 2)\*

\- Ticket age indicators \*(Phase 2)\*

\- Priority breakdown visualizations \*(Phase 2)\*

\- Historical trends (week-over-week) \*(Phase 2)\*

\- Advanced filtering (by priority, type) \*(Phase 2)\*

\- Mobile responsiveness \*(Not needed)\*

\- Multi-user access / Role-based permissions \*(Phase 3)\*

\- Predictive analytics \*(Phase 3)\*

\- Notifications (Slack/Teams) \*(Phase 3)\*

\- SLA tracking \*(Future)\*

\- Performance reviews / reporting \*(Future)\*



\### Technical Constraints

\- Must work with FreshService Enterprise API

\- Must run on Azure infrastructure (App Service + PostgreSQL)

\- Must filter by IT workspace only

\- Must respect FreshService API rate limits

\- Must handle multiple office timezones (Halifax to Vancouver)

\- "Today" resets at midnight PST



---



\## 6. User Experience (UX)



\### Core User Journey: Assigning a Ticket



\*\*Current Journey (Before):\*\*

1\. Coordinator sees new ticket in FreshService

2\. Opens FreshService in new tab

3\. Manually checks each tech's ticket list (12 clicks minimum)

4\. Tries to remember who's busy today

5\. Makes educated guess on assignment

6\. Assigns ticket

7\. \*\*Total Time:\*\* ~2 minutes per ticket



\*\*New Journey (After):\*\*

1\. Coordinator sees new ticket in FreshService

2\. Glances at dashboard (already open on second monitor)

3\. Sees exactly who has the lightest load with visual indicators

4\. Makes instant decision

5\. Assigns ticket in FreshService

6\. Dashboard auto-updates within 30 seconds

7\. \*\*Total Time:\*\* ~15 seconds per ticket



\### UI Design Principles

1\. \*\*Glanceable:\*\* Critical info visible in < 2 seconds

2\. \*\*Minimal Clicks:\*\* Primary use case requires zero clicks (just look)

3\. \*\*Visual Hierarchy:\*\* Most important data (current load) is biggest/boldest

4\. \*\*Real-time Feedback:\*\* Show when last updated, refresh indicator

5\. \*\*No Clutter:\*\* Only show what matters for assignment decisions

6\. \*\*Accessible:\*\* High contrast, readable fonts, color + text indicators

7\. \*\*Professional:\*\* Clean, modern, trustworthy (this affects real people's workload)



\### Wireframe Concept



```

┌────────────────────────────────────────────────────────────────┐

│  🎯 FreshService IT Dashboard          Last updated: 5s ago ⟳  │

│                                                        \[Settings] │

├────────────────────────────────────────────────────────────────┤

│                                                                  │

│  📊 Today's Overview (PST)                                      │

│  Total Tickets: 47  |  Unassigned: 3  |  Avg per Tech: 3.9     │

│                                                                  │

├──────────────┬──────────────┬──────────────┬──────────────────┤

│              │              │              │                  │

│  👤 John     │  👤 Sarah    │  👤 Mike     │  👤 Emma        │

│  Halifax     │  Toronto     │  Vancouver   │  Halifax        │

│  ─────────── │  ─────────── │  ─────────── │  ───────────    │

│  🟢 Light    │  🟡 Medium   │  🔴 Heavy    │  🟢 Light       │

│              │              │              │                  │

│  Today: 3    │  Today: 5    │  Today: 8    │  Today: 2       │

│  • Self: 2   │  • Self: 1   │  • Self: 3   │  • Self: 1      │

│  • Assgn: 1  │  • Assgn: 4  │  • Assgn: 5  │  • Assgn: 1     │

│  Open: 2     │  Open: 4     │  Open: 6     │  Open: 2        │

│              │              │              │                  │

│  \[View ↗]    │  \[View ↗]    │  \[View ↗]    │  \[View ↗]       │

│              │              │              │                  │

├──────────────┼──────────────┼──────────────┼──────────────────┤

│  (8 more technician cards...)                                  │

└────────────────────────────────────────────────────────────────┘

```



\*\*Click "View" for a Tech:\*\*

```

┌────────────────────────────────────────────────────────────────┐

│  ← Back to Dashboard                                            │

│                                                                  │

│  👤 Mike Chen - Vancouver (PST)                                 │

│  Today: 8 tickets  |  Open: 6  |  Resolved: 2                  │

│                                                                  │

│  📋 Open Tickets (6)                                            │

│  ┌────────────────────────────────────────────────────────────┐│

│  │ #12345 | P2 | VPN not working | Assigned 2h ago | Self ✓  ││

│  │ #12367 | P1 | Email down | Assigned 45m ago | By Sarah     ││

│  │ #12401 | P3 | Password reset | Assigned 20m ago | Self ✓   ││

│  │ ...                                                          ││

│  └────────────────────────────────────────────────────────────┘│

│                                                                  │

│  ✅ Resolved Today (2)                                          │

│  │ #12289 | P2 | Printer jam | Resolved 3h ago (1.5h res time)││

│  │ #12312 | P3 | Software install | Resolved 1h ago (0.5h)    ││

└────────────────────────────────────────────────────────────────┘

```



\### Color Coding System

\- 🟢 \*\*Green (Light Load):\*\* 0-3 open tickets

\- 🟡 \*\*Yellow (Medium Load):\*\* 4-6 open tickets  

\- 🔴 \*\*Red (Heavy Load):\*\* 7+ open tickets

\- ⚪ \*\*Gray (Offline):\*\* Tech marked as unavailable/OOO



\### Responsive Behavior

\- \*\*Desktop Primary:\*\* Optimized for 1920x1080 (typical second monitor)

\- \*\*Minimum Width:\*\* 1280px (dashboard is for desktop use only)

\- \*\*Auto-layout:\*\* Technician cards flow in grid, responsive to window size

\- \*\*Mobile:\*\* Not required (Phase 1)



---



\## 7. Functional Requirements



\### FR-1: Authentication

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I need to securely access the dashboard so that sensitive team data is protected.



\*\*Requirements:\*\*

\- FR-1.1: Simple password-protected login page

\- FR-1.2: Password stored as hashed value (bcrypt)

\- FR-1.3: Session timeout after 8 hours of inactivity

\- FR-1.4: "Remember Me" option (30-day cookie)

\- FR-1.5: Logout button

\- FR-1.6: No password reset flow needed (IT Manager can manually reset)



\*\*Acceptance Criteria:\*\*

\- Login page appears on initial visit

\- Incorrect password shows error message

\- Correct password grants access and creates session

\- Session persists across page refreshes

\- Logout clears session and redirects to login



---



\### FR-2: Real-Time Data Sync

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I need the dashboard to show current data so that I make assignment decisions based on accurate information.



\*\*Requirements:\*\*

\- FR-2.1: Backend polls FreshService API every 30 seconds (configurable)

\- FR-2.2: Filter tickets to IT workspace only

\- FR-2.3: Fetch all tickets created/updated in the last 24 hours (PST)

\- FR-2.4: Sync technician data (agents in IT workspace)

\- FR-2.5: Store data in PostgreSQL database

\- FR-2.6: Push updates to frontend via Server-Sent Events (SSE)

\- FR-2.7: Show "Last updated: Xs ago" timestamp on dashboard

\- FR-2.8: Show loading/syncing indicator during updates



\*\*Acceptance Criteria:\*\*

\- Dashboard updates within 30 seconds of changes in FreshService

\- Data accuracy: 100% match between dashboard and FreshService

\- No duplicate tickets in database

\- Graceful handling of FreshService API errors (retry logic)

\- Frontend shows visual indicator during background sync



---



\### FR-3: Technician Workload Cards

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I need to see each technician's current workload so that I can choose who to assign the next ticket to.



\*\*Requirements:\*\*

\- FR-3.1: Display card for each active technician (agent in IT workspace)

\- FR-3.2: Show technician name and location/timezone

\- FR-3.3: Show total tickets assigned today (since midnight PST)

\- FR-3.4: Break down: self-picked vs assigned by someone else

\- FR-3.5: Show count of currently open tickets (status = open or in-progress)

\- FR-3.6: Color-code cards based on open ticket count (green/yellow/red)

\- FR-3.7: Sort technicians by open ticket count (ascending - lightest first)

\- FR-3.8: Click card or "View" button to see ticket details for that tech



\*\*Acceptance Criteria:\*\*

\- Each tech card shows: name, location, today's total, self-picked count, assigned count, open count

\- Cards are color-coded correctly based on thresholds

\- Clicking a card navigates to tech detail view

\- Cards update in real-time when data changes

\- Sorting is correct (lightest load first)



---



\### FR-4: Self-Picked vs Assigned Detection

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I want to know which techs are proactive (self-picking) vs waiting for assignments so I can make fair decisions.



\*\*Requirements:\*\*

\- FR-4.1: Analyze FreshService ticket activities/audit log to determine assignment source

\- FR-4.2: If tech assigned themselves → mark as "self-picked"

\- FR-4.3: If another user (coordinator) assigned → mark as "assigned by \[name]"

\- FR-4.4: Display self-picked count vs assigned count on tech cards

\- FR-4.5: Visual indicator on individual tickets (checkmark for self-picked)



\*\*Algorithm:\*\*

```

IF ticket.assigned\_to == ticket.last\_activity.performed\_by:

&nbsp;   is\_self\_picked = TRUE

ELSE:

&nbsp;   is\_self\_picked = FALSE

&nbsp;   assigned\_by = ticket.last\_activity.performed\_by

```



\*\*Acceptance Criteria:\*\*

\- Self-picked tickets are correctly identified (95%+ accuracy)

\- Assigned tickets show who assigned them

\- Counts match manual verification in FreshService



---



\### FR-5: Ticket Detail View

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I want to see what tickets a technician is working on so I can understand their workload context before assigning more.



\*\*Requirements:\*\*

\- FR-5.1: Click technician card → navigate to detail page

\- FR-5.2: Show tech name, location, today's summary stats

\- FR-5.3: List all open tickets for that tech with:

&nbsp; - Ticket ID (clickable link to FreshService)

&nbsp; - Priority (P1, P2, P3, P4)

&nbsp; - Subject/title

&nbsp; - Time since assigned

&nbsp; - Self-picked indicator

\- FR-5.4: List resolved tickets from today (collapsed by default)

\- FR-5.5: Sort tickets by priority (P1 first), then by time assigned

\- FR-5.6: "Back to Dashboard" button



\*\*Acceptance Criteria:\*\*

\- Detail page loads in < 1 second

\- All open tickets for tech are shown

\- Clicking ticket ID opens FreshService in new tab

\- Back button returns to main dashboard



---



\### FR-6: Timezone Handling

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I need consistent timestamps across multiple offices so I don't get confused by timezone differences.



\*\*Requirements:\*\*

\- FR-6.1: Dashboard displays all times in PST by default

\- FR-6.2: Settings option to toggle "Show local time for each tech"

\- FR-6.3: "Today" is defined as midnight PST to 11:59 PM PST

\- FR-6.4: Store technician's timezone in database

\- FR-6.5: Properly convert FreshService UTC timestamps to PST/local time



\*\*Timezone Data:\*\*

\- Halifax: America/Halifax (AST/ADT, UTC-4/-3)

\- Toronto: America/Toronto (EST/EDT, UTC-5/-4)

\- Vancouver: America/Vancouver (PST/PDT, UTC-8/-7)



\*\*Acceptance Criteria:\*\*

\- All timestamps display in PST by default

\- Toggle works to show each tech's local time

\- "Today" resets correctly at midnight PST

\- No timezone-related bugs (tickets appearing on wrong day)



---



\### FR-7: Dashboard Overview Stats

\*\*Priority:\*\* P1 (Should-Have)  

\*\*User Story:\*\* As the IT Coordinator, I want to see overall team metrics so I understand the big picture before making assignments.



\*\*Requirements:\*\*

\- FR-7.1: Show total tickets created today

\- FR-7.2: Show unassigned tickets count (in queue)

\- FR-7.3: Show average tickets per technician

\- FR-7.4: Show last refresh timestamp

\- FR-7.5: Show refresh interval (e.g., "Updates every 30s")



\*\*Acceptance Criteria:\*\*

\- Stats are accurate and update in real-time

\- Displayed prominently at top of dashboard

\- Calculations are correct (avg = total / active techs)



---



\### FR-8: Configurable Settings

\*\*Priority:\*\* P1 (Should-Have)  

\*\*User Story:\*\* As the IT Coordinator, I want to adjust refresh rate and timezone settings so the dashboard works best for my workflow.



\*\*Requirements:\*\*

\- FR-8.1: Settings panel (overlay or dedicated page)

\- FR-8.2: Adjust refresh interval: 15s, 30s, 60s, 120s options

\- FR-8.3: Toggle: "Show local time for each tech" (default: OFF, show PST)

\- FR-8.4: Settings persist in browser localStorage

\- FR-8.5: Reset to defaults option



\*\*Acceptance Criteria:\*\*

\- Settings panel is accessible from main dashboard

\- Changes take effect immediately (no page reload)

\- Settings persist across sessions

\- Reset button restores all defaults



---



\### FR-9: Error Handling \& Reliability

\*\*Priority:\*\* P0 (Must-Have)  

\*\*User Story:\*\* As the IT Coordinator, I need the dashboard to handle errors gracefully so I can still do my job even when things go wrong.



\*\*Requirements:\*\*

\- FR-9.1: If FreshService API fails → show error banner, keep displaying last known data

\- FR-9.2: If database connection fails → log error, attempt reconnect

\- FR-9.3: If frontend loses connection → show "Offline" indicator, attempt reconnect

\- FR-9.4: Retry failed API calls with exponential backoff

\- FR-9.5: Log all errors to Azure Application Insights

\- FR-9.6: Never crash the frontend due to bad data



\*\*Acceptance Criteria:\*\*

\- Dashboard remains functional with stale data during API outages

\- User sees clear error messages (not technical jargon)

\- Errors are logged for debugging

\- Automatic recovery without user intervention



---



\## 8. Non-Functional Requirements



\### NFR-1: Performance

\- \*\*Page Load Time:\*\* < 2 seconds on first load (1920x1080, broadband connection)

\- \*\*Data Refresh Time:\*\* New data visible within 30 seconds of change in FreshService

\- \*\*Database Query Time:\*\* All queries < 500ms (p95)

\- \*\*API Response Time:\*\* Backend API < 200ms (p95)

\- \*\*Frontend Render Time:\*\* Dashboard re-renders < 100ms after data update



\### NFR-2: Reliability \& Availability

\- \*\*Uptime:\*\* 99.5% during business hours (7 AM - 6 PM PST, Mon-Fri)

\- \*\*Data Accuracy:\*\* 99.9% match between dashboard and FreshService

\- \*\*Zero Data Loss:\*\* All tickets synced from FreshService must be stored reliably

\- \*\*Graceful Degradation:\*\* Dashboard shows last known data if sync fails



\### NFR-3: Scalability

\- \*\*Technician Limit:\*\* Support up to 50 technicians (current: 12)

\- \*\*Ticket Volume:\*\* Handle 500+ tickets per day

\- \*\*Concurrent Users:\*\* Support 5 concurrent dashboard viewers (Phase 3)

\- \*\*Data Retention:\*\* Store 90 days of historical ticket data



\### NFR-4: Security

\- \*\*Authentication:\*\* Password-protected access (bcrypt hashing)

\- \*\*Transport:\*\* HTTPS only (SSL/TLS)

\- \*\*API Keys:\*\* FreshService API key stored in Azure Key Vault (not in code)

\- \*\*Database:\*\* PostgreSQL with encrypted connections

\- \*\*No PII Exposure:\*\* Don't log or display sensitive ticket content

\- \*\*Session Security:\*\* HTTP-only cookies, CSRF protection



\### NFR-5: Maintainability

\- \*\*Code Quality:\*\* ESLint + Prettier for consistent code style

\- \*\*Documentation:\*\* All API endpoints documented (README)

\- \*\*Logging:\*\* Structured logging with log levels (info, warn, error)

\- \*\*Monitoring:\*\* Azure Application Insights for health checks

\- \*\*Version Control:\*\* Git with semantic versioning



\### NFR-6: Usability

\- \*\*Learnability:\*\* Coordinator can use dashboard effectively within 5 minutes of first use

\- \*\*Efficiency:\*\* Reduce assignment decision time by 70% (current: 2 min → target: 30 sec)

\- \*\*Error Tolerance:\*\* Clear error messages, no cryptic technical jargon

\- \*\*Aesthetic:\*\* Modern, clean UI that matches professional IT tools



\### NFR-7: Compatibility

\- \*\*Browsers:\*\* Latest 2 versions of Chrome, Edge, Firefox (no IE support)

\- \*\*Screen Resolution:\*\* Optimized for 1920x1080 (minimum 1280x720)

\- \*\*Operating System:\*\* Windows 10/11, macOS (coordinator's workstation)



---



\## 9. Technical Architecture



\### System Architecture Diagram



```

┌─────────────────────────────────────────────────────────────────┐

│                         AZURE CLOUD                              │

│                                                                   │

│  ┌───────────────────────────────────────────────────────────┐ │

│  │                    Azure App Service                       │ │

│  │                                                             │ │

│  │  ┌─────────────────┐      ┌──────────────────┐           │ │

│  │  │  Static Files   │      │   Node.js API    │           │ │

│  │  │  (React Build)  │      │   (Express)      │           │ │

│  │  │                 │      │                  │           │ │

│  │  │  - index.html   │      │  - REST API      │           │ │

│  │  │  - bundle.js    │      │  - SSE endpoint  │           │ │

│  │  │  - styles.css   │      │  - Auth routes   │           │ │

│  │  └─────────────────┘      └────────┬─────────┘           │ │

│  │                                     │                      │ │

│  │                                     │                      │ │

│  │                            ┌────────▼─────────┐           │ │

│  │                            │  Background Job   │           │ │

│  │                            │  (node-cron)      │           │ │

│  │                            │  Polls every 30s  │           │ │

│  │                            └────────┬─────────┘           │ │

│  └─────────────────────────────────────┼──────────────────────┘ │

│                                         │                        │

│                                         ▼                        │

│                         ┌───────────────────────────┐           │

│                         │  Azure Database for       │           │

│                         │  PostgreSQL               │           │

│                         │                           │           │

│                         │  - technicians table      │           │

│                         │  - tickets table          │           │

│                         │  - ticket\_activities      │           │

│                         └───────────────────────────┘           │

│                                                                   │

│                         ┌───────────────────────────┐           │

│                         │  Azure Key Vault          │           │

│                         │  - FreshService API Key   │           │

│                         │  - Dashboard Password     │           │

│                         └───────────────────────────┘           │

│                                                                   │

│                         ┌───────────────────────────┐           │

│                         │  Application Insights     │           │

│                         │  - Logs, Metrics, Alerts  │           │

│                         └───────────────────────────┘           │

└─────────────────────────────────────────────────────────────────┘

&nbsp;                                 │

&nbsp;                                 │ HTTPS

&nbsp;                                 ▼

&nbsp;                      ┌──────────────────────┐

&nbsp;                      │  FreshService API    │

&nbsp;                      │  (Enterprise Plan)   │

&nbsp;                      │                      │

&nbsp;                      │  - GET /api/v2/      │

&nbsp;                      │    tickets           │

&nbsp;                      │  - GET /api/v2/      │

&nbsp;                      │    agents            │

&nbsp;                      └──────────────────────┘

```



\### Technology Stack



\*\*Frontend:\*\*

\- \*\*Framework:\*\* React 18.3+ (with Hooks, no class components)

\- \*\*Build Tool:\*\* Vite (fast dev server, optimized production builds)

\- \*\*UI Library:\*\* Tailwind CSS 3.4+ (utility-first styling)

\- \*\*Charts:\*\* Recharts 2.12+ (for Phase 2 visualizations)

\- \*\*HTTP Client:\*\* axios 1.7+

\- \*\*State Management:\*\* React Context API + useReducer (no Redux needed for MVP)

\- \*\*Icons:\*\* Lucide React (modern, lightweight icons)



\*\*Backend:\*\*

\- \*\*Runtime:\*\* Node.js 20 LTS

\- \*\*Framework:\*\* Express.js 4.19+

\- \*\*Database ORM:\*\* Prisma 5.19+ (type-safe, great DX)

\- \*\*Job Scheduler:\*\* node-cron 3.0+ (background polling)

\- \*\*HTTP Client:\*\* axios 1.7+ (FreshService API calls)

\- \*\*Authentication:\*\* express-session + connect-pg-simple (session store)

\- \*\*Password Hashing:\*\* bcrypt 5.1+

\- \*\*Logging:\*\* winston 3.14+ (structured logging)

\- \*\*Validation:\*\* Zod 3.23+ (runtime type checking)



\*\*Database:\*\*

\- \*\*RDBMS:\*\* PostgreSQL 16+ (Azure Database for PostgreSQL)

\- \*\*Connection Pooling:\*\* Built into Prisma

\- \*\*Migrations:\*\* Prisma Migrate



\*\*Infrastructure (Azure):\*\*

\- \*\*Compute:\*\* Azure App Service (Linux, Node 20)

\- \*\*Database:\*\* Azure Database for PostgreSQL (Flexible Server)

\- \*\*Secrets:\*\* Azure Key Vault

\- \*\*Monitoring:\*\* Application Insights

\- \*\*CDN:\*\* Azure CDN (optional, for static assets)

\- \*\*DNS:\*\* Azure DNS (custom domain if needed)



\*\*DevOps:\*\*

\- \*\*Version Control:\*\* Git (GitHub/Azure DevOps)

\- \*\*CI/CD:\*\* GitHub Actions or Azure Pipelines

\- \*\*Container:\*\* Docker (optional, for local dev)

\- \*\*IaC:\*\* Bicep or Terraform (infrastructure as code)



\*\*Development Tools:\*\*

\- \*\*Code Editor:\*\* VS Code (recommended)

\- \*\*Linting:\*\* ESLint 9+ (Airbnb style guide)

\- \*\*Formatting:\*\* Prettier 3.3+

\- \*\*API Testing:\*\* Postman or Thunder Client

\- \*\*Git Hooks:\*\* Husky (pre-commit linting)



---



\## 10. Data Model



\### Database Schema (PostgreSQL + Prisma)



```prisma

// schema.prisma



datasource db {

&nbsp; provider = "postgresql"

&nbsp; url      = env("DATABASE\_URL")

}



generator client {

&nbsp; provider = "prisma-client-js"

}



model Technician {

&nbsp; id              Int       @id @default(autoincrement())

&nbsp; freshserviceId  BigInt    @unique @map("freshservice\_id")

&nbsp; name            String    @db.VarChar(255)

&nbsp; email           String?   @db.VarChar(255)

&nbsp; timezone        String    @default("America/Los\_Angeles") @db.VarChar(50)

&nbsp; location        String?   @db.VarChar(100)

&nbsp; isActive        Boolean   @default(true) @map("is\_active")

&nbsp; createdAt       DateTime  @default(now()) @map("created\_at")

&nbsp; updatedAt       DateTime  @updatedAt @map("updated\_at")



&nbsp; tickets         Ticket\[]



&nbsp; @@map("technicians")

&nbsp; @@index(\[freshserviceId])

}



model Ticket {

&nbsp; id                    Int       @id @default(autoincrement())

&nbsp; freshserviceTicketId  BigInt    @unique @map("freshservice\_ticket\_id")

&nbsp; subject               String?   @db.Text

&nbsp; status                String    @db.VarChar(50) // open, pending, resolved, closed

&nbsp; priority              Int       @default(3) // 1=Urgent, 2=High, 3=Medium, 4=Low

&nbsp; 

&nbsp; // Relationships

&nbsp; assignedTechId        Int?      @map("assigned\_tech\_id")

&nbsp; assignedTech          Technician? @relation(fields: \[assignedTechId], references: \[id])

&nbsp; 

&nbsp; // Timestamps

&nbsp; createdAt             DateTime  @map("created\_at")

&nbsp; assignedAt            DateTime? @map("assigned\_at")

&nbsp; resolvedAt            DateTime? @map("resolved\_at")

&nbsp; updatedAt             DateTime  @updatedAt @map("updated\_at")

&nbsp; 

&nbsp; // Assignment tracking

&nbsp; isSelfPicked          Boolean   @default(false) @map("is\_self\_picked")

&nbsp; assignedBy            String?   @db.VarChar(255) @map("assigned\_by") // Name or ID

&nbsp; 

&nbsp; // Workspace filtering

&nbsp; workspaceName         String?   @db.VarChar(100) @map("workspace\_name")

&nbsp; 

&nbsp; // Computed fields (handled in application logic)

&nbsp; // isToday: computed based on createdAt and PST timezone

&nbsp; 

&nbsp; @@map("tickets")

&nbsp; @@index(\[assignedTechId])

&nbsp; @@index(\[createdAt])

&nbsp; @@index(\[status])

&nbsp; @@index(\[workspaceName])

}



model TicketActivity {

&nbsp; id            Int       @id @default(autoincrement())

&nbsp; ticketId      Int       @map("ticket\_id")

&nbsp; activityType  String    @db.VarChar(50) // assigned, status\_changed, resolved, picked

&nbsp; performedBy   String    @db.VarChar(255) @map("performed\_by")

&nbsp; performedAt   DateTime  @map("performed\_at")

&nbsp; details       Json?     // Store additional context as JSON

&nbsp; 

&nbsp; @@map("ticket\_activities")

&nbsp; @@index(\[ticketId])

&nbsp; @@index(\[performedAt])

}



model AppSettings {

&nbsp; id              Int       @id @default(autoincrement())

&nbsp; key             String    @unique @db.VarChar(100)

&nbsp; value           String    @db.Text

&nbsp; description     String?   @db.Text

&nbsp; updatedAt       DateTime  @updatedAt @map("updated\_at")

&nbsp; 

&nbsp; @@map("app\_settings")

}



model SyncLog {

&nbsp; id              Int       @id @default(autoincrement())

&nbsp; syncType        String    @db.VarChar(50) // tickets, technicians

&nbsp; status          String    @db.VarChar(20) // success, error, partial

&nbsp; recordsProcessed Int      @default(0) @map("records\_processed")

&nbsp; errorMessage    String?   @db.Text @map("error\_message")

&nbsp; startedAt       DateTime  @default(now()) @map("started\_at")

&nbsp; completedAt     DateTime? @map("completed\_at")

&nbsp; 

&nbsp; @@map("sync\_logs")

&nbsp; @@index(\[startedAt])

}

```



\### Key Database Design Decisions



1\. \*\*No CASCADE deletes:\*\* Preserve data integrity - if a tech is deleted, keep their historical tickets

2\. \*\*Timezone stored per tech:\*\* Support flexible timezone display in future

3\. \*\*Priority as INT:\*\* Easier to sort and filter than string enum

4\. \*\*JSON for activity details:\*\* Flexible schema for different activity types

5\. \*\*Sync logs:\*\* Track background job health and debug issues

6\. \*\*Indexes:\*\* Optimize queries for dashboard (assignedTechId, createdAt, status)



---



\## 11. API Specifications



\### REST API Endpoints



\*\*Base URL:\*\* `https://<app-name>.azurewebsites.net/api`



---



\#### Authentication Endpoints



\*\*POST /api/auth/login\*\*

```json

Request:

{

&nbsp; "password": "string"

}



Response (200 OK):

{

&nbsp; "success": true,

&nbsp; "message": "Login successful",

&nbsp; "session": {

&nbsp;   "expiresAt": "2025-10-18T05:00:00Z"

&nbsp; }

}



Response (401 Unauthorized):

{

&nbsp; "success": false,

&nbsp; "message": "Invalid password"

}

```



\*\*POST /api/auth/logout\*\*

```json

Response (200 OK):

{

&nbsp; "success": true,

&nbsp; "message": "Logged out successfully"

}

```



\*\*GET /api/auth/check\*\*

```json

Response (200 OK):

{

&nbsp; "authenticated": true,

&nbsp; "expiresAt": "2025-10-18T05:00:00Z"

}



Response (401 Unauthorized):

{

&nbsp; "authenticated": false

}

```



---



\#### Dashboard Data Endpoints



\*\*GET /api/dashboard\*\*

```json

Description: Get complete dashboard data (all techs + stats)

Auth: Required (session)



Response (200 OK):

{

&nbsp; "stats": {

&nbsp;   "totalTicketsToday": 47,

&nbsp;   "unassignedTickets": 3,

&nbsp;   "averagePerTech": 3.92,

&nbsp;   "lastUpdated": "2025-10-17T14:23:45Z",

&nbsp;   "timezone": "America/Los\_Angeles"

&nbsp; },

&nbsp; "technicians": \[

&nbsp;   {

&nbsp;     "id": 1,

&nbsp;     "name": "John Doe",

&nbsp;     "location": "Halifax",

&nbsp;     "timezone": "America/Halifax",

&nbsp;     "todayTotal": 3,

&nbsp;     "selfPicked": 2,

&nbsp;     "assigned": 1,

&nbsp;     "openCount": 2,

&nbsp;     "loadLevel": "light", // light, medium, heavy

&nbsp;     "tickets": \[] // Only IDs, fetch full list via /technicians/:id

&nbsp;   },

&nbsp;   // ... more technicians

&nbsp; ]

}

```



\*\*GET /api/technicians/:id\*\*

```json

Description: Get detailed ticket list for specific technician

Auth: Required (session)



Response (200 OK):

{

&nbsp; "technician": {

&nbsp;   "id": 1,

&nbsp;   "name": "John Doe",

&nbsp;   "location": "Halifax",

&nbsp;   "timezone": "America/Halifax",

&nbsp;   "todayTotal": 3,

&nbsp;   "selfPicked": 2,

&nbsp;   "assigned": 1,

&nbsp;   "openCount": 2

&nbsp; },

&nbsp; "tickets": {

&nbsp;   "open": \[

&nbsp;     {

&nbsp;       "id": 12345,

&nbsp;       "freshserviceTicketId": 12345,

&nbsp;       "subject": "VPN not working",

&nbsp;       "status": "open",

&nbsp;       "priority": 2,

&nbsp;       "createdAt": "2025-10-17T08:30:00Z",

&nbsp;       "assignedAt": "2025-10-17T08:32:15Z",

&nbsp;       "isSelfPicked": true,

&nbsp;       "assignedBy": null,

&nbsp;       "freshserviceUrl": "https://yourcompany.freshservice.com/helpdesk/tickets/12345"

&nbsp;     },

&nbsp;     // ... more open tickets

&nbsp;   ],

&nbsp;   "resolvedToday": \[

&nbsp;     {

&nbsp;       "id": 12289,

&nbsp;       "subject": "Printer jam",

&nbsp;       "resolvedAt": "2025-10-17T11:45:00Z",

&nbsp;       "resolutionTimeMinutes": 90

&nbsp;     },

&nbsp;     // ... more resolved tickets

&nbsp;   ]

&nbsp; }

}

```



\*\*GET /api/settings\*\*

```json

Description: Get application settings

Auth: Required (session)



Response (200 OK):

{

&nbsp; "refreshInterval": 30, // seconds

&nbsp; "showLocalTimezone": false,

&nbsp; "workspaceName": "IT"

}

```



\*\*PUT /api/settings\*\*

```json

Description: Update application settings

Auth: Required (session)



Request:

{

&nbsp; "refreshInterval": 60,

&nbsp; "showLocalTimezone": true

}



Response (200 OK):

{

&nbsp; "success": true,

&nbsp; "message": "Settings updated"

}

```



---



\#### Server-Sent Events (SSE)



\*\*GET /api/dashboard/stream\*\*

```

Description: Real-time dashboard updates via SSE

Auth: Required (session)

Content-Type: text/event-stream



Event Stream:

event: update

data: {"type": "dashboard", "data": {...fullDashboardData}}



event: ping

data: {"timestamp": "2025-10-17T14:23:45Z"}



event: error

data: {"message": "FreshService API temporarily unavailable"}

```



---



\#### Health \& Monitoring



\*\*GET /api/health\*\*

```json

Description: Health check endpoint (public, no auth)



Response (200 OK):

{

&nbsp; "status": "healthy",

&nbsp; "uptime": 86400,

&nbsp; "database": "connected",

&nbsp; "freshservice": "connected",

&nbsp; "lastSync": "2025-10-17T14:23:15Z"

}



Response (503 Service Unavailable):

{

&nbsp; "status": "unhealthy",

&nbsp; "errors": \[

&nbsp;   "Database connection failed",

&nbsp;   "FreshService API unreachable"

&nbsp; ]

}

```



---



\### FreshService API Integration



\*\*Endpoints Used:\*\*



1\. \*\*GET /api/v2/tickets\*\*

&nbsp;  - Fetch tickets created/updated in last 24 hours (PST)

&nbsp;  - Filter by workspace: `?workspace\_id=123`

&nbsp;  - Include: `include=requester,stats`



2\. \*\*GET /api/v2/agents\*\*

&nbsp;  - Fetch all agents in IT workspace

&nbsp;  - Filter active agents only



3\. \*\*GET /api/v2/ticket\_activities\*\*

&nbsp;  - Fetch assignment history for tickets

&nbsp;  - Determine self-picked vs assigned



\*\*Authentication:\*\*

```

Header: Authorization: Basic <base64(api\_key:X)>

```



\*\*Rate Limits:\*\*

\- FreshService Enterprise: 5000 requests/hour

\- Our polling: ~120 requests/hour (every 30s = 120/hour)

\- Well within limits



---



\## 12. Deployment Strategy



\### Azure Resources



\*\*Resource Group:\*\* `rg-freshservice-dashboard-prod`



\*\*App Service Plan:\*\*

\- \*\*Name:\*\* `asp-freshservice-dashboard`

\- \*\*Tier:\*\* B1 (Basic) or P1V2 (Production) - $55-75/month

\- \*\*OS:\*\* Linux

\- \*\*Runtime:\*\* Node 20 LTS



\*\*App Service:\*\*

\- \*\*Name:\*\* `app-freshservice-dashboard` (or custom domain)

\- \*\*Deployment:\*\* CI/CD from GitHub

\- \*\*Always On:\*\* Enabled

\- \*\*HTTPS Only:\*\* Enabled



\*\*Database:\*\*

\- \*\*Name:\*\* `psql-freshservice-dashboard`

\- \*\*Tier:\*\* Basic (1 vCore, 2GB RAM) - $50/month or General Purpose for production

\- \*\*Backup:\*\* 7-day retention

\- \*\*High Availability:\*\* Optional (for production)



\*\*Key Vault:\*\*

\- \*\*Name:\*\* `kv-freshservice-dashboard`

\- \*\*Secrets:\*\*

&nbsp; - `FreshServiceApiKey`

&nbsp; - `DashboardPassword`

&nbsp; - `SessionSecret`

&nbsp; - `DatabaseConnectionString`



\*\*Application Insights:\*\*

\- \*\*Name:\*\* `appi-freshservice-dashboard`

\- \*\*Sampling:\*\* 100% (capture all telemetry)



\*\*Estimated Monthly Cost:\*\* ~$100-150 USD



---



\### Environment Variables



```bash

\# Database

DATABASE\_URL=postgresql://user:pass@host:5432/dbname



\# FreshService

FRESHSERVICE\_API\_KEY=<from Key Vault>

FRESHSERVICE\_DOMAIN=yourcompany.freshservice.com

FRESHSERVICE\_WORKSPACE\_ID=123



\# App Config

NODE\_ENV=production

PORT=8080

SESSION\_SECRET=<from Key Vault>

DASHBOARD\_PASSWORD\_HASH=<bcrypt hash from Key Vault>



\# Sync Settings

SYNC\_INTERVAL\_SECONDS=30

TIMEZONE\_DEFAULT=America/Los\_Angeles



\# Monitoring

APPLICATIONINSIGHTS\_CONNECTION\_STRING=<from Key Vault>

```



---



\### CI/CD Pipeline (GitHub Actions)



```yaml

\# .github/workflows/deploy.yml

name: Deploy to Azure



on:

&nbsp; push:

&nbsp;   branches: \[main]



jobs:

&nbsp; build-and-deploy:

&nbsp;   runs-on: ubuntu-latest

&nbsp;   

&nbsp;   steps:

&nbsp;     - uses: actions/checkout@v3

&nbsp;     

&nbsp;     - name: Setup Node.js

&nbsp;       uses: actions/setup-node@v3

&nbsp;       with:

&nbsp;         node-version: '20'

&nbsp;     

&nbsp;     - name: Install dependencies

&nbsp;       run: |

&nbsp;         npm install

&nbsp;         cd frontend \&\& npm install

&nbsp;     

&nbsp;     - name: Build frontend

&nbsp;       run: cd frontend \&\& npm run build

&nbsp;     

&nbsp;     - name: Run Prisma migrations

&nbsp;       run: npx prisma migrate deploy

&nbsp;       env:

&nbsp;         DATABASE\_URL: ${{ secrets.DATABASE\_URL }}

&nbsp;     

&nbsp;     - name: Run tests

&nbsp;       run: npm test

&nbsp;     

&nbsp;     - name: Deploy to Azure

&nbsp;       uses: azure/webapps-deploy@v2

&nbsp;       with:

&nbsp;         app-name: 'app-freshservice-dashboard'

&nbsp;         publish-profile: ${{ secrets.AZURE\_WEBAPP\_PUBLISH\_PROFILE }}

```



---



\## 13. Testing Strategy



\### Unit Tests

\- \*\*Backend:\*\* Jest for API logic, database queries (mocked)

\- \*\*Frontend:\*\* React Testing Library for components

\- \*\*Coverage Target:\*\* 70%+ for critical paths



\### Integration Tests

\- \*\*API Endpoints:\*\* Supertest for Express routes

\- \*\*Database:\*\* Test against PostgreSQL (Docker container)

\- \*\*FreshService Mock:\*\* Mock API responses



\### End-to-End Tests

\- \*\*Playwright:\*\* Simulate coordinator workflow

\- \*\*Critical Paths:\*\*

&nbsp; - Login → View dashboard → Click tech → See tickets

&nbsp; - Auto-refresh works correctly

&nbsp; - Settings changes persist



\### Manual Testing Checklist

\- \[ ] FreshService sync accuracy (compare 10 random tickets)

\- \[ ] Timezone conversions correct (verify against FreshService)

\- \[ ] Self-picked detection accuracy (manual spot-check)

\- \[ ] Dashboard performance under load (50+ tickets, 12 techs)

\- \[ ] Error handling (disconnect database, FreshService API down)



---



\## 14. Rollout Plan



\### Phase 0: Infrastructure Setup (Week 1)

\- \[ ] Provision Azure resources (App Service, PostgreSQL, Key Vault)

\- \[ ] Set up CI/CD pipeline

\- \[ ] Configure FreshService API access

\- \[ ] Create development/staging environments



\### Phase 1: MVP Development (Week 2-3)

\- \[ ] Backend: FreshService sync service

\- \[ ] Backend: REST API + SSE

\- \[ ] Frontend: Dashboard UI

\- \[ ] Frontend: Tech detail view

\- \[ ] Authentication

\- \[ ] Deploy to staging



\### Phase 2: Testing \& Refinement (Week 4)

\- \[ ] Unit + integration tests

\- \[ ] Manual testing with IT Coordinator

\- \[ ] Fix bugs, polish UI

\- \[ ] Performance optimization

\- \[ ] Deploy to production



\### Phase 3: Launch (Week 5)

\- \[ ] Soft launch: Coordinator uses alongside FreshService for 1 week

\- \[ ] Gather feedback, iterate

\- \[ ] Full adoption: Coordinator relies on dashboard for assignments

\- \[ ] Monitor usage, error rates, performance



\### Phase 4: Iterate \& Expand (Ongoing)

\- \[ ] Add Phase 2 features (resolution time, trends, filters)

\- \[ ] Optimize based on real usage patterns

\- \[ ] Consider expanding access (all techs view dashboard)



---



\## 15. Success Criteria \& KPIs



\### Launch Criteria (Must achieve before full rollout)

\- \[ ] Dashboard loads in < 2 seconds

\- \[ ] Data syncs within 30 seconds of FreshService changes

\- \[ ] Zero critical bugs in 1 week of staging testing

\- \[ ] Coordinator can complete 5 assignments using dashboard successfully

\- \[ ] Self-picked detection is 95%+ accurate (spot-check 20 tickets)



\### Post-Launch KPIs (Measure after 30 days)



\*\*Primary Metrics:\*\*

\- \*\*Time to Assign:\*\* Average time from ticket creation to assignment < 2 minutes \*(Target: 70% reduction)\*

\- \*\*Load Balance:\*\* Standard deviation of tickets per tech per day < 2.0 \*(Target: 40% improvement)\*

\- \*\*Coordinator NPS:\*\* Net Promoter Score > 8/10 \*(Qualitative survey)\*



\*\*Secondary Metrics:\*\*

\- \*\*Dashboard Uptime:\*\* > 99.5% during business hours

\- \*\*Data Accuracy:\*\* < 1% discrepancy between dashboard and FreshService

\- \*\*Adoption Rate:\*\* Coordinator uses dashboard for > 90% of manual assignments

\- \*\*Time Saved:\*\* Coordinator reports 30+ minutes saved per day \*(Qualitative survey)\*



\*\*Technical Metrics:\*\*

\- \*\*API Response Time:\*\* p95 < 200ms

\- \*\*Error Rate:\*\* < 0.1% of requests fail

\- \*\*Database Query Time:\*\* p95 < 500ms

\- \*\*FreshService API Success Rate:\*\* > 99%



\### Failure Criteria (When to pivot or roll back)

\- Dashboard frequently shows stale data (> 2 minutes old)

\- Coordinator reverts to FreshService reports (adoption < 50%)

\- Critical bugs causing incorrect assignment decisions

\- Performance degradation (load time > 5 seconds)



---



\## 16. Risks \& Mitigation



| Risk | Likelihood | Impact | Mitigation |

|------|------------|--------|------------|

| FreshService API changes breaking integration | Medium | High | Version API calls, monitor FreshService release notes, automated tests |

| Self-picked detection inaccurate | Medium | Medium | Validate with manual spot-checks, iterate algorithm, allow manual override |

| Azure service outage | Low | High | Implement graceful degradation, display stale data, status page |

| Database performance issues at scale | Low | Medium | Optimize queries, add indexes, upgrade tier if needed |

| Coordinator doesn't adopt dashboard | Low | High | Involve coordinator in design, provide training, gather continuous feedback |

| Timezone bugs causing wrong "today" calculation | Medium | High | Extensive testing, use battle-tested libraries (date-fns-tz), monitor edge cases |



---



\## 17. Future Roadmap (Post-MVP)



\### Phase 2: Analytics \& Insights (Q1 2026)

\- Average resolution time per technician

\- Ticket age heatmap (how long tickets sit open)

\- Priority breakdown (P1, P2, P3, P4 distribution)

\- Week-over-week trends

\- Technician performance leaderboard (gamification)



\### Phase 3: Advanced Features (Q2 2026)

\- Predictive analytics (who's likely to finish soon?)

\- Smart assignment recommendations (ML-based)

\- Slack/Teams notifications for coordinators

\- Multi-user access (all techs can view dashboard)

\- Role-based permissions (view-only vs assign permissions)



\### Phase 4: Expansion (Q3 2026)

\- Support multiple workspaces (not just IT)

\- Mobile app (iOS/Android) for on-the-go coordinators

\- SLA tracking and alerts

\- Custom reporting (export to Excel/PDF)

\- Integration with other tools (Jira, ServiceNow)



---



\## 18. Open Questions \& Assumptions



\### Open Questions

1\. \*\*Ticket Types:\*\* Should we filter by specific ticket types (incident vs request vs change)?

2\. \*\*Holidays/PTO:\*\* How to handle technicians on vacation? Mark as inactive?

3\. \*\*After-hours:\*\* What happens to tickets created outside business hours?

4\. \*\*Custom Fields:\*\* Does FreshService use custom fields that affect assignment decisions?

5\. \*\*Escalations:\*\* Should dashboard show escalated tickets differently?



\### Assumptions

1\. FreshService API will remain stable (no breaking changes)

2\. IT workspace ID is static and won't change

3\. Technicians will not be renamed/deleted frequently

4\. Coordinator has authority to change settings (refresh rate, etc.)

5\. Network connectivity is reliable (minimal offline scenarios)

6\. Team size remains ~12 techs for foreseeable future



---



\## 19. Appendix



\### Glossary

\- \*\*Tech/Technician:\*\* IT support staff who resolve tickets

\- \*\*Coordinator:\*\* Person responsible for manually assigning tickets

\- \*\*Self-picked:\*\* Tech assigned ticket to themselves from queue

\- \*\*Assigned:\*\* Coordinator manually assigned ticket to tech

\- \*\*Open Tickets:\*\* Tickets with status = open or in-progress

\- \*\*Today:\*\* Midnight PST to 11:59 PM PST

\- \*\*Load Level:\*\* Color-coded indicator (green/yellow/red) of tech's workload



\### References

\- \[FreshService API Documentation](https://api.freshservice.com/v2/)

\- \[Azure App Service Docs](https://docs.microsoft.com/azure/app-service/)

\- \[Prisma Documentation](https://www.prisma.io/docs)

\- \[React Best Practices](https://react.dev/learn)



\### Contact

\- \*\*Product Owner:\*\* IT Manager (you)

\- \*\*Tech Lead:\*\* (TBD)

\- \*\*Stakeholders:\*\* IT Coordinator, IT Team (12 techs)



---



\## 20. Document History



| Version | Date | Author | Changes |

|---------|------|--------|---------|

| 1.0 | Oct 17, 2025 | IT Manager | Initial PRD - MVP scope defined |



---



\*\*END OF PRD\*\*



---



\## Sign-off



\*\*Approved by:\*\*

\- \[ ] IT Manager (Product Owner)

\- \[ ] IT Coordinator (Primary User)

\- \[ ] Technical Lead (to be assigned)



\*\*Next Steps:\*\*

1\. Review and approve PRD

2\. Set up project repository

3\. Begin Phase 0 (Infrastructure setup)

4\. Kick off Phase 1 development



\*\*Timeline:\*\* Estimated 5 weeks to launch (Weeks 1-5)

\*\*Budget:\*\* ~$100-150/month Azure costs + development time

