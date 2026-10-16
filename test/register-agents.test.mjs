// bin/register-agents.mjs on each platform, against a fake home: where each AI tool's config lives,
// that only installed tools are touched, other settings are kept and backed up, and --remove undoes it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'register-agents.mjs')
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-agents-'))
after(() => fs.rmSync(RUN, { recursive: true, force: true }))

const VSCODE = {
  win32: path.join('AppData', 'Roaming', 'Code', 'User'),
  darwin: path.join('Library', 'Application Support', 'Code', 'User'),
  linux: path.join('.config', 'Code', 'User'),
}
const NODE = '/usr/local/bin/node'

let homes = 0
function fakeHome(...dirs) {
  const home = path.join(RUN, `home-${++homes}`)
  for (const dir of dirs) fs.mkdirSync(path.join(home, dir), { recursive: true })
  return home
}
const register = (home, platform, ...extra) => execFileSync(process.execPath, [
  SCRIPT, '--home', home, '--platform', platform, '--app', path.join(home, '.project-pulse', 'app'),
  '--node', NODE, '--backup', path.join(home, 'backup'), ...extra,
], { encoding: 'utf8' })
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: VS Code's mcp.json in its own settings folder, plus Cursor; nothing else touched`, () => {
    const home = fakeHome(VSCODE[platform], '.cursor')
    const mcp = path.join(home, VSCODE[platform], 'mcp.json')
    fs.writeFileSync(mcp, JSON.stringify({ servers: { other: { command: 'x' } } }))
    const server = path.join(home, '.project-pulse', 'app', 'plugin', 'mcp', 'server.mjs')

    const out = register(home, platform)
    assert.match(out, /VS Code \(Copilot\): added to/)
    assert.deepEqual(read(mcp).servers, { other: { command: 'x' }, 'project-pulse': { type: 'stdio', command: NODE, args: [server] } })
    assert.deepEqual(read(path.join(home, '.cursor', 'mcp.json')).mcpServers['project-pulse'], { command: NODE, args: [server] })
    assert.equal(fs.readdirSync(path.join(home, 'backup')).length, 1, 'the existing mcp.json was backed up')
    for (const other of Object.keys(VSCODE).filter(p => p !== platform)) {
      assert.ok(!fs.existsSync(path.join(home, VSCODE[other])), `no ${other} settings folder appears`)
    }
    for (const absent of ['.codex', '.gemini', path.join('.codeium', 'windsurf')]) assert.ok(!fs.existsSync(path.join(home, absent)))

    register(home, platform, '--remove')
    assert.deepEqual(read(mcp).servers, { other: { command: 'x' } })
    assert.equal(read(path.join(home, '.cursor', 'mcp.json')).mcpServers['project-pulse'], undefined)
  })
}

test('macOS: Codex gets a TOML block with the POSIX node path; a second run updates it in place', () => {
  const home = fakeHome('.codex')
  register(home, 'darwin')
  register(home, 'darwin')
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.equal(toml.match(/\[mcp_servers\.project-pulse\]/g).length, 1)
  assert.match(toml, /command = "\/usr\/local\/bin\/node"/)
})
