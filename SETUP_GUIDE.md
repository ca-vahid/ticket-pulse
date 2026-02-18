# 🚀 Ticket Pulse - Setup Guide

This guide will help you get the Ticket Pulse dashboard running on your local machine.

## Prerequisites

- ✅ **Node.js 20 LTS** - [Download](https://nodejs.org/)
- ✅ **Docker Desktop** - [Download](https://www.docker.com/products/docker-desktop/)
- ✅ **FreshService API Access** - Enterprise account with API permissions

---

## Step 1️⃣: Install Dependencies

Open PowerShell in the project root and run:

```powershell
# Install backend dependencies
npm install --prefix backend

# Install frontend dependencies
npm install --prefix frontend
```

**Expected output**: `added XXX packages` for each

---

## Step 2️⃣: Start PostgreSQL Database

```powershell
# Start Docker container with PostgreSQL
docker-compose up -d

# Verify it's running
docker ps
```

**Expected output**: Container `ticketpulse-postgres` running on port 5432

**Troubleshooting**:
- If port 5432 is in use: `docker-compose down` then change port in `docker-compose.yml`
- Check logs: `docker-compose logs -f`

---

## Step 3️⃣: Configure Environment Variables

I've created `.env` files for both backend and frontend. Now you need to add your FreshService credentials:

### Backend Configuration (`backend/.env`)

Edit `backend/.env` and update these values:

```env
# FreshService API Configuration
FRESHSERVICE_DOMAIN=efusion.freshservice.com  # Your FreshService domain
FRESHSERVICE_API_KEY=your-actual-api-key      # Get from FreshService admin panel
FRESHSERVICE_WORKSPACE_ID=your-workspace-id   # Optional, if using workspaces
```

**Where to find these**:
1. Login to FreshService
2. Go to **Admin** → **API Settings**
3. Generate or copy your API key
4. Domain is the part before `.freshservice.com` in your URL

### Frontend Configuration (`frontend/.env`)

Already configured! No changes needed for local development.

---

## Step 4️⃣: Setup Database Schema

Run Prisma migrations to create all tables:

```powershell
cd backend
npx prisma migrate dev
```

**Expected output**: 
```
✔ Database migrations complete
✔ Generated Prisma Client
```

**Troubleshooting**:
- If connection fails: Check Docker container is running
- If schema errors: Delete the database and restart: `docker-compose down -v && docker-compose up -d`

---

## Step 5️⃣: Generate Admin Password Hash

You need a password to access the dashboard. Let's generate a hash:

### Option A: Using the built-in script

```powershell
# From backend directory
node scripts/generatePasswordHash.js
```

Follow the prompts and copy the hash to `ADMIN_PASSWORD_HASH` in `backend/.env`

### Option B: Temporarily skip authentication

For initial setup, you can comment out auth middleware in `backend/src/routes/index.js` (not recommended for production)

---

## Step 6️⃣: Start Development Servers

Open **two separate PowerShell windows**:

### Terminal 1 - Backend
```powershell
cd backend
npm run dev
```

**Expected output**:
```
🚀 Server running on http://localhost:3000
✅ Database connected
🔄 Scheduled sync jobs started
```

### Terminal 2 - Frontend
```powershell
cd frontend
npm run dev
```

**Expected output**:
```
  VITE v5.x.x  ready in XXX ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

---

## Step 7️⃣: Access the Dashboard

1. Open browser to **http://localhost:5173**
2. Login with your admin password (from Step 5)
3. Click "Sync Now" to fetch initial data from FreshService
4. Wait ~2-5 minutes for initial sync to complete

---

## 🎯 Quick Reference

### Common Commands

```powershell
# Backend
npm run dev --prefix backend          # Start dev server
npm run prisma:studio --prefix backend # Open database GUI
npm run lint --prefix backend          # Check code quality

# Frontend  
npm run dev --prefix frontend          # Start dev server
npm run build --prefix frontend        # Production build

# Database
docker-compose up -d                   # Start PostgreSQL
docker-compose down                    # Stop PostgreSQL
docker-compose logs -f                 # View database logs
docker-compose down -v                 # Reset database (deletes all data)
```

### Accessing Services

| Service | URL | Credentials |
|---------|-----|-------------|
| **Frontend** | http://localhost:5173 | Admin password from Step 5 |
| **Backend API** | http://localhost:3000 | - |
| **Prisma Studio** | http://localhost:5555 | Auto-opens from `prisma:studio` |
| **Database** | localhost:5432 | dev / devpassword |

---

## 🔧 Troubleshooting

### Backend won't start

**Error**: `DATABASE_URL is required`
- **Solution**: Check `backend/.env` exists with valid `DATABASE_URL`

**Error**: `FRESHSERVICE_API_KEY is required`  
- **Solution**: Add your API key to `backend/.env` (or mark as optional in config)

**Error**: Port 3000 already in use
- **Solution**: Change `PORT=3001` in `backend/.env`

### Frontend - Rollup Module Error

**Error**: `Cannot find module @rollup/rollup-win32-x64-msvc`
- **Solution**: This is a known npm bug with optional dependencies on Windows
```powershell
cd frontend
Remove-Item -Recurse -Force node_modules, package-lock.json
npm install
npm install @rollup/rollup-win32-x64-msvc --save-optional
npm run dev
```

### Frontend won't connect

**Error**: Network error or timeout
- **Solution**: Verify backend is running on port 3000
- Check `VITE_API_URL` in `frontend/.env` matches backend port

### Database connection fails

**Error**: `getaddrinfo ENOTFOUND localhost`
- **Solution**: Verify Docker container is running: `docker ps`
- Restart container: `docker-compose restart`

### Sync fails with 401 Unauthorized

**Error**: FreshService API returns 401
- **Solution**: Verify API key is correct in `backend/.env`
- Check API key has proper permissions in FreshService

### Sync fails with 429 Rate Limit

**Error**: Too many requests
- **Solution**: This is normal for large syncs - the app has retry logic
- Wait a few minutes and retry

---

## 📚 Next Steps

Once setup is complete:

1. **Read the docs**: Check `SYNC_OPERATIONS.md` for sync details
2. **Explore features**: Try daily/weekly views, filtering, search
3. **Configure settings**: Set timezone, hidden technicians, etc.
4. **Schedule syncs**: Background jobs run every 30 seconds

---

## 🆘 Need Help?

- Check `CLAUDE.md` for architecture details
- Review `CHANGELOG.md` for recent changes
- Check backend logs for detailed error messages
- Frontend console (F12) for client-side errors

---

**Setup complete!** 🎉 You're ready to track tickets in real-time.

