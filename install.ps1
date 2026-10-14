<#
  Project Pulse installer. Per-user, no admin rights needed. Run it again to update.

  What it does:
    1. Copies the app to %USERPROFILE%\.project-pulse\app (data lives in ...\data).
    2. Backs up the Claude Code files it changes to ...\data\backups\<time>.
    3. Adds the Project Pulse mod to Claude Code at USER scope (every project, now and future):
       a local marketplace "project-pulse-local" plus the plugin "project-pulse".
       The plugin also brings the Project Pulse MCP tools to Claude Code.
    4. Builds the Claude Desktop extension (dist\ProjectPulse.mcpb) for you to add in Claude Desktop.
    5. Adds a Startup shortcut (service starts at Windows sign-in) and a Start menu shortcut.
    6. Starts the service.
  It does not touch your projects' files or your Claude Desktop config.
#>
param([switch]$NoStart, [switch]$SkipClaude)
$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$PulseHome = Join-Path $env:USERPROFILE '.project-pulse'
$App = Join-Path $PulseHome 'app'
$Data = Join-Path $PulseHome 'data'

function Step($text) { Write-Host "  > $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "    $text" -ForegroundColor Green }
function Note($text) { Write-Host "    $text" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  Project Pulse installer' -ForegroundColor White
Write-Host ''

# 1. Node.js 22.5+ (built-in SQLite)
Step 'Checking Node.js'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js 22.5 or newer is required. Install it from https://nodejs.org and run this again.' }
$node = $nodeCmd.Source
$nodeVersion = [version]((& $node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.5.0') { throw "Node.js $nodeVersion is too old. Project Pulse needs 22.5 or newer." }
Done "Node.js $nodeVersion"

# 2. Stop a running copy (update case)
Step 'Stopping any running Project Pulse service'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*\.project-pulse\app\service\server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 3. Copy the app
Step "Copying the app to $App"
New-Item -ItemType Directory -Force -Path $App, $Data | Out-Null
foreach ($dir in 'service', 'ui', 'plugin', 'bin', 'desktop-extension', 'docs', 'test') {
  $from = Join-Path $Source $dir
  if (-not (Test-Path $from)) { continue }
  robocopy $from (Join-Path $App $dir) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed (robocopy $LASTEXITCODE)" }
}
foreach ($file in 'README.md', 'package.json', 'install.ps1', 'uninstall.ps1', 'Install.cmd', 'Uninstall.cmd') {
  $from = Join-Path $Source $file
  if (Test-Path $from) { Copy-Item $from $App -Force }
}
Set-Content -Path (Join-Path $App 'bin\node.txt') -Value $node -Encoding ASCII
Done 'Copied'

# 4. Keep the data folder (token, database, logs) private to you
Step 'Restricting the data folder to your account'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $Data /inheritance:r /grant:r "*$($me):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
Done 'Only your account (and Windows itself) can read it'

# 5. App icon for the shortcuts
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 24, 31))), 2, 2, 60, 60)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 52, 211, 153)), 5
  $pen.LineJoin = 'Round'
  $g.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 10, 34), (New-Object System.Drawing.Point 22, 34), (New-Object System.Drawing.Point 28, 20), (New-Object System.Drawing.Point 36, 46), (New-Object System.Drawing.Point 42, 30), (New-Object System.Drawing.Point 54, 30)))
  $bmp.Save((Join-Path $App 'bin\pulse.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $stream = [System.IO.File]::Create((Join-Path $App 'bin\pulse.ico'))
  $icon.Save($stream)
  $stream.Close()
  $g.Dispose(); $bmp.Dispose()
} catch { Note 'Could not draw the app icon (shortcuts use the default icon)' }

# 6. Claude Code: the mod, at user scope
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($SkipClaude) {
  Note 'Skipped Claude Code registration (-SkipClaude)'
} elseif (-not $claudeCmd) {
  Note 'Claude Code CLI not found on PATH: install it, then run this installer again to add the mod.'
} else {
  $claude = $claudeCmd.Source
  Step 'Backing up the Claude Code files this step changes'
  $backup = Join-Path $Data ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  $toBackUp = @(
    (Join-Path $env:USERPROFILE '.claude\settings.json'),
    (Join-Path $env:USERPROFILE '.claude\plugins\known_marketplaces.json'),
    (Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json')
  )
  foreach ($file in $toBackUp) { if (Test-Path $file) { Copy-Item $file $backup } }
  Done "Backed up to $backup"

  Step 'Adding the Project Pulse mod to Claude Code (user scope: all projects)'
  $ErrorActionPreference = 'Continue'
  $marketplaces = (& $claude plugin marketplace list 2>$null) -join "`n"
  if ($marketplaces -match 'project-pulse-local') {
    & $claude plugin marketplace update project-pulse-local | Out-Host
  } else {
    & $claude plugin marketplace add (Join-Path $App 'plugin') | Out-Host
  }
  & $claude plugin install project-pulse@project-pulse-local --scope user | Out-Host
  $installed = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if ($installed) { Done 'Mod installed. New Claude Code sessions load it (run /reload-plugins in an open one).' }
  else { Note 'The plugin install reported a problem; see the lines above.' }
}

# 7. Claude Desktop extension package
Step 'Building the Claude Desktop extension'
# Zip entries are written with forward slashes (Compress-Archive in PowerShell 5.1 writes backslashes).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$dist = Join-Path $App 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$mcpb = Join-Path $dist 'ProjectPulse.mcpb'
Remove-Item $mcpb -ErrorAction SilentlyContinue
$png = Join-Path $App 'bin\pulse.png'
$manifest = Get-Content (Join-Path $App 'desktop-extension\manifest.json') -Raw | ConvertFrom-Json
if (Test-Path $png) { $manifest | Add-Member -NotePropertyName icon -NotePropertyValue 'icon.png' -Force }
$archive = [System.IO.Compression.ZipFile]::Open($mcpb, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $archive.CreateEntry('manifest.json')
  $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding $false))
  $writer.Write(($manifest | ConvertTo-Json -Depth 10))
  $writer.Dispose()
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $App 'plugin\mcp\server.mjs'), 'server/index.mjs') | Out-Null
  if (Test-Path $png) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $png, 'icon.png') | Out-Null }
} finally { $archive.Dispose() }
New-Item -ItemType Directory -Force -Path (Join-Path $Source 'dist') | Out-Null
Copy-Item $mcpb (Join-Path $Source 'dist\ProjectPulse.mcpb') -Force
Done "Built $mcpb"

