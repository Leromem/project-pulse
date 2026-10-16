// The window module's platform switches: which browser opens the Pulse window, how idle time is
// read, how notifications are sent and folders opened, on Windows, macOS and Linux. Nothing is
// launched: lookups and commands run against stand-ins, so every platform is checked on any machine.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-window-'))
process.env.PROJECT_PULSE_HOME = RUN
after(() => fs.rmSync(RUN, { recursive: true, force: true }))
const W = await import('../service/window.mjs')

const only = (...hits) => p => hits.includes(p)
const onPathOnly = (...names) => name => (names.includes(name) ? `/usr/bin/${name}` : null)

test('macOS: the window opens in Edge, else Chrome, else Chromium, from /Applications or ~/Applications', () => {
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const myChromium = '/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium'
  const find = exists => W.findBrowser({ platform: 'darwin', home: '/Users/me', exists })
  assert.equal(find(only(chrome, edge)), edge)
  assert.equal(find(only(chrome)), chrome)
  assert.equal(find(only(myChromium)), myChromium)
  assert.equal(find(() => false), null)
})

test('Linux: the browser is looked up on PATH, Edge first', () => {
  const find = which => W.findBrowser({ platform: 'linux', which })
  assert.equal(find(onPathOnly('chromium')), '/usr/bin/chromium')
  assert.equal(find(onPathOnly('chromium', 'google-chrome')), '/usr/bin/google-chrome')
  assert.equal(find(onPathOnly('chromium', 'microsoft-edge')), '/usr/bin/microsoft-edge')
  assert.equal(find(() => null), null)
})

test('Windows: the Edge and Chrome install paths are the same as before', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
  assert.deepEqual(W.browserCandidates('win32', env), [
    'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\PF\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ])
  const chrome = 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe'
  assert.equal(W.findBrowser({ platform: 'win32', env, exists: only(chrome) }), chrome)
})

test("the default browser and the log folder open with each platform's own command", () => {
  assert.deepEqual(W.openCommand('http://x/', { platform: 'darwin' }), ['open', ['http://x/']])
  assert.deepEqual(W.openCommand('/logs', { platform: 'darwin', folder: true }), ['open', ['/logs']])
  assert.deepEqual(W.openCommand('http://x/', { platform: 'linux' }), ['xdg-open', ['http://x/']])
  assert.deepEqual(W.openCommand('/logs', { platform: 'linux', folder: true }), ['xdg-open', ['/logs']])
  assert.deepEqual(W.openCommand('http://x/', { platform: 'win32' }), ['cmd.exe', ['/c', 'start', '', 'http://x/']])
  assert.deepEqual(W.openCommand('C:\\logs', { platform: 'win32', folder: true }), ['explorer.exe', ['C:\\logs']])
})

test('idle time: ioreg on macOS (nanoseconds), xprintidle on Linux (milliseconds)', async () => {
  const ioreg = '    | |   "HIDIdleTime" = 7250000000\n    | |   "HIDKeyboardModifierMappingPairs" = ()\n'
  assert.equal(W.parseIoregIdle(ioreg), 7250)
  assert.equal(W.parseIoregIdle(''), null)
  assert.equal(W.parseXprintidle('1234\n'), 1234)
  assert.equal(W.parseXprintidle(''), null)
  assert.equal(W.parseXprintidle("couldn't open display"), null)

  const runs = []
  const run = async (cmd, args) => (runs.push([cmd, ...args]), ioreg)
  assert.equal(await W.idleReader('darwin', { run })(), 7250)
  assert.deepEqual(runs, [['/usr/sbin/ioreg', '-c', 'IOHIDSystem']])
  assert.equal(await W.idleReader('linux', { which: onPathOnly('xprintidle'), run: async () => '9000\n' })(), 9000)
  assert.equal(W.idleReader('linux', { which: () => null }), null)
  assert.equal(W.idleReader('win32'), null)
})

test('waiting for idle: waits while typing, gives up at the limit, never blocks when idle time is unknown', async () => {
  const seconds = [0.1, 0.2, 5]
  const typingThenIdle = async () => `"HIDIdleTime" = ${seconds.shift() * 1e9}`
  assert.equal(await W.waitForIdle(4000, 10_000, { platform: 'darwin', pollMs: 1, run: typingThenIdle }), true)
  assert.equal(seconds.length, 0)
  assert.equal(await W.waitForIdle(4000, 20, { platform: 'darwin', pollMs: 5, run: async () => '"HIDIdleTime" = 0' }), false)
  // Linux without xprintidle, or under Wayland where it cannot answer: the window opens right away.
  assert.equal(await W.waitForIdle(4000, 10_000, { platform: 'linux', which: () => null }), true)
  assert.equal(await W.waitForIdle(4000, 10_000, { platform: 'linux', which: onPathOnly('xprintidle'), run: async () => '' }), true)
})

test('notifications: review text goes in as arguments, never into the AppleScript', () => {
  const title = 'Project Pulse · "shop"'
  const body = '"; do shell script "touch /tmp/pwned" --'
  const [cmd, args] = W.notifyCommand(title, body, 'darwin')
  assert.equal(cmd, '/usr/bin/osascript')
  assert.deepEqual(args.slice(-2), [title, body])
  const script = args.slice(0, -2)
  script.forEach((arg, i) => (i % 2 === 0 ? assert.equal(arg, '-e') : assert.ok(!/shop|touch/.test(arg), arg)))
  // A title that looks like an option would be read as one by osascript.
  assert.deepEqual(W.notifyCommand('-e title', 'b', 'darwin')[1].slice(-2), [' -e title', 'b'])
  assert.deepEqual(W.notifyCommand(title, body, 'linux'), ['notify-send', ['--app-name=Project Pulse', '--', title, body]])
  assert.equal(W.notifyCommand(title, body, 'win32'), null)
})
