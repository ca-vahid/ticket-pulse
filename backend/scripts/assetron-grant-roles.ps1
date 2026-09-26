<#
  Assetron Part B — let Ticket Pulse call the Assetron PRODUCTION API (26 Sep 2026).

  What it does (Sam Khadem's guide, B3 step 2):
    1. Makes sure the "Assetron API" app registration defines two application roles:
         Assets.Read          search, filter-options, one asset
         Reservations.Write   create and decide reservations
       Existing roles are kept; only missing ones are added.
    2. Grants both roles to Ticket Pulse's managed identity (ticket-pulse-app).

  It does NOT turn on "assignment required" on Assetron's API: that would also
  lock out Assetron's own web app users until they are assigned. That one is Sam's call.

  Run (Azure CLI signed in as someone who can edit app registrations):
    .\assetron-grant-roles.ps1            # dry run: shows what would change
    .\assetron-grant-roles.ps1 -Apply     # does it
#>
param([switch]$Apply)
$ErrorActionPreference = 'Stop'

$AssetronApiAppId = '4f4e3748-e026-4dd8-9c07-6ac325583879'   # "Assetron API" (production)
$TicketPulseMiId  = '47faa7a4-3ba4-4b98-a13f-6e68354bb4ad'   # ticket-pulse-app managed identity
$Wanted = @(
  @{ value = 'Assets.Read';        displayName = 'Assets.Read';        description = 'Search assets, read filter options and one asset' },
  @{ value = 'Reservations.Write'; displayName = 'Reservations.Write'; description = 'Create and decide laptop reservations' }
)

$app = az ad app show --id $AssetronApiAppId -o json | ConvertFrom-Json
$sp  = az ad sp show  --id $AssetronApiAppId -o json | ConvertFrom-Json
Write-Host "Assetron API: app $($app.appId), service principal $($sp.id)"
$roles = @($app.appRoles)
Write-Host ("Roles now: " + ($(if ($roles.Count) { ($roles | ForEach-Object { $_.value }) -join ', ' } else { '(none)' })))

# 1. Add the missing roles (the CLI replaces the whole list, so send old + new).
$missing = $Wanted | Where-Object { $v = $_.value; -not ($roles | Where-Object { $_.value -eq $v }) }
if ($missing) {
  Write-Host ("Will add roles: " + (($missing | ForEach-Object { $_.value }) -join ', '))
  if ($Apply) {
    $all = @($roles | ForEach-Object {
      [ordered]@{ allowedMemberTypes = $_.allowedMemberTypes; description = $_.description; displayName = $_.displayName; id = $_.id; isEnabled = $_.isEnabled; value = $_.value }
    })
    foreach ($m in $missing) {
      $all += [ordered]@{ allowedMemberTypes = @('Application'); description = $m.description; displayName = $m.displayName; id = [guid]::NewGuid().ToString(); isEnabled = $true; value = $m.value }
    }
    $file = Join-Path $env:TEMP 'assetron-app-roles.json'
    ConvertTo-Json -InputObject $all -Depth 5 | Set-Content -Path $file -Encoding utf8
    az ad app update --id $AssetronApiAppId --app-roles "@$file"
    Remove-Item $file
    Write-Host 'Roles added. Waiting 20 s for Entra to publish them to the service principal...'
    Start-Sleep -Seconds 20
    $sp = az ad sp show --id $AssetronApiAppId -o json | ConvertFrom-Json
  }
} else { Write-Host 'Both roles already exist.' }

# 2. Grant both roles to Ticket Pulse's managed identity (skip ones already granted).
$have = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$TicketPulseMiId/appRoleAssignments" -o json | ConvertFrom-Json
foreach ($w in $Wanted) {
  $role = @($sp.appRoles) | Where-Object { $_.value -eq $w.value }
  if (-not $role) { Write-Host "Would grant $($w.value) to ticket-pulse-app (after the role exists)"; continue }
  if ($have.value | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $sp.id }) { Write-Host "$($w.value): already granted"; continue }
  Write-Host "Will grant $($w.value) to ticket-pulse-app"
  if ($Apply) {
    $body = @{ principalId = $TicketPulseMiId; resourceId = $sp.id; appRoleId = $role.id } | ConvertTo-Json -Compress
    $file = Join-Path $env:TEMP 'assetron-grant.json'
    Set-Content -Path $file -Value $body -Encoding utf8
    az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$TicketPulseMiId/appRoleAssignments" --headers 'Content-Type=application/json' --body "@$file" -o none
    Remove-Item $file
    Write-Host "$($w.value): granted"
  }
}
if (-not $Apply) { Write-Host "`nDry run only. Run again with -Apply to make these changes." }
else { Write-Host "`nDone. Tell Claude; the next step is: node backend/scripts/assetron-switch-on.mjs --client-id $AssetronApiAppId" }
