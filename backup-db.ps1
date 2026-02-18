# ========================================
# Ticket Pulse - Database Backup Script
# ========================================
# This script backs up:
# 1. PostgreSQL database (SQL dump OR Docker volume)
# 2. Prisma schema and migrations
#
# Two backup modes:
# - 'sql' (default): Traditional SQL dump - portable, human-readable
# - 'volume': Docker volume backup - faster, exact copy

param(
    [string]$Action = "backup",
    [string]$Mode = "volume"  # 'sql' or 'volume'
)

$BackupDir = ".\db-backups"
$ContainerName = "ticketpulse-postgres"
$VolumeName = "ticket-pulse_postgres_data"  # Correct volume name
$DBName = "freshservice_dashboard"
$DBUser = "dev"
$PrismaDir = ".\backend\prisma"

# Create backup directory if it doesn't exist
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

function Backup-Database {
    $Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $BackupFolder = "$BackupDir\backup_$Timestamp"
    
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  COMPLETE BACKUP STARTING" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Mode: $Mode" -ForegroundColor White
    Write-Host "Database: $DBName" -ForegroundColor White
    Write-Host "Container: $ContainerName" -ForegroundColor White
    Write-Host "Backup folder: $BackupFolder" -ForegroundColor White
    Write-Host ""
    
    # Create backup folder
    New-Item -ItemType Directory -Force -Path $BackupFolder | Out-Null
    
    # Check if container is running
    $containerRunning = docker ps --filter "name=$ContainerName" --format "{{.Names}}" 2>$null
    if (-not $containerRunning) {
        Write-Host "✗ Error: Container '$ContainerName' is not running!" -ForegroundColor Red
        Write-Host "  Start it with: docker compose up -d" -ForegroundColor Yellow
        exit 1
    }
    
    # STEP 1: Backup Prisma files
    Write-Host "📁 Backing up Prisma schema and migrations..." -ForegroundColor Yellow
    $prismaBackupDir = "$BackupFolder\prisma"
    
    if (Test-Path $PrismaDir) {
        # Copy Prisma files, excluding Windows reserved device names
        New-Item -ItemType Directory -Force -Path $prismaBackupDir | Out-Null
        
        # Get absolute paths to avoid confusion
        $sourcePath = (Resolve-Path $PrismaDir).Path
        $destPath = (Resolve-Path $prismaBackupDir).Path
        
        # Reserved Windows device names to exclude
        $reservedNames = @('con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9')
        
        Get-ChildItem -Path $sourcePath -Recurse -Force | Where-Object {
            $name = $_.Name.ToLower() -replace '\.[^.]*$', ''  # Remove extension for check
            $reservedNames -notcontains $name -and $reservedNames -notcontains $_.Name.ToLower()
        } | ForEach-Object {
            $relativePath = $_.FullName.Substring($sourcePath.Length).TrimStart('\', '/')
            $targetPath = Join-Path $destPath $relativePath
            $targetDir = Split-Path $targetPath -Parent
            
            if (-not (Test-Path $targetDir)) {
                New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
            }
            
            if (-not $_.PSIsContainer) {
                Copy-Item -Path $_.FullName -Destination $targetPath -Force
            }
        }
        
        Write-Host "✓ Prisma files backed up" -ForegroundColor Green
    } else {
        Write-Host "⚠ Warning: Prisma directory not found at $PrismaDir" -ForegroundColor Yellow
    }
    
    # STEP 2: Backup database - BOTH volume and SQL dump
    Write-Host "`n🐳 Backing up Docker volume..." -ForegroundColor Yellow
    
    # Stop the container to ensure consistent backup
    Write-Host "  Stopping container for consistent backup..." -ForegroundColor Gray
    docker stop $ContainerName | Out-Null
    
    # Create a temporary container to backup the volume
    docker run --rm -v ${VolumeName}:/data -v ${PWD}/${BackupFolder}:/backup alpine tar czf /backup/postgres_volume.tar.gz -C /data .
    
    # Restart the container
    Write-Host "  Restarting container..." -ForegroundColor Gray
    docker start $ContainerName | Out-Null
    Start-Sleep -Seconds 3
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Docker volume backed up" -ForegroundColor Green
    } else {
        Write-Host "✗ Volume backup failed!" -ForegroundColor Red
        docker start $ContainerName | Out-Null
        exit 1
    }
    
    # STEP 3: Also create SQL dump
    Write-Host "`n📄 Creating SQL dump..." -ForegroundColor Yellow
    $sqlBackupFile = "$BackupFolder\database.sql"
    docker exec $ContainerName pg_dump -U $DBUser --clean --if-exists --create $DBName > $sqlBackupFile
    
    if ($LASTEXITCODE -eq 0 -and (Test-Path $sqlBackupFile)) {
        $sqlSize = (Get-Item $sqlBackupFile).Length / 1MB
        Write-Host "✓ SQL dump created ($([math]::Round($sqlSize, 2)) MB)" -ForegroundColor Green
    } else {
        Write-Host "✗ SQL dump failed!" -ForegroundColor Red
        exit 1
    }
    
    # Calculate total folder size
    $totalSize = (Get-ChildItem -Path $BackupFolder -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
    
    # Show results
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  ✓ BACKUP COMPLETE!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Backup folder: $BackupFolder" -ForegroundColor White
    Write-Host "Total size: $([math]::Round($totalSize, 2)) MB" -ForegroundColor White
    Write-Host "`nContains:" -ForegroundColor Cyan
    Write-Host "  ✓ Docker volume (postgres_volume.tar.gz)" -ForegroundColor White
    Write-Host "  ✓ SQL dump (database.sql)" -ForegroundColor White
    Write-Host "  ✓ Prisma schema" -ForegroundColor White
    Write-Host "  ✓ Prisma migrations" -ForegroundColor White
    
    # List recent backups
    Write-Host "`nRecent backups:" -ForegroundColor Cyan
    Get-ChildItem -Path $BackupDir -Directory -Filter "backup_*" | 
        Sort-Object LastWriteTime -Descending | 
        Select-Object -First 5 | 
        ForEach-Object {
            $size = (Get-ChildItem -Path $_.FullName -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
            Write-Host "  $($_.Name) - $([math]::Round($size, 2)) MB - $($_.LastWriteTime)" -ForegroundColor Gray
        }
    
    Write-Host "`nTo restore this backup, run:" -ForegroundColor Yellow
    Write-Host "  .\backup-db.ps1 -Action restore" -ForegroundColor White
}

function Restore-Database {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  DATABASE RESTORE" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan
    
    # List available backups (now folders instead of zips)
    $backups = Get-ChildItem -Path $BackupDir -Directory -Filter "backup_*" | Sort-Object LastWriteTime -Descending
    
    if ($backups.Count -eq 0) {
        Write-Host "✗ No backup files found in $BackupDir" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "Available backups:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $backups.Count; $i++) {
        $size = (Get-ChildItem -Path $backups[$i].FullName -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
        Write-Host "  [$i] $($backups[$i].Name) - $([math]::Round($size, 2)) MB - $($backups[$i].LastWriteTime)" -ForegroundColor White
    }
    
    Write-Host ""
    $selection = Read-Host "Select backup number to restore (or 'q' to quit)"
    
    if ($selection -eq 'q') {
        Write-Host "Restore cancelled." -ForegroundColor Yellow
        exit 0
    }
    
    if ([int]$selection -ge 0 -and [int]$selection -lt $backups.Count) {
        $backupFolder = $backups[[int]$selection]
        
        Write-Host "`n⚠️  WARNING: This will REPLACE all current data!" -ForegroundColor Red
        Write-Host "Backup: $($backupFolder.Name)" -ForegroundColor Yellow
        Write-Host "This will restore:" -ForegroundColor Yellow
        Write-Host "  - Database (from SQL dump)" -ForegroundColor White
        Write-Host "  - Prisma schema" -ForegroundColor White
        Write-Host "  - Prisma migrations" -ForegroundColor White
        Write-Host ""
        $confirm = Read-Host "Type 'YES' to confirm restore"
        
        if ($confirm -ne 'YES') {
            Write-Host "Restore cancelled." -ForegroundColor Yellow
            exit 0
        }
        
        # STEP 1: Restore Prisma files
        $prismaBackupPath = Join-Path $backupFolder.FullName "prisma"
        if (Test-Path $prismaBackupPath) {
            Write-Host "`n📁 Restoring Prisma files..." -ForegroundColor Yellow
            
            if (Test-Path $PrismaDir) {
                # Backup current Prisma files just in case
                $prismaBackupTemp = "$BackupDir\prisma_backup_temp_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
                Copy-Item -Path $PrismaDir -Destination $prismaBackupTemp -Recurse -Force
                Write-Host "  (Current Prisma files backed up to $prismaBackupTemp)" -ForegroundColor Gray
            }
            
            Copy-Item -Path $prismaBackupPath -Destination ".\backend\" -Recurse -Force
            Write-Host "✓ Prisma files restored" -ForegroundColor Green
        }
        
        # STEP 2: Restore database from SQL dump
        Write-Host "`n📄 Restoring from SQL dump..." -ForegroundColor Yellow
        
        # Check if container is running
        $containerRunning = docker ps --filter "name=$ContainerName" --format "{{.Names}}" 2>$null
        if (-not $containerRunning) {
            Write-Host "  Starting container..." -ForegroundColor Gray
            docker start $ContainerName | Out-Null
            Start-Sleep -Seconds 3
        }
        
        # Drop existing connections
        docker exec $ContainerName psql -U $DBUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DBName' AND pid <> pg_backend_pid();" 2>$null | Out-Null
        
        # Restore the database
        $sqlFile = Join-Path $backupFolder.FullName "database.sql"
        if (Test-Path $sqlFile) {
            Get-Content $sqlFile | docker exec -i $ContainerName psql -U $DBUser -d postgres
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✓ SQL dump restored" -ForegroundColor Green
            } else {
                Write-Host "✗ SQL restore failed!" -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "✗ SQL file not found in backup!" -ForegroundColor Red
            exit 1
        }
        
        
        Write-Host "`n========================================" -ForegroundColor Green
        Write-Host "  ✓ RESTORE COMPLETE!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "`nNOTE: You may need to:" -ForegroundColor Yellow
        Write-Host "  1. Restart your backend server" -ForegroundColor White
        Write-Host "  2. Run 'npx prisma generate' in backend folder if Prisma was updated" -ForegroundColor White
        
    } else {
        Write-Host "Invalid selection." -ForegroundColor Red
        exit 1
    }
}

# Main execution
switch ($Action.ToLower()) {
    "backup" {
        Backup-Database
    }
    "restore" {
        Restore-Database
    }
    default {
        Write-Host "`nTicket Pulse - Database Backup & Restore" -ForegroundColor Cyan
        Write-Host "========================================`n" -ForegroundColor Cyan
        Write-Host "Usage:" -ForegroundColor Yellow
        Write-Host "  Backup:  .\backup-db.ps1" -ForegroundColor White
        Write-Host "  Restore: .\backup-db.ps1 -Action restore" -ForegroundColor White
        Write-Host "`nBackup includes:" -ForegroundColor Yellow
        Write-Host "  ✓ Docker volume backup (fast restore)" -ForegroundColor White
        Write-Host "  ✓ SQL dump (portable, human-readable)" -ForegroundColor White
        Write-Host "  ✓ Prisma schema and migrations" -ForegroundColor White
        Write-Host "`nExamples:" -ForegroundColor Yellow
        Write-Host "  .\backup-db.ps1                 # Create backup" -ForegroundColor Gray
        Write-Host "  .\backup-db.ps1 -Action restore # Restore from backup" -ForegroundColor Gray
        exit 1
    }
}

