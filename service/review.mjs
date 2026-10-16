// Review prompts, parsing the model's reply, saving it with its links, and the CLI fallback generator.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onPath } from './config.mjs'
import { newId, now } from './db.mjs'
import { log } from './log.mjs'
import { isGitRepo } from './projects.mjs'
import { redact, redactDeep } from './redact.mjs'

const STATUSES = ['completed', 'partial', 'needs-testing', 'blocked', 'no-changes']
const PRIORITIES = ['high', 'medium', 'low']
const EFFORTS = ['small', 'medium', 'large']
const DETAIL = {
  brief: '"explore" is 1-2 sentences',
  standard: '"explore" is 2-4 sentences',
  detailed: '"explore" is 4-6 sentences with concrete steps',
}

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ---- prompt pieces shared by every way a review is written

export function openItems(store, projectId) {
  const drawbacks = store.drawbacks(projectId).filter(d => d.status === 'open').slice(0, 15)
  const recs = store.recs(projectId)
  return {
    drawbacks: drawbacks.map(d => ({ id: d.id, text: d.text })),
    open: recs.filter(r => r.status === 'suggested' || r.status === 'planned').slice(0, 15).map(r => ({ id: r.id, status: r.status, title: r.title })),
    closed: recs.filter(r => r.status === 'completed' || r.status === 'dismissed').slice(0, 30).map(r => `${r.title} (${r.status})`),
  }
}

const STATUS_LABELS = {
  completed: 'Completed', partial: 'Partially Completed', 'needs-testing': 'Needs Testing', blocked: 'Blocked', 'no-changes': 'No Meaningful Changes',
}
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '')

// The "Discuss in Claude" prompt for one recommendation. Read-only: used by both discuss and the preview.
export function buildDiscussPrompt(store, rec) {
  const project = store.project(rec.projectId)
  const review = rec.reviewId ? store.review(rec.reviewId) : null
  const concern = rec.addressesDrawbackId ? store.drawback(rec.addressesDrawbackId) : null
  const others = store.recs(rec.projectId).filter(r => r.id !== rec.id)
  const planned = others.filter(r => r.status === 'planned').map(r => r.title)
  const closed = others.filter(r => r.status === 'completed' || r.status === 'dismissed').slice(0, 5).map(r => r.title)

  const head = [`Project Pulse suggestion for ${project?.name || 'this project'}${project?.path ? ` (${project.path})` : ''}`]
  const meta = [`Suggestion: ${rec.title}`]
  const pe = [rec.priority && `Priority: ${cap(rec.priority)}`, rec.effort && `Estimated effort: ${cap(rec.effort)}`].filter(Boolean)
  if (pe.length) meta.push(pe.join(' · '))

  const ctx = []
  if (review?.title) {
    ctx.push(`- Last work reviewed: "${review.title}"`)
    const label = STATUS_LABELS[review.status]
    if (label) ctx.push(`  Status: ${label}${review.statusReason ? ` (${review.statusReason})` : ''}`)
  }
  if (concern?.text) {
    ctx.push(`- Concern this fixes: ${concern.text}`)
    if (concern.detail) ctx.push(`  (${concern.detail})`)
  }
  if (rec.connection) ctx.push(`- How it connects: ${rec.connection}`)
  if (rec.why) ctx.push(`- Why Pulse suggests it: ${rec.why}`)
  if (rec.benefit) ctx.push(`- Expected benefit: ${rec.benefit}`)
  if (rec.drawback) ctx.push(`- Possible downside: ${rec.drawback}`)
  if (planned.length) ctx.push(`- Already planned here (don't repeat): ${planned.join(', ')}`)
  if (closed.length) ctx.push(`- Already done or declined (don't suggest again): ${closed.join(', ')}`)

  const asks = [
    'Please do NOT edit any files yet. First:',
    '1. Read the relevant code and tell me if this concern is real here, naming the files and functions involved.',
    '2. Give me 2–3 ways to do it, each with effort, risk, and what could break.',
    '3. Recommend one, explained in plain words a non-coder could follow.',
    '4. Tell me how we will test it: what to run or click, and what "working" looks like.',
    '5. End with a short step-by-step plan, then wait for my go-ahead.',
  ]
  return [head, meta, ctx.length ? ['Context', ...ctx] : [], asks]
    .filter(block => block.length).map(block => block.join('\n')).join('\n\n')
}

