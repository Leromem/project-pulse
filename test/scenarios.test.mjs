// The required Project Pulse scenarios, run against the real service (HTTP, SQLite, project
// resolution, jobs) with the window, notifications and the Claude CLI replaced by recorders.
// Run: node --test test/
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'))
process.env.PROJECT_PULSE_HOME = path.join(RUN, 'home')
// Project fixtures live outside the temp folder, which Pulse ignores on purpose.
const FIX = path.join(ROOT, 'test', `.fixtures-${process.pid}`)
const WS = path.join(FIX, 'workspace')
const ALPHA = path.join(WS, 'alpha')
const BETA = path.join(WS, 'beta')
const TOKEN = 'b'.repeat(48)

const { createPulse } = await import('../service/server.mjs')
const { Store } = await import('../service/db.mjs')
const { ensureDirs } = await import('../service/config.mjs')
const { projectId } = await import('../service/projects.mjs')
const ALPHA_ID = projectId(ALPHA)
const BETA_ID = projectId(BETA)

before(() => {
  ensureDirs()
  fs.mkdirSync(path.join(ALPHA, 'src'), { recursive: true })
  fs.mkdirSync(path.join(BETA, 'lib'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: ALPHA })
  fs.writeFileSync(path.join(BETA, 'package.json'), '{"name":"beta"}')
  fs.writeFileSync(path.join(ALPHA, 'src', 'pricing.js'), 'export const price = 1\n')
})
after(() => {
  fs.rmSync(FIX, { recursive: true, force: true })
  fs.rmSync(RUN, { recursive: true, force: true })
})

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick(40)
  }
}

