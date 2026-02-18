# Kill Node Processes (except Claude AI)
# This script terminates all node.exe processes except the one running Claude AI

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Node.exe Process Cleanup Script" -ForegroundColor White
Write-Host "============================================================`n" -ForegroundColor Cyan

# Get all node.exe processes
$nodeProcesses = Get-Process -Name node -ErrorAction SilentlyContinue

if ($null -eq $nodeProcesses -or $nodeProcesses.Count -eq 0) {
    Write-Host "✓ No node.exe processes found running." -ForegroundColor Green
    Write-Host "`nPress any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

Write-Host "Found $($nodeProcesses.Count) node.exe process(es)`n" -ForegroundColor Yellow

# Filter and display processes
$processesToKill = @()
$processesToKeep = @()

foreach ($process in $nodeProcesses) {
    try {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
        
        # Check if it's Claude AI process
        if ($commandLine -like "*claude-code*") {
            $processesToKeep += [PSCustomObject]@{
                PID = $process.Id
                CommandLine = $commandLine
            }
        } else {
            $processesToKill += [PSCustomObject]@{
                PID = $process.Id
                CommandLine = $commandLine
            }
        }
    } catch {
        # If we can't get command line, add to kill list (likely orphaned)
        $processesToKill += [PSCustomObject]@{
            PID = $process.Id
            CommandLine = "(Unable to retrieve - possibly orphaned)"
        }
    }
}

# Display processes to keep
if ($processesToKeep.Count -gt 0) {
    Write-Host "PROTECTED PROCESSES (will NOT be killed):" -ForegroundColor Green
    Write-Host "─────────────────────────────────────────────────────────" -ForegroundColor Gray
    foreach ($proc in $processesToKeep) {
        Write-Host "  PID $($proc.PID):" -ForegroundColor White -NoNewline
        Write-Host " $($proc.CommandLine.Substring(0, [Math]::Min(80, $proc.CommandLine.Length)))..." -ForegroundColor Gray
    }
    Write-Host ""
}

# Display processes to kill
if ($processesToKill.Count -eq 0) {
    Write-Host "✓ All running node.exe processes are protected (Claude AI)." -ForegroundColor Green
    Write-Host "`nPress any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

Write-Host "PROCESSES TO BE TERMINATED:" -ForegroundColor Red
Write-Host "─────────────────────────────────────────────────────────" -ForegroundColor Gray
foreach ($proc in $processesToKill) {
    Write-Host "  PID $($proc.PID):" -ForegroundColor White -NoNewline
    $cmdPreview = if ($proc.CommandLine.Length -gt 80) { 
        $proc.CommandLine.Substring(0, 80) + "..." 
    } else { 
        $proc.CommandLine 
    }
    Write-Host " $cmdPreview" -ForegroundColor Gray
}

# Confirm before killing
Write-Host "`n─────────────────────────────────────────────────────────" -ForegroundColor Gray
Write-Host "WARNING:" -ForegroundColor Yellow -NoNewline
Write-Host " About to terminate $($processesToKill.Count) node.exe process(es)" -ForegroundColor White
Write-Host ""
$confirmation = Read-Host "Continue? (Y/N)"

if ($confirmation -ne 'Y' -and $confirmation -ne 'y') {
    Write-Host "`n✗ Operation cancelled." -ForegroundColor Yellow
    Write-Host "`nPress any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

# Kill the processes
Write-Host "`nTerminating processes..." -ForegroundColor Yellow
$killedCount = 0
$failedCount = 0

foreach ($proc in $processesToKill) {
    try {
        Stop-Process -Id $proc.PID -Force -ErrorAction Stop
        Write-Host "  ✓ Killed PID $($proc.PID)" -ForegroundColor Green
        $killedCount++
    } catch {
        Write-Host "  ✗ Failed to kill PID $($proc.PID): $($_.Exception.Message)" -ForegroundColor Red
        $failedCount++
    }
}

# Summary
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "   SUMMARY" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  ✓ Processes terminated: $killedCount" -ForegroundColor Green
if ($failedCount -gt 0) {
    Write-Host "  ✗ Failed to terminate: $failedCount" -ForegroundColor Red
}
Write-Host "  🛡️  Protected (Claude AI): $($processesToKeep.Count)" -ForegroundColor Cyan
Write-Host ""

Write-Host "`nPress any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