function projectBlock(store, project, files) {
  const items = openItems(store, project.id)
  const lines = [`- project_id "${project.id}": "${project.name}" (${project.path})`]
  if (files?.length) lines.push(`  Files changed: ${files.slice(0, 25).map(f => path.relative(project.path, f) || f).join(', ')}`)
  lines.push(items.drawbacks.length
    ? `  Known open concerns (you may reference their ids):\n${items.drawbacks.map(d => `    - ${d.id}: ${d.text}`).join('\n')}`
    : '  Known open concerns: none')
  lines.push(items.open.length
    ? `  Suggestions already made (do not repeat; if this work did one, list it in implemented_recommendations):\n${items.open.map(r => `    - ${r.id} [${r.status}]: ${r.title}`).join('\n')}`
    : '  Suggestions already made: none')
  if (items.closed.length) lines.push(`  Already done or declined (never suggest again): ${items.closed.join('; ')}`)
  return lines.join('\n')
}

export function rules({ maxRecommendations, detail }) {
  return `Rules:
- Base every statement on evidence: files changed, commands run and their results, test or build output, what the user confirmed. Never claim something is finished or working without evidence.
- status: "completed" only when the task looks finished AND something shows it works (tests or a build passed, or the user confirmed). "needs-testing" when it looks finished but nothing verified it. "partial" when parts are left. "blocked" when an error or missing input stops progress. "no-changes" when nothing meaningful changed. Put the evidence for the status in "status_reason" (one short line).
- Write for someone grading this work who is not a programmer. Use everyday words and short sentences. No jargon; if a technical term can't be avoided, explain it in a few words. No code, no file contents, and never any keys, tokens, passwords or other secrets. Each bullet is 14 words or fewer.
- "title" says what changed for the user, like "AI now suggests a starting price for each card auction".
- "status_reason" is the "how we know": name the concrete evidence in plain words, like "Tests ran and passed", "No tests were run" or "You confirmed it works".
- built: 1-4 bullets. benefits: 1-3. drawbacks: 0-3 real risks or limits of THIS work, said as what could go wrong for a real user, not code internals.
- recommendations: at most ${maxRecommendations}, most useful first. Fix problems before proposing new features: prefer steps that address a drawback (a new one by its key like "d1", or a known open concern by its id). Unrelated features come last, if at all. Each must be practical and specific to this project. "connection" says in one sentence how the step links to the work or the concern it addresses. ${DETAIL[detail] || DETAIL.brief}. "simple" explains it in 1-2 sentences a 12-year-old could follow.
- If this work fixed a known open concern, list it in resolved_drawbacks. If it carried out an earlier suggestion, list it in implemented_recommendations with the evidence.
- Review each project separately and never mix their recommendations.`
}

export const REPLY_SHAPE = `{"reviews":[{"project_id":"...","title":"...","status":"completed|partial|needs-testing|blocked|no-changes","status_reason":"...","built":["..."],"benefits":["..."],"drawbacks":[{"key":"d1","text":"...","detail":"..."}],"evidence":["..."],"recommendations":[{"title":"...","why":"...","benefit":"...","drawback":"...","priority":"high|medium|low","effort":"small|medium|large","addresses":"d1 or an existing concern id or null","connection":"...","explore":"...","simple":"..."}],"resolved_drawbacks":[{"id":"...","note":"..."}],"implemented_recommendations":[{"id":"...","evidence":"..."}]}]}`

function settingsFor(store, projects) {
  const all = projects.map(p => store.effective(p.id))
  return {
    maxRecommendations: Math.min(...all.map(s => s.maxRecommendations)),
    detail: all[0]?.detail || 'brief',
  }
}