let dbCount = 0
async function harness({ dbFile = path.join(RUN, `pulse-${++dbCount}.db`) } = {}) {
  const launches = []
  const notes = []
  const cli = { calls: 0, impl: async () => { throw new Error('Failed to authenticate: OAuth session expired') } }
  const store = new Store(dbFile)
  const pulse = createPulse({
    store, token: TOKEN, port: 0, windowWaitMs: 0,
    launch: url => launches.push(url),
    notify: (title, body) => notes.push({ title, body }),
    waitForIdle: async () => true,
    runCli: async (...args) => (cli.calls++, cli.impl(...args)),
    openFolder: () => {},
  })
  const port = await pulse.listen()
  const api = async (method, route, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'X-Pulse-Token': TOKEN, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const project = async id => (await api('GET', `/api/projects/${id}`)).body
  return { store, pulse, port, api, project, launches, notes, cli, dbFile, close: async () => { await pulse.close(); store.close() } }
}

const turn = (sessionId, over = {}) => ({
  sessionId, cwd: ALPHA, seq: Date.now() + Math.floor(Math.random() * 1000), prompt: 'Add AI-recommended auction starting prices',
  answer: 'Done. Added the pricing helper; tests pass.', reason: 'answer',
  files: [{ path: path.join(ALPHA, 'src', 'pricing.js'), op: 'edit' }], commands: [{ cmd: 'npm test', isError: false }], ...over,
})

const reviewFor = (pid, over = {}) => ({
  project_id: pid,
  title: 'Added AI-recommended auction starting prices',
  status: 'needs-testing',
  status_reason: 'Pricing code changed; the new path has no test yet',
  built: ['AI suggests a starting price for each auction'],
  benefits: ['Faster auction setup', 'Less manual pricing research'],
  drawbacks: [{ key: 'd1', text: 'AI prices may be inaccurate', detail: 'Few comparable sales lower reliability' }],
  evidence: ['Edited src/pricing.js', 'npm test passed'],
  recommendations: [{
    title: 'Allow manual starting bids', why: 'Sellers may disagree with AI estimates.', benefit: 'More seller control.',
    drawback: 'Sellers could choose unrealistic prices.', priority: 'high', effort: 'small', addresses: 'd1',
    connection: 'Lets sellers correct an inaccurate AI price.', explore: 'Add an editable field next to the suggestion.', simple: 'Let people type their own price.',
  }],
  resolved_drawbacks: [], implemented_recommendations: [], ...over,
})
const reply = (...reviews) => JSON.stringify({ reviews })

async function liveReview(h, sessionId, reviews, body = {}) {
  const ctx = await h.api('POST', '/api/hook/review-context', { sessionId, trigger: 'task-complete', ...body })
  assert.ok(ctx.body.jobIds, `expected a review context, got ${JSON.stringify(ctx.body)}`)
  const saved = await h.api('POST', '/api/hook/review', { sessionId, jobIds: ctx.body.jobIds, text: reply(...reviews(ctx.body.projectIds)) })
  return { ctx: ctx.body, saved: saved.body }
}

// ---------------------------------------------------------------------------

test('1. Claude Code completes a development task → one review, linked, window opened', async () => {
  const h = await harness()
  try {
    const r = await h.api('POST', '/api/hook/activity', turn('s1'))
    assert.equal(r.status, 200)
    assert.equal(r.body.schedule, true)
    assert.equal(r.body.meaningful, true)
    assert.equal(r.body.settleMs, 90_000)
    assert.deepEqual(r.body.projects, [ALPHA_ID])

    const { ctx, saved } = await liveReview(h, 's1', () => [reviewFor(ALPHA_ID)])
    assert.deepEqual(ctx.projectIds, [ALPHA_ID])
    assert.match(ctx.prompt, /Add AI-recommended auction starting prices/)
    assert.match(ctx.prompt, /pricing\.js/)
    assert.match(ctx.prompt, /Do not continue it, do not call any tools/)
    assert.equal(saved.reviews.length, 1)

    const d = await h.project(ALPHA_ID)
    assert.equal(d.project.name, 'alpha')
    assert.equal(d.latestReview.title, 'Added AI-recommended auction starting prices')
    assert.equal(d.latestReview.status, 'needs-testing')
    assert.equal(d.latestReview.trigger, 'task-complete')
    assert.equal(d.recommendations.length, 1)
    assert.equal(d.recommendations[0].addressesDrawbackId, d.drawbacks[0].id)
    assert.ok(d.links.some(l => l.relation === 'addresses' && l.toId === d.drawbacks[0].id))
    assert.ok(d.links.some(l => l.relation === 'introduced'))

    await until(() => h.launches.length === 1)
    assert.match(h.launches[0], new RegExp(`project=${ALPHA_ID}`))
    assert.equal(h.notes.length, 1)

    // Nothing new since → no second (duplicate) review.
    const again = await h.api('POST', '/api/hook/review-context', { sessionId: 's1', trigger: 'task-complete' })
    assert.equal(again.body.nothing, true)
    assert.equal((await h.project(ALPHA_ID)).reviews.length, 1)
  } finally {
    await h.close()
  }
})

test('2. a finished response while the task is still going does not trigger a review', async () => {
  const h = await harness()
  try {
    // A question back to the user, no changes yet.
    const q = await h.api('POST', '/api/hook/activity', turn('s2', { files: [], commands: [], answer: 'Which currency should prices use?' }))
    assert.equal(q.body.schedule, false)
    // Work interrupted half way.
    const cut = await h.api('POST', '/api/hook/activity', turn('s2', { reason: 'aborted' }))
    assert.equal(cut.body.schedule, false)
    // Work resumes and finishes: now it may be reviewed, covering both turns.
    const done = await h.api('POST', '/api/hook/activity', turn('s2', { prompt: 'Use USD and finish it' }))
    assert.equal(done.body.schedule, true)
    const ctx = await h.api('POST', '/api/hook/review-context', { sessionId: 's2', trigger: 'task-complete' })
    assert.match(ctx.body.prompt, /Which currency|Add AI-recommended/)
    assert.match(ctx.body.prompt, /Use USD and finish it/)
  } finally {
    await h.close()
  }
})

test('3. the user ends the session → the leftover work is reviewed once, from the session log', async () => {
  const h = await harness()
  h.cli.impl = async prompt => {
    assert.match(prompt, /Session log for "alpha"/)
    assert.match(prompt, /Add AI-recommended auction starting prices/)
    return { text: reply(reviewFor(ALPHA_ID)), model: 'sonnet' }
  }
  try {
    await h.api('POST', '/api/hook/activity', turn('s3'))
    const end = await h.api('POST', '/api/hook/session-end', { sessionId: 's3', reason: 'prompt_input_exit' })
    assert.equal(end.body.queued, true)
    const d = await until(async () => (await h.project(ALPHA_ID))?.latestReview)
    assert.equal(d.trigger, 'session-end')
    assert.equal(h.cli.calls, 1)
    // Ending twice, or a later sweep, writes nothing more.
    await h.api('POST', '/api/hook/session-end', { sessionId: 's3', reason: 'prompt_input_exit' })
    await tick(200)
    assert.equal((await h.project(ALPHA_ID)).reviews.length, 1)
  } finally {
    await h.close()
  }
})

test('4. Claude Desktop requests a manual review (API and the real MCP server over stdio)', async () => {
  const h = await harness()
  try {
    const prep = await h.api('POST', '/api/mcp/prepare-review', { projectPath: BETA })
    assert.equal(prep.body.projectId, BETA_ID)
    assert.match(prep.body.instructions, /pulse_submit_review/)
    const sub = await h.api('POST', '/api/mcp/submit-review', { projectId: BETA_ID, review: reviewFor(BETA_ID, { title: 'Added a CSV export' }) })
    assert.equal(sub.body.title, 'Added a CSV export')
    const d = await h.project(BETA_ID)
    assert.equal(d.latestReview.source, 'claude-desktop')

    // The MCP server process, talking JSON-RPC on stdio to this service.
    const home = path.join(RUN, 'mcp-home')
    fs.mkdirSync(path.join(home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(home, 'data', 'token'), TOKEN)
    fs.writeFileSync(path.join(home, 'data', 'service.json'), JSON.stringify({ port: h.port }))
    const child = spawn(process.execPath, [path.join(ROOT, 'plugin', 'mcp', 'server.mjs')], { env: { ...process.env, PROJECT_PULSE_HOME: home } })
    const answers = new Map()
    let buf = ''
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        answers.set(msg.id, msg)
      }
    })
    const rpc = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return until(() => answers.get(id), 8000)
    }
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.result.serverInfo.name, 'project-pulse')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const tools = await rpc(2, 'tools/list', {})
    assert.deepEqual(tools.result.tools.map(t => t.name).sort(), ['pulse_list_projects', 'pulse_open_window', 'pulse_project_history', 'pulse_start_review', 'pulse_submit_review', 'pulse_update_recommendation'])
    const list = await rpc(3, 'tools/call', { name: 'pulse_list_projects', arguments: {} })
    assert.match(list.result.content[0].text, /beta/)
    const hist = await rpc(4, 'tools/call', { name: 'pulse_project_history', arguments: { project_name: 'beta' } })
    assert.match(hist.result.content[0].text, /Added a CSV export/)
    assert.match(hist.result.content[0].text, /Allow manual starting bids/)
    const start = await rpc(5, 'tools/call', { name: 'pulse_start_review', arguments: { project_path: BETA } })
    assert.match(start.result.content[0].text, new RegExp(`project_id: ${BETA_ID}`))
    const submitted = await rpc(6, 'tools/call', { name: 'pulse_submit_review', arguments: { project_id: BETA_ID, review: reviewFor(BETA_ID, { title: 'Desktop review via MCP' }) } })
    assert.match(submitted.result.content[0].text, /Desktop review via MCP/)
    child.kill()
  } finally {
    await h.close()
  }
})

