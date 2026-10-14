#!/usr/bin/env node
// Project Pulse MCP server (stdio). Lets Claude Desktop (and Claude Code) request a review,
// read a project's Pulse history and manage its recommendations. Self-contained: no packages.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const VERSION = '1.0.0'
const HOME = process.env.PROJECT_PULSE_HOME || path.join(os.homedir(), '.project-pulse')
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

function connection() {
  const token = fs.readFileSync(path.join(HOME, 'data', 'token'), 'utf8').trim()
  let port = 47821
  try {
    port = Number(JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'service.json'), 'utf8')).port) || port
  } catch {}
  return { base: `http://127.0.0.1:${port}`, token }
}

async function healthy() {
  try {
    const res = await fetch(`${connection().base}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureService() {
  if (await healthy()) return
  const vbs = path.join(HOME, 'app', 'bin', 'start-service.vbs')
  if (!fs.existsSync(vbs)) throw new Error('Project Pulse is not installed (run Install.cmd in the Project Pulse folder).')
  spawn('wscript.exe', ['//B', '//Nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await healthy()) return
  }
  throw new Error('The Project Pulse service did not start. See its diagnostic log in ' + path.join(HOME, 'data', 'logs'))
}

async function api(method, route, body) {
  await ensureService()
  const { base, token } = connection()
  const res = await fetch(base + route, {
    method,
    headers: { 'X-Pulse-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Pulse answered ${res.status}`)
  return data
}

async function findProject(args) {
  if (args.project_id) return args.project_id
  const projects = await api('GET', '/api/projects')
  if (args.project_path) {
    const want = path.resolve(args.project_path).toLowerCase()
    const hit = projects.find(p => p.path.toLowerCase() === want)
    if (hit) return hit.id
    return (await api('POST', '/api/mcp/prepare-review', { projectPath: args.project_path })).projectId
  }
  if (args.project_name) {
    const hit = projects.find(p => p.name.toLowerCase() === String(args.project_name).toLowerCase())
    if (hit) return hit.id
    throw new Error(`No Pulse project named "${args.project_name}". Use pulse_list_projects, or pass project_path.`)
  }
  throw new Error('Pass project_id, project_path or project_name.')
}

const PROJECT_ARGS = {
  project_id: { type: 'string', description: 'Pulse project id (from pulse_list_projects).' },
  project_path: { type: 'string', description: 'Absolute folder path of the project, e.g. D:\\Code\\MyApp.' },
  project_name: { type: 'string', description: 'Project folder name, if Pulse already knows it.' },
}

const TOOLS = [
  {
    name: 'pulse_list_projects',
    description: 'List the projects Project Pulse tracks, with their ids, folders, last activity, and open suggestion counts.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const projects = await api('GET', '/api/projects')
      if (!projects.length) return 'Project Pulse has no projects yet. They appear after a Claude Code session changes files, or after pulse_start_review with a project_path.'
      return projects.map(p => `- ${p.name} (id ${p.id})\n  ${p.path}\n  last activity ${p.lastActivityAt || 'never'} · ${p.counts.reviews} reviews · ${p.counts.suggested} suggested · ${p.counts.planned} planned · ${p.counts.openDrawbacks} open concerns${p.live ? ' · Claude Code session open' : ''}`).join('\n')
    },
  },
  {
    name: 'pulse_project_history',
    description: "Read a project's Pulse memory: the latest review, open concerns (drawbacks), suggested and planned next steps, and recent reviews. Use it before suggesting work so you don't repeat what was done or declined.",
    inputSchema: { type: 'object', properties: PROJECT_ARGS },
    annotations: { readOnlyHint: true },
    run: async args => {
      const d = await api('GET', `/api/projects/${encodeURIComponent(await findProject(args))}`)
      const r = d.latestReview
      const out = [`# ${d.project.name}  (${d.project.path})`, `Automatic reviews: ${d.settings.effective.autoReviews ? 'on' : 'off'}`]
      if (r) {
        out.push(`\n## Latest review (${r.createdAt}, ${r.status}): ${r.title}`, ...r.built.map(b => `- built: ${b}`), ...r.benefits.map(b => `- benefit: ${b}`))
        if (r.statusReason) out.push(`- status evidence: ${r.statusReason}`)
      }
      const open = d.drawbacks.filter(x => x.status === 'open')
      out.push('\n## Open concerns', ...(open.length ? open.map(x => `- [${x.id}] ${x.text}`) : ['- none']))
      const recs = d.recommendations.filter(x => x.status === 'suggested' || x.status === 'planned')
      out.push('\n## Next steps', ...(recs.length ? recs.map(x => `- [${x.id}] (${x.status}, ${x.priority}) ${x.title}: ${x.why}`) : ['- none']))
      const closed = d.recommendations.filter(x => x.status === 'completed' || x.status === 'dismissed').slice(0, 10)
      if (closed.length) out.push('\n## Done or declined', ...closed.map(x => `- (${x.status}) ${x.title}`))
      out.push('\n## Recent reviews', ...d.reviews.slice(0, 8).map(x => `- ${x.createdAt.slice(0, 16)} ${x.status}: ${x.title}`))
      return out.join('\n')
    },
  },
  {
    name: 'pulse_start_review',
    description: 'Start a Project Pulse review of the development work discussed in this conversation (the manual review action). Returns the review rules and the project\'s open items; then write the review and call pulse_submit_review. Give project_path for a project Pulse has not seen yet.',
    inputSchema: { type: 'object', properties: PROJECT_ARGS },
    run: async args => {
      const body = args.project_id ? { projectId: args.project_id } : args.project_path ? { projectPath: args.project_path } : { projectName: args.project_name }
      const d = await api('POST', '/api/mcp/prepare-review', body)
      return `project_id: ${d.projectId}\n\n${d.instructions}`
    },
  },
  {
    name: 'pulse_submit_review',
    description: 'Save a Project Pulse review written after pulse_start_review. It appears in the Project Pulse window.',
    inputSchema: {
      type: 'object',
      required: ['project_id', 'review'],
      properties: {
        project_id: { type: 'string' },
        review: {
          type: 'object',
          description: 'One review object as pulse_start_review described: title, status, status_reason, built, benefits, drawbacks, evidence, recommendations, resolved_drawbacks, implemented_recommendations.',
        },
      },
    },
    run: async args => {
      const d = await api('POST', '/api/mcp/submit-review', { projectId: args.project_id, review: args.review })
      return `Saved the Pulse review "${d.title}" (id ${d.reviewId}). It is in the Project Pulse window.`
    },
  },
  {
    name: 'pulse_update_recommendation',
    description: 'Record the user\'s decision on a Pulse recommendation: plan (add to plan), unplan, dismiss, restore, or complete (only after the user confirms it is implemented and verified). Only call this when the user asks.',
    inputSchema: {
      type: 'object',
      required: ['recommendation_id', 'action'],
      properties: {
        recommendation_id: { type: 'string' },
        action: { type: 'string', enum: ['plan', 'unplan', 'dismiss', 'restore', 'complete'] },
        how: { type: 'string', enum: ['tested', 'tests-pass', 'reviewed'], description: 'For complete: how it was verified.' },
        note: { type: 'string' },
      },
    },
    run: async args => {
      const d = await api('POST', `/api/recommendations/${encodeURIComponent(args.recommendation_id)}/action`, { action: args.action, how: args.how, note: args.note })
      return `"${d.recommendation.title}" is now ${d.recommendation.status}.`
    },
  },
  {
    name: 'pulse_open_window',
    description: 'Open the Project Pulse window (optionally on one project).',
    inputSchema: { type: 'object', properties: PROJECT_ARGS },
    run: async args => {
      const projectId = args.project_id || args.project_path || args.project_name ? await findProject(args) : null
      await api('POST', '/api/window/open', { projectId })
      return 'Opened the Project Pulse window.'
    },
  },
]

// ---- JSON-RPC over stdio (newline-delimited)

const write = message => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

async function onMessage(msg) {
  const { id, method, params } = msg
  if (id === undefined || id === null) return // a notification
  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'project-pulse', version: VERSION },
        instructions: 'Project Pulse is a local development adviser. Use pulse_start_review then pulse_submit_review when the user asks for a Pulse review; use pulse_project_history before suggesting next steps.',
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') {
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) })
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name)
      if (!tool) return fail(id, -32602, `Unknown tool ${params?.name}`)
      try {
        const text = await tool.run(params.arguments || {})
        return reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `Project Pulse: ${err.message}` }], isError: true })
      }
    }
    if (method === 'resources/list') return reply(id, { resources: [] })
    if (method === 'prompts/list') return reply(id, { prompts: [] })
    return fail(id, -32601, `Method not found: ${method}`)
  } catch (err) {
    return fail(id, -32603, err.message)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return fail(null, -32700, 'Parse error')
  }
  for (const one of Array.isArray(msg) ? msg : [msg]) onMessage(one)
})
rl.on('close', () => process.exit(0))
