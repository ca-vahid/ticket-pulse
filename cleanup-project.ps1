# Project Cleanup Script
# Removes temporary files, test scripts, and organizes the project

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Ticket Pulse - Project Cleanup" -ForegroundColor White
Write-Host "============================================================`n" -ForegroundColor Cyan

$cleanupItems = @{
    "Test Scripts (backend)" = @(
        "backend\test-*.js"
        "backend\check-*.js"
        "backend\debug-*.js"
        "backend\analyze-*.js"
        "backend\verify-*.js"
        "backend\backfill-*.js"
        "backend\count-*.js"
        "backend\final-*.js"
        "backend\fix-*.js"
        "backend\repair-*.js"
        "backend\reset-*.js"
    )
    "Test Scripts (root)" = @(
        "test-*.js"
    )
    "Temp Files" = @(
        "nul"
        "backend\nul"
        "frontend\nul"
        "backend\prisma\nul"
        "cookies.txt"
    )
}

Write-Host "Files to be removed:`n" -ForegroundColor Yellow

$totalFiles = 0
$filesToRemove = @()

foreach ($category in $cleanupItems.Keys) {
    Write-Host "📁 $category" -ForegroundColor Cyan
    $categoryFiles = @()
    
    foreach ($pattern in $cleanupItems[$category]) {
        $files = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
        if ($files) {
            foreach ($file in $files) {
                $categoryFiles += $file
                $filesToRemove += $file
                Write-Host "   - $($file.Name)" -ForegroundColor Gray
            }
        }
    }
    
    if ($categoryFiles.Count -eq 0) {
        Write-Host "   (none found)" -ForegroundColor DarkGray
    } else {
        $totalFiles += $categoryFiles.Count
    }
    Write-Host ""
}

if ($totalFiles -eq 0) {
    Write-Host "✅ No files to clean up. Project is already clean!" -ForegroundColor Green
    exit 0
}

Write-Host "Total files to remove: $totalFiles" -ForegroundColor Yellow
Write-Host "`n─────────────────────────────────────────────────────────" -ForegroundColor Gray
$confirmation = Read-Host "Proceed with cleanup? (Y/N)"

if ($confirmation -ne 'Y' -and $confirmation -ne 'y') {
    Write-Host "`n✗ Cleanup cancelled." -ForegroundColor Yellow
    exit 0
}

Write-Host "`nRemoving files..." -ForegroundColor Cyan
$removedCount = 0
$failedCount = 0

foreach ($file in $filesToRemove) {
    try {
        Remove-Item -Path $file.FullName -Force -ErrorAction Stop
        Write-Host "  ✓ Removed: $($file.Name)" -ForegroundColor Green
        $removedCount++
    } catch {
        Write-Host "  ✗ Failed: $($file.Name) - $($_.Exception.Message)" -ForegroundColor Red
        $failedCount++
    }
}

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "   CLEANUP COMPLETE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  ✓ Files removed: $removedCount" -ForegroundColor Green
if ($failedCount -gt 0) {
    Write-Host "  ✗ Failed: $failedCount" -ForegroundColor Red
}
Write-Host ""
Write-Host "Project is now clean and ready for development! 🎉" -ForegroundColor Cyan
Write-Host ""













