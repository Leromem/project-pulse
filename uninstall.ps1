<#
  Project Pulse uninstaller.
    -RemoveData   also delete reviews, settings, logs and backups (kept by default).
  Your projects are never touched.
#>
param([switch]$RemoveData)
$ErrorActionPreference = 'Continue'
$PulseHome = Join-Path $env:USERPROFILE '.project-pulse'
$App = Join-Path $PulseHome 'app'
$Data = Join-Path $PulseHome 'data'

function Step($text) { Write-Host "  > $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "    $text" -ForegroundColor Green }

Write-Host ''
Write-Host '  Project Pulse uninstaller' -ForegroundColor White
Write-Host ''

Step 'Stopping the service and closing the Pulse window'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*\.project-pulse\app\service\server.mjs*' -or $_.CommandLine -like '*\.project-pulse\data\window-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Done 'Stopped'

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
  Step 'Removing the mod from Claude Code'
  $backup = Join-Path $Data ('backups\uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($file in (Join-Path $env:USERPROFILE '.claude\settings.json'), (Join-Path $env:USERPROFILE '.claude\plugins\known_marketplaces.json'), (Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json')) {
    if (Test-Path $file) { Copy-Item $file $backup }
  }
  & $claudeCmd.Source plugin uninstall project-pulse@project-pulse-local --scope user | Out-Host
  & $claudeCmd.Source plugin marketplace remove project-pulse-local | Out-Host
  Done "Removed (settings backed up to $backup)"
}

Step 'Removing the Pulse tools from other AI tools'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$agentScript = Join-Path $App 'bin\register-agents.mjs'
if ($nodeCmd -and (Test-Path $agentScript)) {
  & $nodeCmd.Source $agentScript --remove --app $App --backup (Join-Path $Data ('backups\uninstall-agents-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))) | Out-Host
}

Step 'Removing shortcuts'
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'Project Pulse service.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Project Pulse.lnk') -ErrorAction SilentlyContinue
Done 'Removed'

Step 'Removing the app'
Remove-Item $App -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveData) {
  Remove-Item $PulseHome -Recurse -Force -ErrorAction SilentlyContinue
  Done 'Removed the app and all Pulse data'
} else {
  Done "Removed the app. Your review history is kept in $Data (run with -RemoveData to delete it)."
}

Write-Host ''
Write-Host '  Claude Desktop: if you added the extension, remove "Project Pulse" in Settings > Extensions.' -ForegroundColor Yellow
Write-Host ''