test('5. several projects at once: each gets its own review, nothing is mixed', async () => {
  const h = await harness()
  try {
    // One session in the folder of projects touches two projects and a loose file.
    const r = await h.api('POST', '/api/hook/activity', turn('s5', {
      cwd: WS,
      files: [{ path: path.join(ALPHA, 'src', 'pricing.js'), op: 'edit' }, { path: path.join(BETA, 'lib', 'export.js'), op: 'write' }, { path: path.join(WS, 'notes.md'), op: 'write' }],
    }))
    assert.deepEqual(r.body.projects.sort(), [ALPHA_ID, BETA_ID].sort())
    const { ctx } = await liveReview(h, 's5', ids => ids.map(id => reviewFor(id, {
      title: id === ALPHA_ID ? 'Alpha pricing' : 'Beta export',
      recommendations: [{ title: id === ALPHA_ID ? 'Allow manual starting bids' : 'Stream large exports', why: 'w', benefit: 'b', drawback: 'd', priority: 'medium', effort: 'small', addresses: null, connection: 'c', explore: 'e', simple: 's' }],
    })))
    assert.equal(ctx.projectIds.length, 2)
    const a = await h.project(ALPHA_ID)
    const b = await h.project(BETA_ID)
    assert.equal(a.latestReview.title, 'Alpha pricing')
    assert.equal(b.latestReview.title, 'Beta export')
    assert.deepEqual(a.recommendations.map(x => x.title), ['Allow manual starting bids'])
    assert.deepEqual(b.recommendations.map(x => x.title), ['Stream large exports'])
    // A second session in another project is tracked separately.
    await h.api('POST', '/api/hook/activity', turn('s5b', { cwd: BETA, files: [{ path: path.join(BETA, 'lib', 'x.js'), op: 'edit' }] }))
    const ctxB = await h.api('POST', '/api/hook/review-context', { sessionId: 's5b', trigger: 'task-complete' })
    assert.deepEqual(ctxB.body.projectIds, [BETA_ID])
  } finally {
    await h.close()
  }
})

