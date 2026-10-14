// The Pulse window (a dedicated Edge/Chrome app window with its own profile), idle-aware opening,
// and Windows notifications. Nothing here takes text from a review and runs it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_PROFILE } from './config.mjs'
import { log } from './log.mjs'

const BROWSERS = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

export function findBrowser() {
  return BROWSERS.find(p => p && fs.existsSync(p)) || null
}

function powershell(script, env = {}, timeoutMs = 20 * 60_000) {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true, env: { ...process.env, ...env },
    })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve(''))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim())
    })
    child.stdin.end(script)
  })
}

// Resolves true once the keyboard and mouse have been idle for `idleMs`; false after `maxMs`.
export async function waitForIdle(idleMs = 4000, maxMs = 15 * 60_000) {
  if (process.platform !== 'win32') return true
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class PulseIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint IdleMs() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }
}
"@
$deadline = (Get-Date).AddMilliseconds([int]$env:PULSE_MAX)
while ((Get-Date) -lt $deadline) {
  if ([PulseIdle]::IdleMs() -ge [int]$env:PULSE_IDLE) { 'IDLE'; exit 0 }
  Start-Sleep -Milliseconds 400
}
'TIMEOUT'`
  const out = await powershell(script, { PULSE_IDLE: String(idleMs), PULSE_MAX: String(maxMs) }, maxMs + 30_000)
  return out.endsWith('IDLE')
}

export function launchWindow(url, bounds) {
  const browser = findBrowser()
  const args = [
    `--app=${url}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msHubApps,msUndersideButton,EdgeCollections',
    '--disable-sync',
  ]
  if (bounds && Number.isFinite(bounds.w) && bounds.w >= 320 && bounds.h >= 360) {
    args.push(`--window-size=${Math.round(bounds.w)},${Math.round(bounds.h)}`)
    args.push(`--window-position=${Math.round(bounds.x)},${Math.round(bounds.y)}`)
  } else {
    args.push('--window-size=460,800')
  }
  try {
    if (browser) {
      spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      log.info(`Opened the Pulse window with ${path.basename(browser)}`)
    } else {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      log.warn('No Edge or Chrome found; opened the Pulse window in the default browser')
    }
    return true
  } catch (err) {
    log.error('Could not open the Pulse window', err)
    return false
  }
}

export function notify(title, body) {
  if (process.platform !== 'win32') return
  const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:PULSE_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:PULSE_BODY)) > $null
$n = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)`
  powershell(script, { PULSE_TITLE: title.slice(0, 120), PULSE_BODY: body.slice(0, 240) }, 20_000)
    .catch(err => log.warn('Notification failed', err))
}

export function openFolder(dir) {
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
}
