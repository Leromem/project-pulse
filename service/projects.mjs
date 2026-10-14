// Works out which project a file belongs to, by stable folder path, never by display name.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOME } from './config.mjs'

const MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json',
  'pubspec.yaml', 'deno.json', 'Gemfile', 'pom.xml', 'build.gradle', 'CLAUDE.md',
]
const IGNORED = [
  path.join(os.homedir(), '.claude'),
  HOME,
  os.tmpdir(),
  path.join(os.homedir(), 'AppData'),
].map(key)

function key(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

function isInside(child, parent) {
  const c = key(child)
  const p = key(parent)
  return c === p || c.startsWith(p + path.sep)
}

const exists = p => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function projectId(root) {
  return 'p_' + crypto.createHash('sha1').update(key(root)).digest('hex').slice(0, 12)
}

export function isIgnored(file) {
  return IGNORED.some(dir => isInside(file, dir))
}

const workspaceCache = new Map()

// A folder that holds several projects (like a "Claude" folder of sites), not a project itself.
export function isWorkspace(dir, settings) {
  if ((settings.workspaces || []).some(w => key(w) === key(dir))) return true
  const cached = workspaceCache.get(key(dir))
  if (cached && Date.now() - cached.at < 60_000) return cached.value
  let value = false
  if (!exists(path.join(dir, '.git')) && !MARKERS.some(m => exists(path.join(dir, m)))) {
    let projects = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const child = path.join(dir, entry.name)
        if (exists(path.join(child, '.git')) || exists(path.join(child, '.claude')) || MARKERS.some(m => exists(path.join(child, m)))) projects++
        if (projects >= 2) break
      }
    } catch {}
    value = projects >= 2
  }
  workspaceCache.set(key(dir), { value, at: Date.now() })
  return value
}

// A git worktree (Claude Code's desktop app makes them under .claude/worktrees) belongs to its
// main repository: its `.git` is a file pointing at <main>/.git/worktrees/<name>.
export function mainRepo(root) {
  try {
    const dotGit = path.join(root, '.git')
    if (!fs.statSync(dotGit).isFile()) return root
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    const main = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(path.resolve(root, gitdir))?.[1]
    return main && exists(path.join(main, '.git')) ? path.resolve(main) : root
  } catch {
    return root
  }
}

function gitRootAbove(dir) {
  let current = path.resolve(dir)
  for (let i = 0; i < 40; i++) {
    if (exists(path.join(current, '.git'))) return mainRepo(current)
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

// The project folder for one changed file, or null when it is not project work.
export function rootFor(file, cwd, settings) {
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd, file)
  if (isIgnored(abs)) return null
  const inside = isInside(abs, cwd)
  const chain = []
  let dir = path.dirname(abs)
  for (let i = 0; i < 40; i++) {
    chain.push(dir)
    if (inside && key(dir) === key(cwd)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const git = chain.find(d => exists(path.join(d, '.git')))
  if (git && !(inside && key(git) === key(cwd) && isWorkspace(cwd, settings))) return mainRepo(git)
  // A session started in a subfolder of a repository (say <repo>\web) still works on the repository.
  const repo = inside && !isWorkspace(cwd, settings) ? gitRootAbove(cwd) : null
  if (repo) return repo
  const marked = chain.find(d => MARKERS.some(m => exists(path.join(d, m))) && !(key(d) === key(cwd) && isWorkspace(cwd, settings)))
  if (marked) return marked
  if (!inside) return null
  if (isWorkspace(cwd, settings)) {
    const first = path.relative(cwd, abs).split(/[\\/]/)[0]
    const child = path.join(cwd, first)
    return first && child !== abs ? child : null
  }
  return cwdProject(cwd, settings) || path.resolve(cwd)
}

// The nearest folder at or above `dir` with a project file, never climbing into a folder of projects.
function markedAbove(dir, settings) {
  let current = path.resolve(dir)
  for (let i = 0; i < 40; i++) {
    if (MARKERS.some(m => exists(path.join(current, m)))) return current
    const parent = path.dirname(current)
    if (parent === current || isWorkspace(parent, settings)) return null
    current = parent
  }
  return null
}

// The project a session sitting in `cwd` works on, or null for a folder of projects: the git
// repository it is in, else the nearest folder with a project file, else the folder itself.
export function cwdProject(cwd, settings) {
  if (!cwd || isIgnored(cwd) || isWorkspace(cwd, settings)) return null
  return gitRootAbove(cwd) || markedAbove(cwd, settings) || path.resolve(cwd)
}

export function projectName(root) {
  return path.basename(root) || root
}

export function isGitRepo(root) {
  return exists(path.join(root, '.git'))
}