test('a git worktree session (as the desktop app makes) counts as its main project', async () => {
  const h = await harness()
  try {
    const wt = path.join(ALPHA, '.claude', 'worktrees', 'brave-fox')
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(ALPHA, '.git', 'worktrees', 'brave-fox').replace(/\\/g, '/')}\n`)
    const r = await h.api('POST', '/api/hook/activity', turn('swt', { cwd: wt, files: [{ path: path.join(wt, 'src', 'pricing.js'), op: 'edit' }] }))
    assert.deepEqual(r.body.projects, [ALPHA_ID])
  } finally {
    await h.close()
  }
})

test('a session in a subfolder counts as its project; strays from before are merged at startup', async () => {
  const dbFile = path.join(RUN, 'strays.db')
  const first = await harness({ dbFile })
  // A project recorded at a plain subfolder, the way the old detection did it.
  const strayPath = path.join(BETA, 'lib')
  const strayId = projectId(strayPath)
  first.store.upsertProject(strayId, strayPath, 'lib')
  first.store.addActivity({ session_id: 'old', project_id: strayId, seq: 1, prompt: 'p', answer: 'a', reason: 'answer', files: '[]', commands: '[]', edits: 1, mutating: 0, completion: 0 })
  await liveReview(first, 'old', () => [reviewFor(strayId, { title: 'Stray review' })])
  await first.close()

  const h = await harness({ dbFile })
  try {
    const ids = (await h.api('GET', '/api/projects')).body.map(p => p.id)
    assert.ok(!ids.includes(strayId), 'the stray project is gone')
    assert.equal((await h.project(BETA_ID)).latestReview.title, 'Stray review')
    // A session sitting in that subfolder now works on the real project.
    const sub = await h.api('POST', '/api/hook/activity', turn('ssub', { cwd: strayPath, files: [], commands: [] }))
    assert.deepEqual(sub.body.projects, [BETA_ID])
    // A subfolder with its own package.json inside a git repository belongs to the repository.
    const web = path.join(ALPHA, 'web')
    fs.mkdirSync(web, { recursive: true })
    fs.writeFileSync(path.join(web, 'package.json'), '{"name":"web"}')
    const r = await h.api('POST', '/api/hook/activity', turn('sweb', { cwd: web, files: [{ path: path.join(web, 'app.js'), op: 'edit' }] }))
    assert.deepEqual(r.body.projects, [ALPHA_ID])
  } finally {
    await h.close()
  }
})

test('6. Pulse window closed → it opens (when idle); open → it updates live instead', async () => {
  const h = await harness()
  try {
    // Open window: an SSE client is connected.
    const events = []
    const req = http.get({ host: '127.0.0.1', port: h.port, path: `/api/events?t=${TOKEN}`, headers: { Host: `127.0.0.1:${h.port}` } }, res => {
      res.on('data', d => events.push(String(d)))
    })
    await until(() => events.join('').includes('event: hello'))
    await h.api('POST', '/api/window/state', { visible: true, focused: false, bounds: { x: 10, y: 20, w: 460, h: 800 } })
    await h.api('POST', '/api/hook/activity', turn('s6'))
    await liveReview(h, 's6', () => [reviewFor(ALPHA_ID)])
    await until(() => events.join('').includes('event: review'))
    assert.equal(h.launches.length, 0, 'no second window while one is open')
    assert.equal(h.notes.length, 1, 'notified because the window was not focused')
    req.destroy()
    await tick(100)

    // Closed window: the next review opens it, at the remembered size and place.
    await h.api('POST', '/api/hook/activity', turn('s6', { prompt: 'Add tests' }))
    await liveReview(h, 's6', () => [reviewFor(ALPHA_ID, { title: 'Added pricing tests', recommendations: [] })])
    await until(() => h.launches.length === 1)
    assert.deepEqual(h.store.meta('windowBounds'), { x: 10, y: 20, w: 460, h: 800 })
  } finally {
    await h.close()
  }
})

test('7. automatic reviews disabled globally or per project', async () => {
  const h = await harness()
  try {
    await h.api('PUT', '/api/settings', { autoReviews: false })
    const r = await h.api('POST', '/api/hook/activity', turn('s7'))
    assert.equal(r.body.schedule, false)
    const end = await h.api('POST', '/api/hook/session-end', { sessionId: 's7', reason: 'prompt_input_exit' })
    assert.equal(end.body.queued, false)
    // Manual review is always available.
    const manual = await h.api('POST', '/api/hook/review-context', { sessionId: 's7', trigger: 'manual', force: true })
    assert.deepEqual(manual.body.projectIds, [ALPHA_ID])
    await h.api('POST', '/api/hook/review-failed', { sessionId: 's7', jobIds: manual.body.jobIds, reason: 'test' })
    // A project can turn it back on for itself.
    await h.api('PUT', `/api/projects/${ALPHA_ID}/settings`, { overrides: { autoReviews: true } })
    const on = await h.api('POST', '/api/hook/activity', turn('s7b'))
    assert.equal(on.body.schedule, true)
    // /pulse off (this project) and /pulse on all.
    const off = await h.api('POST', '/api/hook/control', { sessionId: 's7b', cwd: ALPHA, command: 'off' })
    assert.match(off.body.text, /alpha: OFF/)
    assert.equal((await h.project(ALPHA_ID)).settings.effective.autoReviews, false)
    const all = await h.api('POST', '/api/hook/control', { sessionId: 's7b', cwd: ALPHA, command: 'on all' })
    assert.match(all.body.text, /ON for all projects/)
    assert.equal((await h.api('GET', '/api/settings')).body.global.autoReviews, true)
    // Bad values are refused.
    assert.equal((await h.api('PUT', '/api/settings', { maxRecommendations: 7 })).status, 400)
  } finally {
    await h.close()
  }
})

test('8 + 9 + 10. dismiss, add to plan, and a later session that implements a recommendation', async () => {
  const h = await harness()
  try {
    await h.api('POST', '/api/hook/activity', turn('s8'))
    await liveReview(h, 's8', () => [reviewFor(ALPHA_ID, {
      recommendations: [
        { title: 'Allow manual starting bids', why: 'w', benefit: 'b', drawback: 'd', priority: 'high', effort: 'small', addresses: 'd1', connection: 'c', explore: 'e', simple: 's' },
        { title: 'Refresh comparable sales daily', why: 'w', benefit: 'b', drawback: 'd', priority: 'medium', effort: 'medium', addresses: 'd1', connection: 'c', explore: 'e', simple: 's' },
      ],
    })])
    let d = await h.project(ALPHA_ID)
    const manual = d.recommendations.find(r => r.title === 'Allow manual starting bids')
    const refresh = d.recommendations.find(r => r.title === 'Refresh comparable sales daily')
    const concern = d.drawbacks[0]

    // 8. Dismiss: hidden, and never suggested again.
    assert.equal((await h.api('POST', `/api/recommendations/${refresh.id}/action`, { action: 'dismiss' })).body.recommendation.status, 'dismissed')
    // 9. Add to plan.
    assert.equal((await h.api('POST', `/api/recommendations/${manual.id}/action`, { action: 'plan' })).body.recommendation.status, 'planned')
    d = await h.project(ALPHA_ID)
    assert.equal(d.project.counts.planned, 1)
    assert.ok(d.decisions.some(x => x.action === 'dismiss') && d.decisions.some(x => x.action === 'plan'))

    // The next review must see both decisions in its prompt.
    await h.api('POST', '/api/hook/activity', turn('s8', { prompt: 'Add an editable starting bid field' }))
    const ctx = await h.api('POST', '/api/hook/review-context', { sessionId: 's8', trigger: 'task-complete' })
    assert.match(ctx.body.prompt, new RegExp(`${manual.id} \\[planned\\]: Allow manual starting bids`))
    assert.match(ctx.body.prompt, /Refresh comparable sales daily \(dismissed\)/)
    assert.match(ctx.body.prompt, new RegExp(`${concern.id}: AI prices may be inaccurate`))

    // 10. That session implemented the planned recommendation, and re-suggested the dismissed one.
    await h.api('POST', '/api/hook/review', {
      sessionId: 's8', jobIds: ctx.body.jobIds, text: reply(reviewFor(ALPHA_ID, {
        title: 'Added editable starting bids', status: 'completed', drawbacks: [],
        recommendations: [{ title: 'Refresh the comparable sales daily!', why: 'w', benefit: 'b', drawback: 'd', priority: 'low', effort: 'small', addresses: null, connection: 'c', explore: 'e', simple: 's' }],
        implemented_recommendations: [{ id: manual.id, evidence: 'Field added and tested' }],
      })),
    })
    d = await h.project(ALPHA_ID)
    const done = d.recommendations.find(r => r.id === manual.id)
    assert.equal(done.status, 'completed')
    assert.equal(done.completedHow, 'detected')
    assert.equal(d.drawbacks.find(x => x.id === concern.id).status, 'resolved')
    assert.equal(d.recommendations.filter(r => /comparable sales/i.test(r.title)).length, 1, 'dismissed idea not re-added')
    assert.ok(d.links.some(l => l.relation === 'implemented' && l.toId === manual.id))
    assert.ok(d.links.some(l => l.relation === 'resolved' && l.toId === concern.id))
    assert.equal(d.latestReview.implemented[0].title, 'Allow manual starting bids')

    // Mark Completed by hand, with how it was checked; Discuss without a live session = copy.
    await h.api('POST', '/api/hook/session-end', { sessionId: 's8', reason: 'prompt_input_exit' })
    await h.api('POST', `/api/recommendations/${refresh.id}/action`, { action: 'restore' })
    const marked = await h.api('POST', `/api/recommendations/${refresh.id}/action`, { action: 'complete', how: 'tests-pass' })
    assert.equal(marked.body.recommendation.completedHow, 'tests-pass')
    const talk = await h.api('POST', `/api/recommendations/${refresh.id}/discuss`, {})
    assert.equal(talk.body.mode, 'copy')
    assert.match(talk.body.prompt, /Please do NOT edit any files yet/)
  } finally {
    await h.close()
  }
})

test('prompt preview: full Discuss prompt with no side effects; unknown id is 404', async () => {
  const h = await harness()
  try {
    await h.api('POST', '/api/hook/activity', turn('sp'))
    await liveReview(h, 'sp', () => [reviewFor(ALPHA_ID, {
      recommendations: [
        { title: 'Allow manual starting bids', why: 'w', benefit: 'b', drawback: 'd', priority: 'high', effort: 'small', addresses: 'd1', connection: 'c', explore: 'e', simple: 's' },
        { title: 'Refresh comparable sales daily', why: 'w', benefit: 'b', drawback: 'd', priority: 'medium', effort: 'medium', addresses: null, connection: 'c', explore: 'e', simple: 's' },
      ],
    })])
    let d = await h.project(ALPHA_ID)
    const manual = d.recommendations.find(r => r.title === 'Allow manual starting bids')
    const refresh = d.recommendations.find(r => r.title === 'Refresh comparable sales daily')
    await h.api('POST', `/api/recommendations/${refresh.id}/action`, { action: 'plan' })
    const decisionsBefore = h.store.q('select count(*) n from decisions').get().n
    const actionsBefore = h.store.q('select count(*) n from actions').get().n

    const res = await h.api('GET', `/api/recommendations/${manual.id}/prompt`)
    assert.equal(res.status, 200)
    const p = res.body.prompt
    assert.ok(p.includes(`(${d.project.path})`), "project path")
    assert.match(p, /Suggestion: Allow manual starting bids/)
    assert.match(p, /Priority: High · Estimated effort: Small/)
    assert.match(p, /Concern this fixes: AI prices may be inaccurate/)
    assert.match(p, /Status: Needs Testing \(/)
    assert.match(p, /Already planned here \(don't repeat\): Refresh comparable sales daily/)
    assert.match(p, /Please do NOT edit any files yet/)
    for (const n of [1, 2, 3, 4, 5]) assert.match(p, new RegExp(`^${n}\\. `, 'm'))
    assert.doesNotMatch(p, /\n\n\n/)

    assert.equal(h.store.q('select count(*) n from decisions').get().n, decisionsBefore, 'no decision logged')
    assert.equal(h.store.q('select count(*) n from actions').get().n, actionsBefore, 'no action queued')

    assert.equal((await h.api('GET', '/api/recommendations/nope/prompt')).status, 404)
  } finally {
    await h.close()
  }
})

test('Discuss in Claude goes to the open Claude Code session of that project', async () => {
  const h = await harness()
  try {
    await h.api('POST', '/api/hook/activity', turn('s9'))
    await liveReview(h, 's9', () => [reviewFor(ALPHA_ID)])
    await h.api('POST', '/api/hook/heartbeat', { sessionId: 's9', cwd: ALPHA })
    const rec = (await h.project(ALPHA_ID)).recommendations[0]
    const talk = await h.api('POST', `/api/recommendations/${rec.id}/discuss`, {})
    assert.equal(talk.body.mode, 'sent-to-claude-code')
    const beat = await h.api('POST', '/api/hook/heartbeat', { sessionId: 's9', cwd: ALPHA })
    assert.equal(beat.body.actions[0].kind, 'discuss')
    assert.match(beat.body.actions[0].prompt, /Allow manual starting bids/)
    // Review now from the window also goes to that session.
    const now = await h.api('POST', `/api/projects/${ALPHA_ID}/review`, {})
    assert.equal(now.body.mode, 'live-session')
    const beat2 = await h.api('POST', '/api/hook/heartbeat', { sessionId: 's9', cwd: ALPHA })
    assert.equal(beat2.body.actions[0].kind, 'review')
  } finally {
    await h.close()
  }
})

test('11. the AI analysis fails → falls back, records a retryable failure, then retries', async () => {
  const h = await harness()
  try {
    await h.api('POST', '/api/hook/activity', turn('s11'))
    const ctx = await h.api('POST', '/api/hook/review-context', { sessionId: 's11', trigger: 'task-complete' })
    // The person closes Claude while the review runs; the running job keeps the work (no second job).
    assert.equal((await h.api('POST', '/api/hook/session-end', { sessionId: 's11', reason: 'prompt_input_exit' })).body.queued, false)
    // The in-session fork failed; the CLI then fails twice for a non-sign-in reason.
    h.cli.impl = async () => { throw new Error('model overloaded') }
    await h.api('POST', '/api/hook/review-failed', { sessionId: 's11', jobIds: ctx.body.jobIds, reason: 'api-error' })
    await h.pulse.processJobs()
    await h.pulse.processJobs()
    const failed = await until(async () => {
      const d = await h.project(ALPHA_ID)
      return d.latestReview?.state === 'failed' && d.latestReview
    })
    assert.match(failed.error, /overloaded/)
    // Retry works once the model answers. The failed card stays in history.
    h.cli.impl = async () => ({ text: reply(reviewFor(ALPHA_ID)), model: 'sonnet' })
    const retry = await h.api('POST', `/api/reviews/${failed.id}/retry`, {})
    assert.equal(retry.body.mode, 'headless')
    const ok = await until(async () => {
      const d = await h.project(ALPHA_ID)
      return d.latestReview?.state === 'ready' && d.latestReview
    })
    assert.equal(ok.trigger, 'retry')
    // A garbled model reply is never saved as a review.
    await h.api('POST', '/api/hook/activity', turn('s11', { prompt: 'more' }))
    const ctx2 = await h.api('POST', '/api/hook/review-context', { sessionId: 's11', trigger: 'task-complete' })
    h.cli.impl = async () => new Promise(() => {}) // keep the fallback busy
    const garbled = await h.api('POST', '/api/hook/review', { sessionId: 's11', jobIds: ctx2.body.jobIds, text: 'Sorry, I cannot do that.' })
    assert.deepEqual(garbled.body.reviews, [])
  } finally {
    await h.close()
  }
})

test('11b. CLI not signed in → the review waits for an open Claude Code session, which writes it', async () => {
  const h = await harness()
  try {
    await h.api('POST', '/api/hook/activity', turn('s11b'))
    await h.api('POST', '/api/hook/session-end', { sessionId: 's11b', reason: 'prompt_input_exit' })
    await until(() => h.store.q(`select state from jobs`).get()?.state === 'waiting')
    // Another session is open somewhere and can generate.
    await h.api('POST', '/api/hook/heartbeat', { sessionId: 'other', cwd: BETA, canGenerate: true })
    const action = await until(async () => {
      const beat = await h.api('POST', '/api/hook/heartbeat', { sessionId: 'other', cwd: BETA, canGenerate: true })
      return beat.body.actions.find(a => a.kind === 'generate')
    })
    assert.match(action.prompt, /Session log for "alpha"/)
    const gen = await h.api('POST', '/api/hook/generated', { jobId: action.jobId, text: reply(reviewFor(ALPHA_ID)), model: 'sonnet' })
    assert.equal(gen.body.ok, true)
    assert.equal((await h.project(ALPHA_ID)).latestReview.trigger, 'session-end')
  } finally {
    await h.close()
  }
})

test('12. Claude restarts: a session that vanished without ending is still reviewed; a live job recovers', async () => {
  const h = await harness()
  h.cli.impl = async () => ({ text: reply(reviewFor(ALPHA_ID, { title: 'Recovered review' })), model: 'sonnet' })
  try {
    await h.api('POST', '/api/hook/activity', turn('s12'))
    h.store.q(`update sessions set last_seen_at = ? where id = 's12'`).run(new Date(Date.now() - 11 * 60_000).toISOString())
    h.pulse.sweep()
    const r = await until(async () => (await h.project(ALPHA_ID))?.latestReview)
    assert.equal(r.title, 'Recovered review')
    assert.equal(h.store.session('s12').end_reason, 'lost')
  } finally {
    await h.close()
  }
})

test('13. Windows restarts: settings, history and an interrupted job survive a service restart', async () => {
  const dbFile = path.join(RUN, 'restart.db')
  const first = await harness({ dbFile })
  await first.api('PUT', '/api/settings', { maxRecommendations: 2, detail: 'standard', theme: 'dark' })
  await first.api('POST', '/api/hook/activity', turn('s13'))
  await liveReview(first, 's13', () => [reviewFor(ALPHA_ID)])
  await first.api('POST', '/api/hook/activity', turn('s13', { prompt: 'second task' }))
  await first.api('POST', '/api/hook/review-context', { sessionId: 's13', trigger: 'task-complete' }) // left running
  await first.close()

  const second = await harness({ dbFile })
  second.cli.impl = async () => ({ text: reply(reviewFor(ALPHA_ID, { title: 'After restart' })), model: 'sonnet' })
  try {
    const s = (await second.api('GET', '/api/settings')).body.global
    assert.equal(s.maxRecommendations, 2)
    assert.equal(s.detail, 'standard')
    assert.equal(s.theme, 'dark')
    await second.pulse.processJobs()
    const d = await until(async () => {
      const p = await second.project(ALPHA_ID)
      return p.reviews.length === 2 && p
    })
    assert.equal(d.latestReview.title, 'After restart')
  } finally {
    await second.close()
  }
})

test('14. no meaningful changes → no automatic review; manual review explains why', async () => {
  const h = await harness()
  try {
    const r = await h.api('POST', '/api/hook/activity', turn('s14', { files: [], commands: [{ cmd: 'git status', isError: false }], prompt: 'What does this function do?' }))
    assert.equal(r.body.schedule, false)
    assert.equal(r.body.meaningful, false)
    assert.equal((await h.api('POST', '/api/hook/session-end', { sessionId: 's14', reason: 'prompt_input_exit' })).body.queued, false)
    // In a folder of projects with no changes there is no project to review.
    await h.api('POST', '/api/hook/activity', turn('s14b', { cwd: WS, files: [], commands: [] }))
    const manual = await h.api('POST', '/api/hook/review-context', { sessionId: 's14b', trigger: 'manual', force: true })
    assert.equal(manual.body.nothing, true)
    assert.match(manual.body.message, /No project found/)
  } finally {
    await h.close()
  }
})

test('security: token, host, origin, size limit, static paths, secret redaction', async () => {
  const h = await harness()
  try {
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/projects`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/events`)).status, 401)
    assert.equal((await h.api('GET', '/api/projects', undefined, { Origin: 'https://evil.example' })).status, 403)
    const badHost = await new Promise(resolve => {
      http.get({ host: '127.0.0.1', port: h.port, path: '/api/health', headers: { Host: 'evil.example' } }, res => resolve(res.statusCode))
    })
    assert.equal(badHost, 403)
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/..%2fservice%2fconfig.mjs`)).status, 404)
    const big = await h.api('POST', '/api/hook/activity', { ...turn('sx'), answer: 'x'.repeat(1_200_000) })
    assert.equal(big.status, 413)

    // Fake, key-shaped values are assembled at run time so no credential-looking string sits in the source.
    const fakeKey = ['sk', 'ant', 'FAKE0TEST0VALUE0ONLY'].join('-')
    const fakePassword = 'FAKE' + 'pass' + '1234'
    const fakeBearer = 'FAKE' + 'x'.repeat(24)
    const fakeAssigned = 'FAKE' + 'assigned' + '987'
    await h.api('POST', '/api/hook/activity', turn('ss', {
      prompt: `use key ${fakeKey} and password=${fakePassword}`,
      commands: [{ cmd: `curl -H "Authorization: Bearer ${fakeBearer}" https://api.example.com`, isError: false }],
    }))
    const row = h.store.q(`select prompt, commands from activity where session_id = 'ss'`).get()
    assert.ok(!row.prompt.includes(fakeKey) && !row.prompt.includes(fakePassword))
    assert.ok(!row.commands.includes(fakeBearer))
    // Review text from the model is redacted too.
    await liveReview(h, 'ss', () => [reviewFor(ALPHA_ID, { built: [`Set API_KEY=${fakeAssigned} in config`] })])
    assert.ok(!JSON.stringify(await h.project(ALPHA_ID)).includes(fakeAssigned))
  } finally {
    await h.close()
  }
})
