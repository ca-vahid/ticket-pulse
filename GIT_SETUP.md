# Git Setup Guide

## Initial Repository Setup

### 1. Initialize Git Repository

```bash
git init
```

### 2. Add Remote (replace with your repository URL)

```bash
git remote add origin https://github.com/YOUR_USERNAME/ticket-pulse.git
```

### 3. Check Status

```bash
git status
```

### 4. Add All Files

```bash
git add .
```

### 5. Create Initial Commit

Use the comprehensive commit message from COMMIT_MESSAGE.md:

```bash
git commit -F COMMIT_MESSAGE.md
```

Or use a shorter version:

```bash
git commit -m "feat: Initial commit - Ticket Pulse Dashboard with Weekly View

Comprehensive IT helpdesk dashboard for FreshService ticket management with:
- Daily/Weekly view toggle with navigation
- Centralized statistics calculator
- Color-coded daily breakdown calendars
- Accurate date tracking (firstAssignedAt, closedAt)
- State-preserving navigation
- Real-time updates via SSE

🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

### 6. Create Main Branch (if needed)

```bash
git branch -M main
```

### 7. Push to Remote

```bash
git push -u origin main
```

## Verify Everything

```bash
# Check what will be committed
git status

# See the diff
git diff --cached

# Check remote
git remote -v

# View commit history
git log --oneline
```

## Common Git Commands

```bash
# Stage specific files
git add path/to/file

# Unstage files
git reset HEAD path/to/file

# View changes
git diff

# Amend last commit (if needed before push)
git commit --amend

# Pull latest changes
git pull origin main

# Create a new branch
git checkout -b feature/branch-name

# Switch branches
git checkout branch-name
```

## .gitignore Verification

The following should NOT be committed (already in .gitignore):
- `node_modules/` directories
- `.env` files (contains API keys!)
- `dist/` and `build/` directories
- Log files
- Test scripts (test-*.js, check-*.js, etc.)
- IDE files (.vscode, .idea)

## Before Pushing

**IMPORTANT CHECKS:**
1. ✅ No `.env` files committed (contains FreshService API keys)
2. ✅ No `node_modules/` directories
3. ✅ No sensitive credentials or API keys in code
4. ✅ All test scripts excluded
5. ✅ README.md is up to date

## Recommended First Commit Structure

```
Initial commit - Ticket Pulse Dashboard

✅ Backend (Node.js + Express + Prisma)
✅ Frontend (React + Vite + Tailwind)
✅ Weekly view implementation
✅ Centralized statistics
✅ Real-time updates (SSE)
✅ Documentation
```

## Next Steps After Initial Commit

1. Create a `.env.example` file (without real credentials)
2. Add CI/CD pipeline (GitHub Actions)
3. Set up branch protection rules
4. Create issue templates
5. Add contributing guidelines

## Troubleshooting

**Problem: Remote already exists**
```bash
git remote remove origin
git remote add origin YOUR_NEW_URL
```

**Problem: Already initialized**
```bash
rm -rf .git
git init
```

**Problem: Committed sensitive files**
```bash
# Remove from Git but keep locally
git rm --cached path/to/sensitive/file
echo "path/to/sensitive/file" >> .gitignore
git commit -m "Remove sensitive file from Git"
```

---

Once you've completed the initial push, delete this file:
```bash
rm GIT_SETUP.md COMMIT_MESSAGE.md
git add .
git commit -m "docs: Clean up setup files"
git push
```
