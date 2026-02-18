# Ticket Pulse

FreshService Real-Time IT Dashboard - A real-time workload management system for IT helpdesk ticket distribution with advanced search, filtering, and analytics capabilities.

## ✨ Features

### Core Dashboard
- **Real-time Updates** - Server-Sent Events (SSE) for live ticket updates
- **Daily/Weekly Views** - Toggle between daily workload and weekly trends
- **Self-Picked Detection** - Smart algorithm identifies tickets picked vs assigned
- **Load Level Indicators** - Visual workload indicators (🟢 Light / 🟡 Medium / 🔴 Heavy)
- **Compact View Mode** - Space-efficient display for more technicians
- **Date Navigation** - Calendar picker with quick navigation controls

### Search & Filter System
- **🔍 Smart Search** - Search tickets by subject, ID, or requester name
- **🏷️ Category Filter** - Multi-select filtering by ticket categories
- **📊 Dynamic Stats** - All metrics recalculate instantly when filtering
- **💾 Session Persistence** - Filters persist during navigation
- **📅 Weekly Grid Updates** - Mon-Sun breakdown adjusts with filters

### Technical Highlights
- **Frontend**: React 18.3 + Vite + Tailwind CSS
- **Backend**: Node.js + Express + Prisma ORM
- **Database**: PostgreSQL with optimized indexes
- **Auth**: Session-based with secure cookies
- **API Integration**: FreshService Enterprise API with rate limiting

## Quick Start

### Prerequisites
- Node.js 20 LTS
- Docker Desktop (for PostgreSQL)
- FreshService Enterprise API access

### Local Development

1. **Clone and install dependencies:**
```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

2. **Start PostgreSQL with Docker:**
```bash
docker-compose up -d
```

3. **Configure environment variables:**
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Edit backend/.env with your FreshService API credentials
```

4. **Run database migrations:**
```bash
cd backend
npx prisma migrate dev
```

5. **Start development servers:**
```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:3000

## Project Structure

```
ticket-pulse/
├── backend/           # Node.js + Express API
│   ├── src/
│   │   ├── config/    # Configuration management
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/  # Business logic & repositories
│   │   └── utils/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   └── tests/
├── frontend/          # React + Vite SPA
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── context/   # Global state
│   │   └── utils/
│   └── public/
└── docs/              # Documentation
```

## Development Commands

### Backend
```bash
npm run dev --prefix backend          # Start dev server with nodemon
npm test --prefix backend             # Run tests
npm run lint --prefix backend         # Lint code
npm run format --prefix backend       # Format code
npx prisma studio --prefix backend    # Open database GUI
```

### Frontend
```bash
npm run dev --prefix frontend         # Start Vite dev server
npm run build --prefix frontend       # Production build
npm test --prefix frontend            # Run tests
npm run lint --prefix frontend        # Lint code
```

## Tech Stack

**Backend:**
- Node.js 20 LTS + Express.js
- Prisma ORM + PostgreSQL 16
- express-session + bcrypt (auth)
- node-cron (background jobs)
- Winston (logging)

**Frontend:**
- React 18.3 + Vite
- Tailwind CSS 3.4
- Axios + Server-Sent Events
- Context API (state management)

**Infrastructure:**
- Docker (local PostgreSQL)
- Azure App Service (production)
- Azure Database for PostgreSQL
- Application Insights (monitoring)

## Key Features

### Dashboard Views
- **Daily View**: Real-time snapshot of current workload
- **Weekly View**: Aggregated statistics with daily breakdown
  - Week-by-week navigation (Monday-Sunday)
  - Color-coded daily mini-calendars showing ticket distribution
  - Normalized color gradients (green = high activity)
  - Weekly totals for self-picked, assigned, and closed tickets
- **Compact & Grid layouts**: Toggle between list and card views

### Technician Tracking
- Self-picked vs coordinator-assigned ticket differentiation
- Click-through to individual technician detail pages
- Assigners tracking with popup details
- Color-coded workload indicators (light/medium/heavy)
- Top performer badges and rankings

### Real-Time Updates
- Auto-refresh every 30 seconds (configurable)
- Server-Sent Events (SSE) for live updates
- Background synchronization with FreshService API

### Additional Features
- Timezone support (PST default, configurable)
- Password-protected access with session management
- Centralized statistics calculation for data consistency
- Browser back/forward navigation state preservation
- Hidden technicians management

## Weekly View Details

The weekly view provides comprehensive insights into ticket distribution across a 7-day period:

- **Centralized Calculation**: All statistics use a single `statsCalculator.js` service for consistency
- **Proper Date Tracking**: Uses `firstAssignedAt` (not `createdAt`) for accurate assignment dates
- **Closed Tickets**: Calculated based on `closedAt`/`resolvedAt` for when tickets were actually closed
- **Daily Breakdown**: Each technician shows a mini-calendar with:
  - Individual day boxes (Mon-Sun)
  - Color-coded based on ticket volume (white = 0, light/medium/dark green = low/medium/high)
  - Normalized across all technicians for relative comparison
  - Hover tooltips showing detailed breakdown (self/assigned/closed)
- **Week Navigation**: Navigate between weeks with persistent state
- **View Persistence**: Browser back/forward maintains weekly view state

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Complete architecture guide
- [CHANGELOG.md](./CHANGELOG.md) - Recent improvements and bug fixes
- [docs/product.md](./docs/product.md) - Product requirements (PRD)
- [docs/todo.md](./docs/todo.md) - Development task list

## Docker Commands

```bash
# Start PostgreSQL
docker-compose up -d

# Stop PostgreSQL
docker-compose down

# View logs
docker-compose logs -f

# Reset database (WARNING: deletes all data)
docker-compose down -v
```

## License

Proprietary - Internal use only
