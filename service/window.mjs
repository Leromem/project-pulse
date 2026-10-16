// The Pulse window (a dedicated Edge/Chrome app window with its own profile), idle-aware opening,
// and desktop notifications, on Windows, macOS and Linux. Nothing here takes text from a review
// and runs it: review text only ever travels as its own argument or environment value.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BROWSER_PROFILE, onPath } from './config.mjs'
import { log } from './log.mjs'

// Chromium browsers that can open an --app window: install paths on Windows and macOS, commands
// looked up on PATH everywhere else.
export function browserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    return [
      path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  if (platform === 'darwin') {
    const apps = ['Microsoft Edge', 'Google Chrome', 'Chromium']
    return ['/Applications', path.posix.join(home, 'Applications')]
      .flatMap(dir => apps.map(app => path.posix.join(dir, `${app}.app`, 'Contents', 'MacOS', app)))
  }
  return ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
}

export function findBrowser({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync, which = onPath } = {}) {
  const candidates = browserCandidates(platform, env, home)
  if (platform === 'win32' || platform === 'darwin') return candidates.find(p => p && exists(p)) || null
  for (const name of candidates) {
    const hit = which(name, env)
    if (hit) return hit
  }
  return null
}

// How each platform opens a URL in the default browser, or a folder in its file manager.
export function openCommand(target, { platform = process.platform, folder = false } = {}) {
  if (platform === 'win32') return folder ? ['explorer.exe', [target]] : ['cmd.exe', ['/c', 'start', '', target]]
  return [platform === 'darwin' ? 'open' : 'xdg-open', [target]]
}

function detach(cmd, args, options = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...options })
  child.on('error', err => log.warn(`Could not run ${cmd}`, err))
  child.unref()
}

function output(cmd, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
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

// macOS: `ioreg -c IOHIDSystem` reports HIDIdleTime in nanoseconds.
export function parseIoregIdle(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text || '')
  return m ? Math.floor(Number(m[1]) / 1e6) : null
}

// Linux (X11): `xprintidle` prints milliseconds.
export function parseXprintidle(text) {
  const s = String(text || '').trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

// A reader for how long (ms) the keyboard and mouse have been idle on macOS or Linux, or null when
// this machine can't tell (Linux without xprintidle, or under Wayland): then the user counts as idle.
export function idleReader(platform = process.platform, { run = output, which = onPath } = {}) {
  if (platform === 'win32') return null
  if (platform === 'darwin') return async () => parseIoregIdle(await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem']))
  const bin = which('xprintidle')
  return bin ? async () => parseXprintidle(await run(bin, [])) : null
}

// Resolves true once the keyboard and mouse have been idle for `idleMs`; false after `maxMs`.
export async function waitForIdle(idleMs = 4000, maxMs = 15 * 60_000, { platform = process.platform, pollMs = 1000, ...deps } = {}) {
  if (platform === 'win32') return windowsWaitForIdle(idleMs, maxMs)
  const read = idleReader(platform, deps)
  if (!read) return true
  const deadline = Date.now() + maxMs
  for (;;) {
    const idle = await read()
    if (idle === null || idle >= idleMs) return true
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, pollMs))
  }
}

async function windowsWaitForIdle(idleMs, maxMs) {
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
      detach(browser, args, { windowsHide: false })
      log.info(`Opened the Pulse window with ${path.basename(browser)}`)
    } else {
      const [cmd, cmdArgs] = openCommand(url)
      detach(cmd, cmdArgs, { windowsHide: true })
      log.warn('No Edge, Chrome or Chromium found; opened the Pulse window in the default browser')
    }
    return true
  } catch (err) {
    log.error('Could not open the Pulse window', err)
    return false
  }
}

// macOS and Linux. The text goes in as separate arguments, never into the AppleScript itself.
// osascript stops reading options at the first argument, so the title must not look like one.
export function notifyCommand(title, body, platform = process.platform) {
  if (platform === 'win32') return null
  if (platform === 'darwin') {
    const script = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']
    return ['/usr/bin/osascript', [...script.flatMap(line => ['-e', line]), title.replace(/^-/, ' -'), body]]
  }
  return ['notify-send', ['--app-name=Project Pulse', '--', title, body]]
}

export function notify(title, body) {
  title = title.slice(0, 120)
  body = body.slice(0, 240)
  const posix = notifyCommand(title, body)
  if (posix) {
    execFile(posix[0], posix[1], { timeout: 20_000 }, err => err && log.warn('Notification failed', err))
    return
  }
  const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:PULSE_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:PULSE_BODY)) > $null
$n = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)`
  powershell(script, { PULSE_TITLE: title, PULSE_BODY: body }, 20_000)
    .catch(err => log.warn('Notification failed', err))
}

export function openFolder(dir) {
  const [cmd, args] = openCommand(dir, { folder: true })
  detach(cmd, args)
}
