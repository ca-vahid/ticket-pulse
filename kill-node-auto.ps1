# Quick Node Process Cleanup (Auto-confirm)
# Kills all node.exe except Claude AI/Cursor processes

Write-Host "Cleaning up Node processes..." -ForegroundColor Yellow

$nodeProcesses = Get-Process -Name node -ErrorAction SilentlyContinue
if ($null -eq $nodeProcesses) {
    Write-Host "✓ No node processes to clean" -ForegroundColor Green
    exit 0
}

$killed = 0
foreach ($process in $nodeProcesses) {
    try {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
        
        # Protect Claude AI and Cursor processes
        if ($commandLine -like "*claude-ai*" ) {
            Write-Host "  → Keeping PID $($process.Id) (protected)" -ForegroundColor Gray
        } else {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            Write-Host "  ✓ Killed PID $($process.Id)" -ForegroundColor Green
            $killed++
        }
    } catch {
        # Skip protected or inaccessible processes
    }
}

Write-Host "`n✅ Cleaned up $killed node process(es)" -ForegroundColor Green