// For a live Claude Code session: the model already sees the whole conversation.
export function forkPrompt(store, { projects, rows }) {
  const requests = rows.filter(r => r.prompt).map(r => clip(r.prompt, 220))
  const filesBy = new Map(projects.map(p => [p.id, []]))
  const commands = []
  for (const row of rows) {
    if (filesBy.has(row.project_id)) filesBy.get(row.project_id).push(...row.files.map(f => f.path))
    for (const c of row.commands) commands.push(`${clip(c.cmd, 120)}${c.isError ? ' (failed)' : ''}`)
  }
  const lastAnswer = [...rows].reverse().find(r => r.answer)?.answer
  return `[Project Pulse review request]
Pause the coding task. Do not continue it, do not call any tools, do not write code. You are Project Pulse, a development adviser. Write a short review of the development work done in this conversation${rows.length ? ' in answer to these requests' : ''}:
${requests.length ? requests.map((r, i) => `${i + 1}. "${r}"`).join('\n') : '(the whole session)'}
${commands.length ? `Commands run: ${[...new Set(commands)].slice(-15).join(' | ')}\n` : ''}${lastAnswer ? `Your last reply ended with: "${clip(lastAnswer, 700)}"\n` : ''}
Projects to review:
${projects.map(p => projectBlock(store, p, [...new Set(filesBy.get(p.id))])).join('\n')}

${rules(settingsFor(store, projects))}

Reply with only this JSON, no other text and no code fence:
${REPLY_SHAPE}`
}

// For a review written outside the session: it only has the log Pulse kept, plus git facts.
export async function headlessPrompt(store, { project, rows, context }) {
  const log = []
  const all = [...rows, ...context].sort((a, b) => a.id - b.id).slice(-40)
  for (const [i, row] of all.entries()) {
    const parts = [`Turn ${i + 1}${row.reason && row.reason !== 'answer' ? ` (${row.reason})` : ''}:`]
    if (row.prompt) parts.push(`  User asked: "${clip(row.prompt, 300)}"`)
    if (row.files.length) parts.push(`  Files changed: ${row.files.map(f => path.relative(project.path, f.path) || f.path).slice(0, 20).join(', ')}`)
    if (row.commands.length) parts.push(`  Commands: ${row.commands.map(c => `${clip(c.cmd, 100)}${c.isError ? ' (failed)' : ' (ok)'}`).slice(0, 10).join(' | ')}`)
    if (row.answer) parts.push(`  Claude replied: "${clip(row.answer, 700)}"`)
    log.push(parts.join('\n'))
  }
  const git = await gitFacts(project.path)
  return `You are Project Pulse, a development adviser. You cannot see the code. Using only the session log and git facts below, write a short review of the development work.

Session log for "${project.name}":
${log.join('\n') || '(no turns recorded)'}
${git ? `\nGit facts:\n${git}\n` : ''}
Projects to review:
${projectBlock(store, project, [...new Set(rows.flatMap(r => r.files.map(f => f.path)))])}

${rules(settingsFor(store, [project]))}

Reply with only this JSON, no other text and no code fence:
${REPLY_SHAPE}`
}

// For Claude Desktop (MCP): the model writes the review and submits it as structured data.
export function desktopInstructions(store, project) {
  return `You are acting as Project Pulse, a development adviser, for the project "${project.name}" (${project.path}).
Review the development work discussed in this conversation. If something is unclear, ask the user rather than guess.

${projectBlock(store, project, [])}

${rules(settingsFor(store, [project]))}

Then call the tool pulse_submit_review with project_id "${project.id}" and "review" set to ONE object shaped like reviews[0] here:
${REPLY_SHAPE}`
}

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : stdout.trim()))
  })
}

export async function gitFacts(root) {
  if (!isGitRepo(root)) return ''
  const [status, stat, recent] = await Promise.all([
    git(root, ['status', '--porcelain']),
    git(root, ['diff', '--stat', 'HEAD']),
    git(root, ['log', '--oneline', '-5']),
  ])
  const out = []
  if (status) out.push(`Uncommitted files:\n${status.split('\n').slice(0, 30).join('\n')}`)
  if (stat) out.push(`Change size: ${stat.split('\n').at(-1).trim()}`)
  if (recent) out.push(`Recent commits:\n${recent}`)
  return redact(out.join('\n'))
}

// ---- reply parsing

export function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The reply had no JSON object')
  return JSON.parse(s.slice(start, end + 1))
}

const list = (v, max, n = 160) => (Array.isArray(v) ? v : []).map(x => clip(typeof x === 'string' ? x : x?.text ?? '', n)).filter(Boolean).slice(0, max)
const pick = (v, allowed, fallback) => (allowed.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : fallback)

