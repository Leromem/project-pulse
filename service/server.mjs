// Project Pulse service: a local HTTP + SSE server on 127.0.0.1 that receives completion events,
// prepares reviews, keeps project memory in SQLite and drives the Pulse window.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DATA_DIR, DB_FILE, LOG_DIR, PORT, UI_DIR, VERSION, ensureDirs, loadToken, writeServiceFile } from './config.mjs'
import { DEFAULT_SETTINGS, OVERRIDABLE, Store, newId, now } from './db.mjs'
import { LOG_FILE, log, tail } from './log.mjs'
import { cwdProject, isGitRepo, projectId, projectName, rootFor } from './projects.mjs'
import { redact } from './redact.mjs'
import * as R from './review.mjs'
import * as W from './window.mjs'

const LIVE_MS = 45_000
const LOST_MS = 10 * 60_000
const MAX_BODY = 1024 * 1024
const MUTATING = [
  /\bgit\s+(commit|merge|rebase|pull|cherry-pick|revert|reset|apply|am|mv|rm|checkout\s+-b|switch\s+-c|stash\s+pop)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|uninstall|update|up|upgrade)\b/i,
  /\b(pip|pip3|uv|poetry|cargo|go|dotnet|composer)\s+(install|add|remove|get|new|update|init)\b/i,
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|rmdir|unlink|ln)\s/i,
  /\bsed\s+-i\b/i,
  /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
  /[^>&0-9]>{1,2}\s*[^\s&>]/,
]
const isMutating = cmd => MUTATING.some(re => re.test(cmd))
const clip = (s, n) => R.clip(s, n)

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const bad = message => new HttpError(400, message)
const str = (v, name, max = 4000, optional = false) => {
  if (v === undefined || v === null || v === '') {
    if (optional) return ''
    throw bad(`${name} is required`)
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`)
  return v.slice(0, max)
}

export function createPulse({
  store,
  token,
  port = PORT,
  launch = W.launchWindow,
  notify = W.notify,
  waitForIdle = W.waitForIdle,
  runCli = R.runCli,
  openFolder = W.openFolder,
  windowWaitMs = 20_000,
} = {}) {
  const clients = new Set()
  const live = new Map() // sessionId -> { cwd, lastSeen, source, canGenerate }
  let windowState = { visible: false, focused: false, projectId: null, at: 0 }
  let opening = false
  let closed = false
  let jobRun = null
  let actualPort = port

  // ---------- helpers

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(frame)
  }

  const projectView = row => {
    const job = store.activeJob(row.id)
    return {
      id: row.id, name: row.name, path: row.path, createdAt: row.created_at,
      lastActivityAt: row.last_activity_at || null, lastReviewAt: row.last_review_at || null,
      counts: store.counts(row.id), live: !!liveFor(row.id), job: job ? jobView(job) : null,
      autoReviews: store.effective(row.id).autoReviews,
    }
  }

  const jobView = j => ({ id: j.id, state: j.state === 'waiting' ? 'queued' : j.state, trigger: j.trigger, startedAt: j.started_at || null, error: j.error || null })

  const ensureProject = root => {
    const id = projectId(root)
    store.upsertProject(id, root, projectName(root))
    return id
  }

  const mustProject = id => {
    const p = store.project(id)
    if (!p) throw new HttpError(404, 'Unknown project')
    return p
  }

  function liveFor(pid) {
    const project = store.project(pid)
    let best = null
    for (const [id, s] of live) {
      if (Date.now() - s.lastSeen > LIVE_MS) continue
      const works = store.sessionProjects(id).includes(pid) ||
        (project && s.cwd && cwdProject(s.cwd, store.globalSettings())?.toLowerCase() === project.path.toLowerCase())
      if (works && (!best || s.lastSeen > best.lastSeen)) best = { id, ...s }
    }
    return best
  }

  const anyGenerator = () => {
    let best = null
    for (const [id, s] of live) {
      if (s.canGenerate && Date.now() - s.lastSeen <= LIVE_MS && (!best || s.lastSeen > best.lastSeen)) best = { id, ...s }
    }
    return best
  }

  // ---------- after a review lands

  async function afterReview(pid, reviewId, title) {
    const project = store.project(pid)
    broadcast('review', { projectId: pid, reviewId, title })
    broadcast('project', { projectId: pid })
    const eff = store.effective(pid)
    const seen = clients.size > 0 && windowState.visible && windowState.focused
    if (eff.notifications && !seen) notify(`Project Pulse · ${project?.name || 'review'}`, title)
    if (eff.autoOpenWindow && clients.size === 0) openWindow(pid, { explicit: false }).catch(err => log.warn('Auto-open failed', err))
  }

  async function openWindow(pid, { explicit }) {
    if (clients.size > 0) {
      if (explicit && pid) broadcast('focus', { projectId: pid })
      return 'already-open'
    }
    if (opening) return 'opening'
    opening = true
    try {
      if (!explicit && !store.globalSettings().openWhileTyping) {
        const idle = await waitForIdle(4000, 15 * 60_000)
        if (closed) return 'closed'
        if (!idle) {
          log.info('Did not open the window: you kept typing for 15 minutes')
          return 'gave-up'
        }
      }
      if (clients.size > 0) return 'already-open'
      const url = `http://127.0.0.1:${actualPort}/?t=${token}${pid ? `&project=${encodeURIComponent(pid)}` : ''}`
      launch(url, store.meta('windowBounds'))
      for (let waited = 0; waited < windowWaitMs && clients.size === 0; waited += 250) await new Promise(r => setTimeout(r, 250))
      return clients.size > 0 ? 'opened' : 'launched'
    } finally {
      opening = false
    }
  }

  // ---------- jobs: reviews written outside the live fork

  function queueHeadless(pid, { sessionId = null, trigger, source }) {
    const active = store.activeJob(pid)
    if (active) return active.id
    const id = newId('j')
    store.insertJob({ id, project_id: pid, session_id: sessionId, trigger, source, kind: 'headless', state: 'queued' })
    broadcast('job', { projectId: pid, state: 'queued' })
    setImmediate(processJobs)
    return id
  }

  function failJob(job, error) {
    store.updateJob(job.id, { state: 'failed', finished_at: now(), error: clip(redact(String(error)), 400) })
    const reviewId = R.saveFailedReview(store, { projectId: job.project_id, sessionId: job.session_id, source: job.source, trigger: job.trigger, error: String(error) })
    broadcast('job', { projectId: job.project_id, state: 'failed', error: clip(String(error), 200) })
    broadcast('project', { projectId: job.project_id })
    log.warn(`Review failed for ${job.project_id}: ${error}`)
    return reviewId
  }

  async function evidenceFor(job) {
    const project = store.project(job.project_id)
    let rows = store.unreviewed({ projectId: job.project_id })
    if (!rows.length && (job.trigger === 'manual' || job.trigger === 'retry')) rows = store.recentActivity(job.project_id, 30)
    if (!rows.length && !(job.trigger === 'manual' || job.trigger === 'retry')) return null
    if (!rows.length && !isGitRepo(project.path)) return null
    const context = store.contextActivity([...new Set(rows.map(r => r.session_id))])
    const prompt = await R.headlessPrompt(store, { project, rows, context })
    return { prompt, rowIds: rows.filter(r => !r.reviewed).map(r => r.id) }
  }

  function finishJob(job, text, rowIds, model) {
    let parsed
    try {
      parsed = R.extractJson(text)
    } catch (err) {
      throw new Error(`The review reply was not readable (${err.message})`)
    }
    const list = Array.isArray(parsed.reviews) ? parsed.reviews : [parsed]
    const raw = list.find(x => x?.project_id === job.project_id) || list[0]
    const review = R.normalizeReview(raw, store.effective(job.project_id).maxRecommendations)
    const reviewId = R.saveReview(store, {
      projectId: job.project_id, sessionId: job.session_id, source: job.source, trigger: job.trigger, review, model, dedupe: `job:${job.id}`,
    })
    if (reviewId) store.markReviewed(rowIds, reviewId)
    store.updateJob(job.id, { state: 'done', finished_at: now(), error: null })
    broadcast('job', { projectId: job.project_id, state: 'done' })
    if (reviewId) afterReview(job.project_id, reviewId, review.title)
    log.info(`Review ${reviewId} saved for ${job.project_id} (${job.trigger}, ${job.kind})`)
    return reviewId
  }

  // One run at a time; callers may await the run in progress.
  function processJobs() {
    if (closed) return Promise.resolve()
    if (!jobRun) {
      jobRun = runJobs()
        .catch(err => {
          if (!closed) log.error('Job runner failed', err)
        })
        .finally(() => {
          jobRun = null
        })
    }
    return jobRun
  }

  async function runJobs() {
    for (;;) {
      if (closed) return
      const job = store.q(`select * from jobs where kind = 'headless' and state in ('queued', 'waiting') order by created_at`).all()
        .find(j => j.state === 'queued' || anyGenerator())
      if (!job) return
      {
        const evidence = await evidenceFor(job).catch(err => (log.error('Evidence failed', err), null))
        if (closed) return
        if (!evidence) {
          store.updateJob(job.id, { state: 'done', finished_at: now(), error: 'Nothing new to review' })
          broadcast('job', { projectId: job.project_id, state: 'done' })
          continue
        }
        const payload = JSON.stringify({ rowIds: evidence.rowIds })
        const model = store.globalSettings().reviewModel
        const generator = anyGenerator()
        if (generator) {
          // A live Claude Code session writes it with its own sign-in ($.model.complete).
          store.updateJob(job.id, { state: 'running', started_at: now(), attempts: job.attempts + 1, payload })
          store.addAction(generator.id, job.project_id, 'generate', { jobId: job.id, prompt: evidence.prompt, model })
          broadcast('job', { projectId: job.project_id, state: 'running' })
          continue
        }
        store.updateJob(job.id, { state: 'running', started_at: now(), attempts: job.attempts + 1, payload })
        broadcast('job', { projectId: job.project_id, state: 'running' })
        try {
          const out = await runCli(evidence.prompt, { model, cwd: DATA_DIR })
          if (closed) return
          finishJob({ ...job, attempts: job.attempts + 1 }, out.text, evidence.rowIds, out.model)
        } catch (err) {
          if (closed) return
          if (R.isAuthError(err) || /not found|ENOENT/i.test(err.message)) {
            store.updateJob(job.id, { state: 'waiting', error: 'Waiting for an open Claude Code session to write this review' })
            broadcast('job', { projectId: job.project_id, state: 'queued' })
            log.info(`Review for ${job.project_id} waits for a Claude Code session (${err.message})`)
          } else if (job.attempts + 1 < 2) {
            store.updateJob(job.id, { state: 'queued', error: clip(err.message, 300) })
            R.logReviewError('CLI review', err)
          } else {
            failJob(job, err.message)
          }
        }
      }
    }
  }

  // ---------- routes

  const routes = []
  const route = (method, pattern, handler, { open = false, queryToken = false } = {}) =>
    routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, open, queryToken })

  route('GET', '/api/health', () => ({ ok: true, app: 'project-pulse', version: VERSION, port: actualPort }), { open: true })

  route('GET', '/api/projects', () => store.projects().map(projectView))

  route('GET', '/api/projects/:id', ({ id }) => {
    const p = mustProject(id)
    const latest = store.latestReviewId(id)
    return {
      project: projectView(p),
      settings: { effective: store.effective(id), overrides: store.overrides(id) },
      latestReview: latest ? store.review(latest) : null,
      reviews: store.reviewSummaries(id),
      recommendations: store.recs(id),
      drawbacks: store.drawbacks(id),
      links: store.links(id),
      decisions: store.decisions(id),
    }
  })

  route('DELETE', '/api/projects/:id', ({ id }) => {
    mustProject(id)
    store.deleteProject(id)
    log.info(`Forgot project ${id}`)
    broadcast('project', { projectId: id })
    return { ok: true }
  })

  route('GET', '/api/reviews/:id', ({ id }) => store.review(id) || (() => { throw new HttpError(404, 'Unknown review') })())

  route('POST', '/api/projects/:id/review', ({ id }) => {
    const p = mustProject(id)
    if (store.activeJob(id)) return { mode: 'none', message: 'A review is already being written for this project.' }
    const session = liveFor(id)
    if (session) {
      store.addAction(session.id, id, 'review', {})
      return { mode: 'live-session', message: `Asked your open Claude Code session to review ${p.name}.` }
    }
    if (!store.recentActivity(id, 1).length && !isGitRepo(p.path)) {
      return { mode: 'none', message: `Pulse hasn't seen any work on ${p.name} yet. Run /pulse in a Claude Code session there.` }
    }
    queueHeadless(id, { trigger: 'manual', source: 'pulse-window' })
    return { mode: 'headless', message: `Writing a review of ${p.name} from what Pulse recorded.` }
  })

  route('POST', '/api/reviews/:id/retry', ({ id }) => {
    const r = store.reviewRow(id)
    if (!r) throw new HttpError(404, 'Unknown review')
    if (store.activeJob(r.project_id)) return { mode: 'none', message: 'A review is already being written.' }
    const session = liveFor(r.project_id)
    if (session) {
      store.addAction(session.id, r.project_id, 'review', {})
      return { mode: 'live-session', message: 'Asked your open Claude Code session to try again.' }
    }
    queueHeadless(r.project_id, { sessionId: r.session_id, trigger: 'retry', source: r.source || 'pulse-window' })
    return { mode: 'headless', message: 'Trying the review again.' }
  })

  route('POST', '/api/recommendations/:id/action', ({ id }, body) => {
    const rec = store.rec(id)
    if (!rec) throw new HttpError(404, 'Unknown recommendation')
    const action = str(body.action, 'action', 20)
    const note = str(body.note, 'note', 400, true)
    const how = ['tested', 'tests-pass', 'reviewed'].includes(body.how) ? body.how : 'tested'
    const next = {
      plan: { status: 'planned' },
      unplan: { status: 'suggested' },
      dismiss: { status: 'dismissed' },
      restore: { status: 'suggested' },
      complete: { status: 'completed', completed_how: how, completed_evidence: note || { tested: 'You tested it', 'tests-pass': 'Tests pass', reviewed: 'Reviewed in Claude' }[how] },
    }[action]
    if (!next) throw bad('Unknown action')
    let updated
    store.tx(() => {
      updated = store.setRec(id, next)
      store.addDecision(rec.projectId, { recommendationId: id, action, note: action === 'complete' ? `${how}${note ? `: ${note}` : ''}` : note })
      if (action === 'complete' && rec.addressesDrawbackId && store.drawback(rec.addressesDrawbackId)?.status === 'open') {
        store.setDrawback(rec.addressesDrawbackId, { status: 'resolved', resolved_note: `Fixed by: ${rec.title}` })
        store.addLink(rec.projectId, 'recommendation', id, 'drawback', rec.addressesDrawbackId, 'resolved', `Fixed by: ${rec.title}`)
      }
    })
    broadcast('project', { projectId: rec.projectId })
    return { recommendation: updated }
  })

  // Preview only: no decision logged, nothing queued.
  route('GET', '/api/recommendations/:id/prompt', ({ id }) => {
    const rec = store.rec(id)
    if (!rec) throw new HttpError(404, 'Unknown recommendation')
    return { prompt: R.buildDiscussPrompt(store, rec) }
  })

  route('POST', '/api/recommendations/:id/discuss', ({ id }) => {
    const rec = store.rec(id)
    if (!rec) throw new HttpError(404, 'Unknown recommendation')
    const prompt = R.buildDiscussPrompt(store, rec)
    store.addDecision(rec.projectId, { recommendationId: id, action: 'discussed' })
    const session = liveFor(rec.projectId)
    if (session) {
      store.addAction(session.id, rec.projectId, 'discuss', { prompt })
      return { mode: 'sent-to-claude-code', prompt, message: 'Added to your Claude Code prompt box. Review it and press Enter to send.' }
    }
    return { mode: 'copy', prompt, message: 'No open Claude Code session for this project, so copy the prompt instead.' }
  })

  route('POST', '/api/drawbacks/:id/action', ({ id }, body) => {
    const d = store.drawback(id)
    if (!d) throw new HttpError(404, 'Unknown drawback')
    const action = str(body.action, 'action', 20)
    const note = str(body.note, 'note', 400, true)
    const fields = { accept: { status: 'accepted' }, reopen: { status: 'open', resolved_note: null, resolved_by_review_id: null }, resolve: { status: 'resolved', resolved_note: note || 'Marked resolved by you' } }[action]
    if (!fields) throw bad('Unknown action')
    const updated = store.setDrawback(id, fields)
    store.addDecision(d.projectId, { drawbackId: id, action, note })
    broadcast('project', { projectId: d.projectId })
    return { drawback: updated }
  })

  route('GET', '/api/settings', () => ({ global: store.globalSettings(), defaults: DEFAULT_SETTINGS }))

  route('PUT', '/api/settings', (_, body) => {
    for (const [key, value] of Object.entries(body || {})) {
      if (!(key in DEFAULT_SETTINGS)) continue
      store.setGlobal(key, validSetting(key, value))
    }
    broadcast('settings', {})
    return { global: store.globalSettings() }
  })

  route('PUT', '/api/projects/:id/settings', ({ id }, body) => {
    mustProject(id)
    const overrides = { ...store.overrides(id) }
    for (const [key, value] of Object.entries(body?.overrides || {})) {
      if (!OVERRIDABLE.includes(key)) continue
      if (value === null) delete overrides[key]
      else overrides[key] = validSetting(key, value)
    }
    store.setOverrides(id, overrides)
    broadcast('settings', {})
    broadcast('project', { projectId: id })
    return { effective: store.effective(id), overrides }
  })

  route('POST', '/api/window/state', (_, body) => {
    windowState = { visible: !!body.visible, focused: !!body.focused, projectId: typeof body.projectId === 'string' ? body.projectId : null, at: Date.now() }
    const b = body.bounds
    if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w >= 320 && b.h >= 360 && b.w < 10000 && b.h < 10000) {
      store.meta('windowBounds', { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })
    }
    return { ok: true }
  }, { queryToken: true })

  route('POST', '/api/window/open', async (_, body) => {
    let pid = typeof body.projectId === 'string' ? body.projectId : null
    if (!pid && typeof body.cwd === 'string') {
      const root = cwdProject(body.cwd, store.globalSettings())
      if (root) pid = ensureProject(root)
    }
    const result = await openWindow(pid, { explicit: true })
    return { ok: true, result, projectId: pid }
  })

  route('GET', '/api/diagnostics', () => ({
    version: VERSION, port: actualPort, dataDir: DATA_DIR, logFile: LOG_FILE, logTail: tail(120),
    jobs: store.jobs(12).map(j => ({ ...jobView(j), projectId: j.project_id, kind: j.kind, createdAt: j.created_at, finishedAt: j.finished_at })),
  }))

  route('POST', '/api/diagnostics/open-log', () => {
    openFolder(LOG_DIR)
    return { ok: true }
  })

  // ---------- from the Claude Code mod

  route('POST', '/api/hook/activity', (_, body) => {
    const sessionId = str(body.sessionId, 'sessionId', 120)
    const cwd = str(body.cwd, 'cwd', 1000)
    const seq = Number.isInteger(body.seq) ? body.seq : 0
    const reason = str(body.reason, 'reason', 20, true) || 'answer'
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 300).filter(f => typeof f?.path === 'string').map(f => ({ path: f.path.slice(0, 1000), op: String(f.op || 'edit').slice(0, 20) }))
    const commands = (Array.isArray(body.commands) ? body.commands : []).slice(0, 100).filter(c => typeof c?.cmd === 'string').map(c => ({ cmd: redact(c.cmd.slice(0, 300)), isError: !!c.isError }))
    const settings = store.globalSettings()
    store.upsertSession(sessionId, 'claude-code', cwd)
    live.set(sessionId, { ...(live.get(sessionId) || {}), cwd, lastSeen: Date.now(), source: 'claude-code' })

    const groups = new Map()
    for (const f of files) {
      const root = rootFor(f.path, cwd, settings)
      if (!root) continue
      const k = root.toLowerCase()
      if (!groups.has(k)) groups.set(k, { root, files: [] })
      groups.get(k).files.push({ path: path.resolve(cwd, f.path), op: f.op })
    }
    const mutating = commands.filter(c => !c.isError && isMutating(c.cmd)).length
    const completion = commands.some(c => !c.isError && /\bgit\s+commit\b/i.test(c.cmd)) ? 1 : 0
    if (!groups.size) {
      const root = cwdProject(cwd, settings)
      groups.set(root ? root.toLowerCase() : '', { root, files: [] })
    }
    const touched = []
    for (const { root, files: groupFiles } of groups.values()) {
      const pid = root ? ensureProject(root) : ''
      store.addActivity({
        session_id: sessionId, project_id: pid, seq, prompt: redact(clip(body.prompt || '', 2000)), answer: redact(clip(body.answer || '', 4000)),
        reason, files: JSON.stringify(groupFiles), commands: JSON.stringify(commands), edits: groupFiles.length,
        mutating: pid ? mutating : 0, completion,
      })
      if (pid) {
        store.touchProject(pid)
        touched.push(pid)
        broadcast('project', { projectId: pid })
      }
    }
    const pending = [...new Set(store.unreviewed({ sessionId }).map(r => r.project_id))].filter(pid => store.effective(pid).autoReviews)
    const settleMs = (completion ? Math.min(20, settings.settleSeconds) : settings.settleSeconds) * 1000
    return {
      meaningful: touched.some(pid => store.unreviewed({ sessionId, projectId: pid }).some(r => r.seq === seq)),
      schedule: reason === 'answer' && pending.length > 0,
      settleMs,
      projects: touched,
    }
  })

  route('POST', '/api/hook/heartbeat', (_, body) => {
    const sessionId = str(body.sessionId, 'sessionId', 120)
    const cwd = str(body.cwd, 'cwd', 1000, true)
    store.upsertSession(sessionId, 'claude-code', cwd || null)
    const wasLive = live.has(sessionId)
    live.set(sessionId, { cwd, lastSeen: Date.now(), source: 'claude-code', canGenerate: body.canGenerate !== false })
    if (!wasLive) for (const pid of store.sessionProjects(sessionId)) broadcast('project', { projectId: pid })
    const waiting = store.q(`select count(*) n from jobs where kind = 'headless' and state in ('queued', 'waiting')`).get().n
    if (waiting) setImmediate(processJobs)
    return { actions: store.takeActions(sessionId) }
  })

  route('POST', '/api/hook/session-end', (_, body) => {
    const sessionId = str(body.sessionId, 'sessionId', 120)
    const reason = str(body.reason, 'reason', 40, true) || 'other'
    store.endSession(sessionId, reason)
    live.delete(sessionId)
    let queued = 0
    for (const pid of new Set(store.unreviewed({ sessionId }).map(r => r.project_id))) {
      if (!store.effective(pid).autoReviews || store.activeJob(pid)) continue
      queueHeadless(pid, { sessionId, trigger: 'session-end', source: 'claude-code' })
      queued++
    }
    log.info(`Session ${sessionId.slice(0, 8)} ended (${reason}); ${queued} review(s) queued`)
    return { queued: queued > 0, count: queued }
  })

  // /pulse status | on | off | on all | off all
  route('POST', '/api/hook/control', (_, body) => {
    const sessionId = str(body.sessionId, 'sessionId', 120)
    const cwd = str(body.cwd, 'cwd', 1000, true)
    const command = str(body.command, 'command', 20)
    if (command === 'on all' || command === 'off all') {
      store.setGlobal('autoReviews', command === 'on all')
      broadcast('settings', {})
      return { text: `Automatic Pulse reviews are now ${command === 'on all' ? 'ON' : 'OFF'} for all projects (projects with their own setting keep it).` }
    }
    let pids = store.sessionProjects(sessionId)
    if (!pids.length && cwd) {
      const root = cwdProject(cwd, store.globalSettings())
      if (root) pids = [ensureProject(root)]
    }
    if (!pids.length) return { text: 'This session has no project yet (it runs in a folder of several projects). Use "/pulse on all" or "/pulse off all", or the Pulse window settings.' }
    const lines = []
    for (const pid of pids) {
      const p = store.project(pid)
      if (command === 'on' || command === 'off') {
        store.setOverrides(pid, { ...store.overrides(pid), autoReviews: command === 'on' })
        broadcast('project', { projectId: pid })
        lines.push(`Automatic reviews for ${p.name}: ${command.toUpperCase()}`)
        continue
      }
      const eff = store.effective(pid)
      const c = store.counts(pid)
      const last = store.reviewSummaries(pid, 1)[0]
      lines.push(`${p.name}: automatic reviews ${eff.autoReviews ? 'ON' : 'OFF'}; ${c.reviews} review(s)${last ? `, latest "${last.title}"` : ''}; ${c.suggested} suggestion(s), ${c.planned} planned, ${c.openDrawbacks} open concern(s).`)
    }
    if (command === 'on' || command === 'off') broadcast('settings', {})
    return { text: lines.join('\n') }
  })

  route('POST', '/api/hook/review-context', (_, body) => {
    const sessionId = str(body.sessionId, 'sessionId', 120)
    const force = !!body.force
    const only = typeof body.projectId === 'string' ? body.projectId : null
    const trigger = body.trigger === 'manual' ? 'manual' : 'task-complete'
    let rows = store.unreviewed({ sessionId }).filter(r => !only || r.project_id === only)
    if (!force) rows = rows.filter(r => store.effective(r.project_id).autoReviews)
    let pids = [...new Set(rows.map(r => r.project_id))]
    if (!pids.length && force) {
      pids = only ? [only] : store.sessionProjects(sessionId)
      if (!pids.length) {
        const session = store.session(sessionId)
        const root = session?.cwd ? cwdProject(session.cwd, store.globalSettings()) : null
        if (root) pids = [ensureProject(root)]
      }
    }
    if (!pids.length) {
      return { nothing: true, message: force ? 'No project found for this session yet. Change a file in a project, or start Claude Code inside the project folder.' : 'No code changes since the last review.' }
    }
    const busy = pids.filter(pid => store.activeJob(pid))
    pids = pids.filter(pid => !busy.includes(pid))
    if (!pids.length) return { nothing: true, message: 'A review is already being written.' }
    const projects = pids.map(pid => store.project(pid)).filter(Boolean)
    const turnRows = store.sessionActivity(sessionId).filter(r => !r.reviewed && (pids.includes(r.project_id) || r.project_id === ''))
    const prompt = R.forkPrompt(store, { projects, rows: turnRows })
    const jobIds = projects.map(p => {
      const id = newId('j')
      const rowIds = turnRows.filter(r => r.project_id === p.id || r.project_id === '').map(r => r.id)
      store.insertJob({ id, project_id: p.id, session_id: sessionId, trigger, source: 'claude-code', kind: 'live', state: 'running', started_at: now(), payload: JSON.stringify({ rowIds }) })
      broadcast('job', { projectId: p.id, state: 'running' })
      return id
    })
    return { prompt, projectIds: projects.map(p => p.id), jobIds }
  })

  route('POST', '/api/hook/review', (_, body) => {
    const jobIds = (Array.isArray(body.jobIds) ? body.jobIds : []).filter(x => typeof x === 'string')
    const text = str(body.text, 'text', 200_000)
    const model = str(body.model, 'model', 80, true) || null
    const jobs = jobIds.map(id => store.job(id)).filter(j => j && j.state === 'running')
    let list = []
    try {
      const parsed = R.extractJson(text)
      list = Array.isArray(parsed.reviews) ? parsed.reviews : [parsed]
    } catch (err) {
      log.warn(`Live review reply unreadable: ${err.message}`)
    }
    const saved = []
    for (const job of jobs) {
      const raw = list.find(x => x?.project_id === job.project_id) || (jobs.length === 1 ? list[0] : null)
      if (!raw) {
        toHeadless(job, 'The live review reply did not cover this project')
        continue
      }
      const review = R.normalizeReview(raw, store.effective(job.project_id).maxRecommendations)
      const rowIds = JSON.parse(job.payload || '{}').rowIds || []
      const reviewId = R.saveReview(store, { projectId: job.project_id, sessionId: job.session_id, source: 'claude-code', trigger: job.trigger, review, model, dedupe: `job:${job.id}` })
      if (reviewId) store.markReviewed(rowIds, reviewId)
      store.updateJob(job.id, { state: 'done', finished_at: now() })
      broadcast('job', { projectId: job.project_id, state: 'done' })
      if (reviewId) {
        saved.push({ id: reviewId, projectId: job.project_id, title: review.title })
        afterReview(job.project_id, reviewId, review.title)
      }
    }
    return { reviews: saved }
  })

  function toHeadless(job, why) {
    store.updateJob(job.id, { kind: 'headless', state: 'queued', error: clip(why, 300) })
    log.info(`Job ${job.id} falls back to a log-based review: ${why}`)
    setImmediate(processJobs)
  }

  route('POST', '/api/hook/review-failed', (_, body) => {
    const reason = str(body.reason, 'reason', 300, true) || 'unknown'
    const jobs = (Array.isArray(body.jobIds) ? body.jobIds : []).map(id => store.job(id)).filter(j => j && j.state === 'running')
    for (const job of jobs) toHeadless(job, `Live review failed: ${reason}`)
    return { queued: jobs.length > 0 }
  })

  route('POST', '/api/hook/generated', (_, body) => {
    const job = store.job(str(body.jobId, 'jobId', 60))
    if (!job || job.state !== 'running') return { ok: false }
    const rowIds = JSON.parse(job.payload || '{}').rowIds || []
    if (typeof body.text === 'string' && body.text) {
      try {
        const reviewId = finishJob(job, body.text, rowIds, str(body.model, 'model', 80, true) || null)
        return { ok: true, reviewId }
      } catch (err) {
        body.error = err.message
      }
    }
    if (job.attempts >= 3) failJob(job, body.error || 'The model gave no reply')
    else store.updateJob(job.id, { state: 'queued', error: clip(String(body.error || ''), 300) })
    setImmediate(processJobs)
    return { ok: false }
  })

  // ---------- from the MCP server (Claude Desktop, or Claude Code tools)

  route('POST', '/api/mcp/prepare-review', (_, body) => {
    const project = resolveProject(body)
    return {
      projectId: project.id, projectName: project.name, projectPath: project.path,
      instructions: R.desktopInstructions(store, project), openItems: R.openItems(store, project.id),
    }
  })

  route('POST', '/api/mcp/submit-review', (_, body) => {
    const project = mustProject(str(body.projectId, 'projectId', 40))
    const raw = typeof body.review === 'string' ? R.extractJson(body.review) : body.review
    if (!raw || typeof raw !== 'object') throw bad('review must be an object')
    const review = R.normalizeReview(Array.isArray(raw.reviews) ? raw.reviews[0] : raw, store.effective(project.id).maxRecommendations)
    const reviewId = R.saveReview(store, { projectId: project.id, source: 'claude-desktop', trigger: 'manual', review, model: 'claude-desktop' })
    store.touchProject(project.id)
    afterReview(project.id, reviewId, review.title)
    return { reviewId, title: review.title }
  })

  function resolveProject(body) {
    if (typeof body.projectId === 'string' && body.projectId) return mustProject(body.projectId)
    if (typeof body.projectPath === 'string' && body.projectPath) {
      const p = path.resolve(body.projectPath)
      if (!fs.existsSync(p)) throw bad(`That folder does not exist: ${p}`)
      const root = rootFor(path.join(p, '.pulse-probe'), p, store.globalSettings()) || p
      return store.project(ensureProject(root))
    }
    if (typeof body.projectName === 'string' && body.projectName) {
      const found = store.findProjectByName(body.projectName)
      if (found) return found
      throw new HttpError(404, `No project named "${body.projectName}" yet. Pass its folder path instead.`)
    }
    throw bad('Give projectPath, projectId or projectName')
  }

  // ---------- HTTP plumbing

  const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', c => {
        size += c.length
        if (size <= MAX_BODY) chunks.push(c) // past the limit: keep draining, answer 413 at the end
      })
      req.on('end', () => {
        if (size > MAX_BODY) return reject(new HttpError(413, 'Body too large'))
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try {
          const parsed = JSON.parse(text)
          resolve(parsed && typeof parsed === 'object' ? parsed : {})
        } catch {
          reject(bad('Body must be JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function serveStatic(res, pathname) {
    const name = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.slice(1)
    if (!/^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$/i.test(name)) return false
    const file = path.join(UI_DIR, name)
    if (!fs.existsSync(file)) return false
    res.writeHead(200, {
      'Content-Type': STATIC[path.extname(name).toLowerCase()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    })
    fs.createReadStream(file).pipe(res)
    return true
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const host = String(req.headers.host || '')
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(res, 403, { error: 'Bad host' })
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${actualPort}` && origin !== `http://localhost:${actualPort}`) return send(res, 403, { error: 'Bad origin' })

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (serveStatic(res, url.pathname)) return
      return send(res, 404, { error: 'Not found' })
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (url.searchParams.get('t') !== token) return send(res, 401, { error: 'Bad token' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
      res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`)
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
        if (!clients.size) windowState = { ...windowState, visible: false, focused: false }
      })
      return
    }

    for (const r of routes) {
      if (r.method !== req.method) continue
      const m = r.re.exec(url.pathname)
      if (!m) continue
      const given = req.headers['x-pulse-token'] || (r.queryToken ? url.searchParams.get('t') : null)
      if (!r.open && given !== token) return send(res, 401, { error: 'Bad token' })
      try {
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req)
        const out = await r.handler(m.groups || {}, body, req)
        return send(res, 200, out)
      } catch (err) {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message })
        log.error(`${req.method} ${url.pathname} failed`, err)
        return send(res, 500, { error: 'Pulse hit an internal error. Details are in the diagnostic log.' })
      }
    }
    return send(res, 404, { error: 'Not found' })
  }

  // ---------- upkeep

  function sweep() {
    for (const a of store.untakenActions(LIVE_MS)) {
      store.dropAction(a.id)
      if (a.kind === 'review') queueHeadless(a.project_id, { sessionId: a.session_id, trigger: 'manual', source: 'pulse-window' })
      if (a.kind === 'generate') {
        const { jobId } = JSON.parse(a.payload || '{}')
        const job = jobId && store.job(jobId)
        if (job && job.state === 'running') store.updateJob(job.id, { state: 'queued', attempts: Math.max(0, job.attempts - 1) })
      }
    }
    for (const job of store.staleJobs()) {
      if (Date.now() - Date.parse(job.started_at || job.created_at) < 6 * 60_000) continue
      if (job.kind === 'live') toHeadless(job, 'The live review took too long')
      else store.updateJob(job.id, { state: 'queued' })
    }
    for (const [id, s] of live) if (Date.now() - s.lastSeen > 2 * 60_000) live.delete(id)
    // A session that went silent without saying it ended (Claude closed, crashed, or Windows restarted).
    const cutoff = new Date(Date.now() - LOST_MS).toISOString()
    for (const s of store.q(`select id from sessions where ended_at is null and last_seen_at < ?`).all(cutoff)) {
      store.endSession(s.id, 'lost')
      for (const pid of new Set(store.unreviewed({ sessionId: s.id }).map(r => r.project_id))) {
        if (store.effective(pid).autoReviews && !store.activeJob(pid)) queueHeadless(pid, { sessionId: s.id, trigger: 'session-end', source: 'claude-code' })
      }
    }
    const waiting = store.q(`select count(*) n from jobs where kind = 'headless' and state in ('queued', 'waiting')`).get().n
    if (waiting) processJobs()
  }

  // A project recorded at a subfolder (before project detection walked up to the real project)
  // is folded into the project that folder belongs to.
  function reconcileProjects() {
    const settings = store.globalSettings()
    for (const p of store.projects()) {
      if (!fs.existsSync(p.path)) continue
      const root = cwdProject(p.path, settings)
      if (!root || root.toLowerCase() === p.path.toLowerCase()) continue
      const target = ensureProject(root)
      if (target === p.id) continue
      store.mergeProject(p.id, target)
      log.info(`Merged project "${p.name}" (${p.path}) into ${projectName(root)} (${root})`)
    }
  }

  function recover() {
    for (const job of store.staleJobs()) {
      if (job.kind === 'live') store.updateJob(job.id, { kind: 'headless', state: 'queued' })
      else store.updateJob(job.id, { state: 'queued' })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      log.error('Request crashed', err)
      try {
        send(res, 500, { error: 'Internal error' })
      } catch {}
    })
  })
  server.keepAliveTimeout = 5000

  let sweeper = null
  let kickoff = null
  return {
    server,
    openWindow,
    processJobs,
    sweep,
    get clients() {
      return clients.size
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          actualPort = server.address().port
          recover()
          try {
            reconcileProjects()
          } catch (err) {
            log.error('Project merge failed', err)
          }
          sweeper = setInterval(sweep, 15_000)
          kickoff = setTimeout(processJobs, 2000)
          resolve(actualPort)
        })
      })
    },
    async close() {
      clearInterval(sweeper)
      clearTimeout(kickoff)
      closed = true // no new job work once closing; a run in progress stops at its next step
      for (const res of clients) res.end()
      if (jobRun) await Promise.race([jobRun, new Promise(r => setTimeout(r, 2000))])
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}

function validSetting(key, value) {
  const fail = () => {
    throw bad(`Invalid value for ${key}`)
  }
  switch (key) {
    case 'autoReviews': case 'autoOpenWindow': case 'notifications': case 'animations': case 'openWhileTyping':
      return typeof value === 'boolean' ? value : fail()
    case 'maxRecommendations':
      return [1, 2, 3].includes(value) ? value : fail()
    case 'detail':
      return ['brief', 'standard', 'detailed'].includes(value) ? value : fail()
    case 'theme':
      return ['system', 'dark', 'light'].includes(value) ? value : fail()
    case 'settleSeconds':
      return Number.isInteger(value) && value >= 10 && value <= 1800 ? value : fail()
    case 'reviewModel':
      return typeof value === 'string' && /^[A-Za-z0-9.\-[\]]{2,60}$/.test(value) ? value : fail()
    case 'workspaces':
      return Array.isArray(value) && value.length <= 30 && value.every(v => typeof v === 'string' && path.isAbsolute(v) && v.length < 500)
        ? value.map(v => path.resolve(v)) : fail()
    default:
      return fail()
  }
}

// ---------- run as a program: node service/server.mjs [--open] [--project <id>]

async function healthAt(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    return body.app === 'project-pulse'
  } catch {
    return false
  }
}

async function main() {
  ensureDirs()
  const token = loadToken()
  const args = process.argv.slice(2)
  const wantsOpen = args.includes('--open')
  const projectArg = args.includes('--project') ? args[args.indexOf('--project') + 1] : null
  if (await healthAt(PORT)) {
    if (wantsOpen) {
      await fetch(`http://127.0.0.1:${PORT}/api/window/open`, {
        method: 'POST', headers: { 'X-Pulse-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: projectArg }),
      }).catch(() => {})
    }
    return
  }
  const store = new Store(DB_FILE)
  const pulse = createPulse({ store, token })
  try {
    await pulse.listen()
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${PORT} is used by another program; set PROJECT_PULSE_PORT to change it`)
      process.exit(1)
    }
    throw err
  }
  writeServiceFile({ port: PORT, pid: process.pid, version: VERSION, startedAt: now() })
  log.info(`Project Pulse ${VERSION} listening on 127.0.0.1:${PORT} (pid ${process.pid})`)
  if (wantsOpen) pulse.openWindow(projectArg, { explicit: true })
  const stop = async () => {
    await pulse.close().catch(() => {})
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('uncaughtException', err => log.error('Uncaught error (service keeps running)', err))
  process.on('unhandledRejection', err => log.error('Unhandled rejection (service keeps running)', err))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    log.error('Project Pulse failed to start', err)
    process.exit(1)
  })
}