# 8. Shortcuts
Step 'Adding shortcuts'
$shell = New-Object -ComObject WScript.Shell
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$icon = Join-Path $App 'bin\pulse.ico'
$startup = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Project Pulse service.lnk'))
$startup.TargetPath = $wscript
$startup.Arguments = "//B //Nologo `"$App\bin\start-service.vbs`""
$startup.WorkingDirectory = $App
$startup.Description = 'Starts the Project Pulse service when you sign in'
if (Test-Path $icon) { $startup.IconLocation = $icon }
$startup.Save()
$menu = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Project Pulse.lnk'))
$menu.TargetPath = $wscript
$menu.Arguments = "//B //Nologo `"$App\bin\open-window.vbs`""
$menu.WorkingDirectory = $App
$menu.Description = 'Open the Project Pulse window'
if (Test-Path $icon) { $menu.IconLocation = $icon }
$menu.Save()
Done 'Startup: service at sign-in. Start menu: "Project Pulse" opens the window.'

# 9. Start the service
if (-not $NoStart) {
  Step 'Starting the service'
  Start-Process -FilePath $wscript -ArgumentList '//B', '//Nologo', "`"$App\bin\start-service.vbs`""
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 400
    try { $up = (Invoke-RestMethod -Uri 'http://127.0.0.1:47821/api/health' -TimeoutSec 2).app -eq 'project-pulse' } catch {}
  }
  if ($up) { Done 'Running on http://127.0.0.1:47821 (local only)' } else { Note "Not answering yet; see $Data\logs\pulse.log" }
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host '  - Claude Code: reviews happen automatically after finished tasks. Type /pulse for one now, /pulse open for the window.'
Write-Host "  - Claude Desktop: double-click $mcpb (or Settings > Extensions > Advanced > Install Extension) to add the Pulse tools."
Write-Host '  - Start menu: "Project Pulse" opens the window. Uninstall with Uninstall.cmd.'
Write-Host ''