export function normalizeReview(raw, maxRecommendations = 3) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const drawbacks = (Array.isArray(r.drawbacks) ? r.drawbacks : []).slice(0, 3).map((d, i) => ({
    key: clip(typeof d === 'object' ? d.key || `d${i + 1}` : `d${i + 1}`, 40),
    text: clip(typeof d === 'string' ? d : d?.text, 160),
    detail: clip(typeof d === 'object' ? d.detail : '', 500),
  })).filter(d => d.text)
  const recommendations = (Array.isArray(r.recommendations) ? r.recommendations : []).slice(0, maxRecommendations).map(x => ({
    title: clip(x?.title, 100),
    why: clip(x?.why, 220),
    benefit: clip(x?.benefit, 220),
    drawback: clip(x?.drawback, 220),
    priority: pick(x?.priority, PRIORITIES, 'medium'),
    effort: pick(x?.effort, EFFORTS, 'medium'),
    addresses: x?.addresses && x.addresses !== 'null' ? clip(x.addresses, 40) : null,
    connection: clip(x?.connection, 260),
    explore: clip(x?.explore, 1400),
    simple: clip(x?.simple, 400),
  })).filter(x => x.title)
  return redactDeep({
    projectId: typeof r.project_id === 'string' ? r.project_id : null,
    title: clip(r.title, 120) || 'Development session',
    status: pick(r.status, STATUSES, 'needs-testing'),
    statusReason: clip(r.status_reason, 200),
    built: list(r.built, 4),
    benefits: list(r.benefits, 3),
    drawbacks,
    evidence: list(r.evidence, 6, 200),
    recommendations,
    resolved: (Array.isArray(r.resolved_drawbacks) ? r.resolved_drawbacks : []).slice(0, 10).map(x => ({ id: String(x?.id || ''), note: clip(x?.note, 220) })),
    implemented: (Array.isArray(r.implemented_recommendations) ? r.implemented_recommendations : []).slice(0, 10).map(x => ({ id: String(x?.id || ''), evidence: clip(x?.evidence, 220) })),
  })
}

// ---- saving a review with its links

const STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'add', 'adding', 'allow', 'make', 'use', 'your', 'better'])
export function fingerprint(title) {
  return [...new Set(String(title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)))].sort().join(' ')
}

function similar(a, b) {
  const A = new Set(a.split(' '))
  const B = new Set(b.split(' '))
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / new Set([...A, ...B]).size >= 0.6
}

