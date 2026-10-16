#!/usr/bin/env node
// Registers (or removes) the Project Pulse MCP server with other AI coding tools on this PC:
// Codex CLI, Cursor, Gemini CLI, Windsurf and VS Code (GitHub Copilot). Each config file is
// backed up before it changes; a file that cannot be parsed safely is skipped, never rewritten.
//
//   node register-agents.mjs --app <app dir> --node <node.exe> [--backup <dir>]
//                            [--remove] [--instructions] [--only codex,cursor] [--home <dir>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = name => args.includes(`--${name}`)

const HOME = opt('home') || os.homedir()
const APPDATA = opt('home') ? path.join(HOME, 'AppData', 'Roaming') : process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
const APP = path.resolve(opt('app') || path.join(HOME, '.project-pulse', 'app'))
const NODE = opt('node') || process.execPath
const SERVER = path.join(APP, 'plugin', 'mcp', 'server.mjs')
const BACKUP = opt('backup') || path.join(HOME, '.project-pulse', 'data', 'backups', `agents-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const REMOVE = flag('remove')
const INSTRUCTIONS = flag('instructions')
const ONLY = opt('only')?.split(',').map(s => s.trim().toLowerCase())
const NAME = 'project-pulse'
const BEGIN = '>>> project-pulse (added by the Project Pulse installer)'
const END = '<<< project-pulse'

const done = []
const skipped = []

function backup(file) {
  if (!fs.existsSync(file)) return
  fs.mkdirSync(BACKUP, { recursive: true })
  const target = path.join(BACKUP, file.replace(/[:\\/]+/g, '_'))
  if (!fs.existsSync(target)) fs.copyFileSync(file, target)
}

// JSON configs: add or remove one server entry under `key`, keeping everything else.
function jsonClient(label, file, key, entry) {
  let data = {}
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    try {
      data = text.trim() ? JSON.parse(text) : {}
    } catch {
      skipped.push(`${label}: ${file} has comments or is not plain JSON; add Project Pulse by hand (see README)`)
      return
    }
  } else if (REMOVE) {
    return
  }
  const servers = data[key] && typeof data[key] === 'object' ? data[key] : {}
  if (REMOVE) {
    if (!(NAME in servers)) return
    delete servers[NAME]
  } else {
    servers[NAME] = entry
  }
  data[key] = servers
  backup(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  done.push(`${label}: ${REMOVE ? 'removed from' : 'added to'} ${file}`)
}

// Text configs (TOML, Markdown): one marked block we own, appended or removed.
function blockClient(label, file, block, commentPrefix, commentSuffix = '') {
  const begin = `${commentPrefix} ${BEGIN}${commentSuffix}`
  const end = `${commentPrefix} ${END}${commentSuffix}`
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const pattern = new RegExp(`\\r?\\n?${escape(begin)}[\\s\\S]*?${escape(end)}\\r?\\n?`, 'g')
  const without = text.replace(pattern, '\n').replace(/\n{3,}$/, '\n')
  if (REMOVE) {
    if (without === text) return
    backup(file)
    fs.writeFileSync(file, without)
    done.push(`${label}: removed from ${file}`)
    return
  }
  if (label.startsWith('Codex') && without.includes(`[mcp_servers.${NAME}]`)) {
    skipped.push(`${label}: ${file} already defines [mcp_servers.${NAME}]; left as is`)
    return
  }
  backup(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sep = without && !without.endsWith('\n') ? '\n\n' : without ? '\n' : ''
  fs.writeFileSync(file, `${without}${sep}${begin}\n${block}\n${end}\n`)
  done.push(`${label}: ${text.includes(begin) ? 'updated in' : 'added to'} ${file}`)
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exists = p => fs.existsSync(p)
const want = id => !ONLY || ONLY.includes(id)
const stdio = { command: NODE, args: [SERVER] }

const INSTRUCTION_TEXT = fs.existsSync(path.join(APP, 'integrations', 'agent-instructions.md'))
  ? fs.readFileSync(path.join(APP, 'integrations', 'agent-instructions.md'), 'utf8').trim()
  : ''

// ---- Codex CLI (~/.codex/config.toml, ~/.codex/AGENTS.md)
const codexDir = path.join(HOME, '.codex')
if (want('codex') && exists(codexDir)) {
  // TOML basic strings take JSON-style escapes, so paths with backslashes or quotes stay valid.
  const toml = `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(SERVER)}]`
  blockClient('Codex', path.join(codexDir, 'config.toml'), toml, '#')
  if (INSTRUCTIONS || REMOVE) blockClient('Codex instructions', path.join(codexDir, 'AGENTS.md'), INSTRUCTION_TEXT, '<!--', ' -->')
}

// ---- Cursor (~/.cursor/mcp.json)
if (want('cursor') && exists(path.join(HOME, '.cursor'))) {
  jsonClient('Cursor', path.join(HOME, '.cursor', 'mcp.json'), 'mcpServers', stdio)
}

// ---- Gemini CLI (~/.gemini/settings.json, ~/.gemini/GEMINI.md)
if (want('gemini') && exists(path.join(HOME, '.gemini'))) {
  jsonClient('Gemini CLI', path.join(HOME, '.gemini', 'settings.json'), 'mcpServers', stdio)
  if (INSTRUCTIONS || REMOVE) blockClient('Gemini CLI instructions', path.join(HOME, '.gemini', 'GEMINI.md'), INSTRUCTION_TEXT, '<!--', ' -->')
}

// ---- Windsurf (~/.codeium/windsurf/mcp_config.json)
if (want('windsurf') && exists(path.join(HOME, '.codeium', 'windsurf'))) {
  jsonClient('Windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', stdio)
}

// ---- VS Code / GitHub Copilot (%APPDATA%\Code\User\mcp.json)
if (want('vscode') && exists(path.join(APPDATA, 'Code', 'User'))) {
  jsonClient('VS Code (Copilot)', path.join(APPDATA, 'Code', 'User', 'mcp.json'), 'servers', { type: 'stdio', ...stdio })
}

for (const line of done) console.log(`    ${line}`)
for (const line of skipped) console.log(`    skipped ${line}`)
if (!done.length && !skipped.length) console.log(REMOVE ? '    No other AI tools had Project Pulse registered.' : '    No other AI tools found (Codex, Cursor, Gemini CLI, Windsurf, VS Code).')
if (done.length && !REMOVE && fs.existsSync(BACKUP)) console.log(`    Backups: ${BACKUP}`)