export function saveReview(store, { projectId, sessionId = null, source, trigger, review, model = null, dedupe = null }) {
  if (dedupe && store.reviewByDedupe(dedupe)) return null
  const id = newId('rv')
  store.tx(() => {
    store.insertReview({
      id, project_id: projectId, session_id: sessionId, source, trigger, created_at: now(), state: 'ready',
      status: review.status, status_reason: review.statusReason, title: review.title,
      built: JSON.stringify(review.built), benefits: JSON.stringify(review.benefits), evidence: JSON.stringify(review.evidence),
      resolved: '[]', implemented: '[]', error: null, model, dedupe,
    })
    const keyToId = new Map()
    for (const d of review.drawbacks) {
      const did = newId('d')
      keyToId.set(d.key, did)
      store.insertDrawback({ id: did, project_id: projectId, review_id: id, text: d.text, detail: d.detail })
      store.addLink(projectId, 'review', id, 'drawback', did, 'introduced')
    }
    const openDrawbacks = new Set(store.drawbacks(projectId).filter(d => d.status === 'open').map(d => d.id))
    const existing = store.recRows(projectId)
    for (const r of review.recommendations) {
      const fp = fingerprint(r.title)
      const twin = existing.find(e => e.fingerprint === fp || similar(e.fingerprint || '', fp))
      if (twin) {
        // Never suggest again what is done or declined; an open twin just gets linked to this review.
        if (twin.status === 'suggested' || twin.status === 'planned') store.addLink(projectId, 'review', id, 'recommendation', twin.id, 'suggested', 'suggested again')
        continue
      }
      const addresses = keyToId.get(r.addresses) || (openDrawbacks.has(r.addresses) ? r.addresses : null)
      const rid = newId('r')
      store.insertRec({
        id: rid, project_id: projectId, review_id: id, title: r.title, why: r.why, benefit: r.benefit, drawback: r.drawback,
        priority: r.priority, effort: r.effort, explore: r.explore, simple: r.simple, connection: r.connection,
        addresses_drawback_id: addresses, fingerprint: fp,
      })
      existing.push({ id: rid, title: r.title, status: 'suggested', fingerprint: fp })
      store.addLink(projectId, 'review', id, 'recommendation', rid, 'suggested')
      if (addresses) store.addLink(projectId, 'recommendation', rid, 'drawback', addresses, 'addresses', r.connection)
    }
    const resolved = []
    for (const x of review.resolved) {
      const d = store.drawback(x.id)
      if (!d || d.projectId !== projectId || d.status === 'resolved') continue
      store.setDrawback(x.id, { status: 'resolved', resolved_by_review_id: id, resolved_note: x.note })
      store.addLink(projectId, 'review', id, 'drawback', x.id, 'resolved', x.note)
      resolved.push({ drawbackId: x.id, note: x.note })
    }
    const implemented = []
    for (const x of review.implemented) {
      const r = store.rec(x.id)
      if (!r || r.projectId !== projectId || r.status === 'completed') continue
      store.setRec(x.id, { status: 'completed', completed_how: 'detected', completed_evidence: x.evidence })
      store.addLink(projectId, 'review', id, 'recommendation', x.id, 'implemented', x.evidence)
      store.addDecision(projectId, { recommendationId: x.id, action: 'completed (detected)', note: x.evidence })
      implemented.push({ recommendationId: x.id, evidence: x.evidence })
      // The concern that suggestion addressed counts as resolved too.
      if (r.addressesDrawbackId && store.drawback(r.addressesDrawbackId)?.status === 'open') {
        store.setDrawback(r.addressesDrawbackId, { status: 'resolved', resolved_by_review_id: id, resolved_note: `Fixed by: ${r.title}` })
        store.addLink(projectId, 'review', id, 'drawback', r.addressesDrawbackId, 'resolved', `Fixed by: ${r.title}`)
        resolved.push({ drawbackId: r.addressesDrawbackId, note: `Fixed by: ${r.title}` })
      }
    }
    store.q('update reviews set resolved = ?, implemented = ? where id = ?').run(JSON.stringify(resolved), JSON.stringify(implemented), id)
    store.touchProject(projectId, 'last_review_at')
  })
  return id
}

export function saveFailedReview(store, { projectId, sessionId = null, source, trigger, error }) {
  const id = newId('rv')
  store.insertReview({
    id, project_id: projectId, session_id: sessionId, source, trigger, created_at: now(), state: 'failed', status: 'needs-testing',
    status_reason: '', title: 'Review could not be written', built: '[]', benefits: '[]', evidence: '[]', resolved: '[]',
    implemented: '[]', error: clip(redact(error), 400), model: null, dedupe: null,
  })
  return id
}

// ---- the Claude Code CLI as a generator (works when `claude` is signed in on this PC)

export function findClaude() {
  const home = os.homedir()
  const installed = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')]
    // A service started at login may not have the shell's PATH, so the usual places come first.
    : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', onPath('claude')]
  return [process.env.PROJECT_PULSE_CLAUDE, ...installed].filter(Boolean).find(c => fs.existsSync(c)) || null
}

export function runCli(prompt, { model = 'sonnet', cwd, timeoutMs = 240_000 } = {}) {
  const exe = findClaude()
  if (!exe) return Promise.reject(new Error('Claude Code CLI not found'))
  return new Promise((resolve, reject) => {
    const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--model', model]
    // A clean environment: the user's own CLI sign-in, never a host session's proxy or nesting markers.
    const env = { ...process.env, PROJECT_PULSE_DISABLE: '1' }
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_(?!API_KEY$)|CLAUDE_CODE_|CLAUDECODE$)/.test(k)) delete env[k]
    const child = spawn(exe, args, { cwd, windowsHide: true, shell: exe.endsWith('.cmd'), env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The review timed out'))
    }, timeoutMs)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(out)
        if (result.is_error) return reject(new Error(String(result.result || 'Claude returned an error')))
        resolve({ text: String(result.result || ''), model })
      } catch {
        reject(new Error(`Claude CLI exited ${code}: ${clip(err || out, 300)}`))
      }
    })
    child.stdin.end(prompt)
  })
}

export function isAuthError(error) {
  return /authenticat|oauth|log ?in|credential|401/i.test(String(error?.message || error))
}

export { clip }
export function logReviewError(where, err) {
  log.warn(`${where}: ${err?.message || err}`)
}
