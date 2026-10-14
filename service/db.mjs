// SQLite storage: projects, sessions, per-turn activity, reviews, drawbacks, recommendations,
// the links between them, decisions, jobs and the actions waiting for a live Claude Code session.
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const DEFAULT_SETTINGS = Object.freeze({
  autoReviews: true,
  autoOpenWindow: true,
  maxRecommendations: 3,
  detail: 'brief',
  notifications: true,
  animations: true,
  theme: 'system',
  openWhileTyping: false,
  settleSeconds: 90,
  reviewModel: 'sonnet',
  workspaces: [],
})
export const OVERRIDABLE = ['autoReviews', 'autoOpenWindow', 'maxRecommendations', 'detail', 'notifications']

const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists settings(key text primary key, value text);
create table if not exists projects(
  id text primary key, path text not null, name text not null, created_at text,
  last_activity_at text, last_review_at text, overrides text not null default '{}');
create table if not exists sessions(
  id text primary key, source text, cwd text, started_at text, last_seen_at text, ended_at text, end_reason text);
create table if not exists activity(
  id integer primary key autoincrement, session_id text not null, project_id text not null, seq integer not null,
  at text, prompt text, answer text, reason text, files text, commands text,
  edits integer default 0, mutating integer default 0, completion integer default 0,
  reviewed integer default 0, review_id text);
create unique index if not exists activity_key on activity(session_id, project_id, seq);
create index if not exists activity_project on activity(project_id, reviewed);
create table if not exists reviews(
  id text primary key, project_id text not null, session_id text, source text, trigger text, created_at text,
  state text, status text, status_reason text, title text, built text, benefits text, evidence text,
  resolved text, implemented text, error text, model text, dedupe text unique);
create index if not exists reviews_project on reviews(project_id, created_at);
create table if not exists drawbacks(
  id text primary key, project_id text not null, review_id text, text text, detail text, status text,
  resolved_by_review_id text, resolved_note text, created_at text, updated_at text);
create table if not exists recommendations(
  id text primary key, project_id text not null, review_id text, title text, why text, benefit text, drawback text,
  priority text, effort text, explore text, simple text, connection text, addresses_drawback_id text, status text,
  completed_how text, completed_evidence text, fingerprint text, created_at text, updated_at text, decided_at text);
create table if not exists links(
  id text primary key, project_id text not null, from_type text, from_id text, to_type text, to_id text,
  relation text, note text, created_at text);
create table if not exists decisions(
  id text primary key, project_id text not null, recommendation_id text, drawback_id text, action text, note text, at text);
create table if not exists jobs(
  id text primary key, project_id text not null, session_id text, trigger text, source text, kind text, state text,
  attempts integer default 0, created_at text, started_at text, finished_at text, error text, payload text);
create table if not exists actions(
  id text primary key, session_id text not null, project_id text, kind text, payload text, created_at text, taken_at text);
`

export const now = () => new Date().toISOString()
export const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`
const json = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 4000; pragma synchronous = normal;')
    this.db.exec(SCHEMA)
    this.stmts = new Map()
  }

  q(sql) {
    let stmt = this.stmts.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.stmts.set(sql, stmt)
    }
    return stmt
  }

  tx(fn) {
    this.db.exec('begin immediate')
    try {
      const out = fn()
      this.db.exec('commit')
      return out
    } catch (err) {
      this.db.exec('rollback')
      throw err
    }
  }

  close() {
    this.db.close()
  }

  // ---- settings
  globalSettings() {
    const out = { ...DEFAULT_SETTINGS }
    for (const row of this.q('select key, value from settings').all()) {
      if (row.key in DEFAULT_SETTINGS) out[row.key] = json(row.value, out[row.key])
    }
    return out
  }

  setGlobal(key, value) {
    this.q('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value))
  }

  meta(key, value) {
    if (value === undefined) return json(this.q('select value from meta where key = ?').get(key)?.value, undefined)
    this.q('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value))
  }

  overrides(projectId) {
    return json(this.q('select overrides from projects where id = ?').get(projectId)?.overrides, {})
  }

  setOverrides(projectId, overrides) {
    this.q('update projects set overrides = ? where id = ?').run(JSON.stringify(overrides), projectId)
  }

  effective(projectId) {
    const out = this.globalSettings()
    for (const [k, v] of Object.entries(projectId ? this.overrides(projectId) : {})) {
      if (OVERRIDABLE.includes(k) && v !== null && v !== undefined) out[k] = v
    }
    return out
  }

  // ---- projects
  upsertProject(id, path, name) {
    const at = now()
    this.q(`insert into projects(id, path, name, created_at) values (?, ?, ?, ?)
            on conflict(id) do update set path = excluded.path`).run(id, path, name, at)
  }

  touchProject(id, field = 'last_activity_at') {
    this.q(`update projects set ${field === 'last_review_at' ? 'last_review_at' : 'last_activity_at'} = ? where id = ?`).run(now(), id)
  }

  project(id) {
    return this.q('select * from projects where id = ?').get(id)
  }

  projects() {
    return this.q('select * from projects order by coalesce(last_activity_at, last_review_at, created_at) desc').all()
  }

  findProjectByName(name) {
    return this.q('select * from projects where lower(name) = lower(?) order by last_activity_at desc').get(name)
  }

  deleteProject(id) {
    this.tx(() => {
      for (const table of ['activity', 'reviews', 'drawbacks', 'recommendations', 'links', 'decisions', 'jobs', 'actions']) {
        this.q(`delete from ${table} where project_id = ?`).run(id)
      }
      this.q('delete from projects where id = ?').run(id)
    })
  }

  // Moves everything recorded under `fromId` to `toId`, then forgets `fromId`.
  mergeProject(fromId, toId) {
    this.tx(() => {
      for (const table of ['reviews', 'drawbacks', 'recommendations', 'links', 'decisions', 'jobs', 'actions']) {
        this.q(`update ${table} set project_id = ? where project_id = ?`).run(toId, fromId)
      }
      // A turn already recorded under the target (same session and time) keeps the target's copy.
      this.q('update or ignore activity set project_id = ? where project_id = ?').run(toId, fromId)
      this.q('delete from activity where project_id = ?').run(fromId)
      const from = this.project(fromId)
      const to = this.project(toId)
      const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b)
      this.q('update projects set last_activity_at = ?, last_review_at = ? where id = ?')
        .run(later(from?.last_activity_at, to?.last_activity_at) ?? null, later(from?.last_review_at, to?.last_review_at) ?? null, toId)
      this.q('delete from projects where id = ?').run(fromId)
    })
  }

  counts(projectId) {
    const rec = this.q(`select status, count(*) n from recommendations where project_id = ? group by status`).all(projectId)
    const by = Object.fromEntries(rec.map(r => [r.status, r.n]))
    return {
      suggested: by.suggested || 0,
      planned: by.planned || 0,
      openDrawbacks: this.q(`select count(*) n from drawbacks where project_id = ? and status = 'open'`).get(projectId).n,
      reviews: this.q(`select count(*) n from reviews where project_id = ?`).get(projectId).n,
    }
  }

  // ---- sessions and activity
  upsertSession(id, source, cwd) {
    const at = now()
    this.q(`insert into sessions(id, source, cwd, started_at, last_seen_at) values (?, ?, ?, ?, ?)
            on conflict(id) do update set last_seen_at = excluded.last_seen_at, cwd = coalesce(excluded.cwd, sessions.cwd)`).run(id, source, cwd, at, at)
  }

  endSession(id, reason) {
    this.q('update sessions set ended_at = ?, end_reason = ? where id = ?').run(now(), reason, id)
  }

  session(id) {
    return this.q('select * from sessions where id = ?').get(id)
  }

  addActivity(row) {
    this.q(`insert into activity(session_id, project_id, seq, at, prompt, answer, reason, files, commands, edits, mutating, completion)
            values (:session_id, :project_id, :seq, :at, :prompt, :answer, :reason, :files, :commands, :edits, :mutating, :completion)
            on conflict(session_id, project_id, seq) do update set answer = excluded.answer, reason = excluded.reason,
              files = excluded.files, commands = excluded.commands, edits = excluded.edits, mutating = excluded.mutating,
              completion = excluded.completion`).run({ ...row, at: now() })
  }

  // Unreviewed turns that changed something, per project.
  unreviewed({ sessionId, projectId } = {}) {
    let sql = `select * from activity where reviewed = 0 and project_id != '' and (edits > 0 or mutating > 0)`
    const args = []
    if (sessionId) (sql += ' and session_id = ?'), args.push(sessionId)
    if (projectId) (sql += ' and project_id = ?'), args.push(projectId)
    return this.q(sql + ' order by id').all(...args).map(decodeActivity)
  }

  sessionActivity(sessionId) {
    return this.q('select * from activity where session_id = ? order by seq, id').all(sessionId).map(decodeActivity)
  }

  recentActivity(projectId, limit = 30) {
    return this.q('select * from activity where project_id = ? order by id desc limit ?').all(projectId, limit).map(decodeActivity).reverse()
  }

  // Conversation-only turns (no project files) of the given sessions: context for a review.
  contextActivity(sessionIds) {
    if (!sessionIds.length) return []
    return this.q(`select * from activity where project_id = '' and session_id in (${sessionIds.map(() => '?').join(',')}) order by id`)
      .all(...sessionIds).map(decodeActivity)
  }

  markReviewed(ids, reviewId) {
    const stmt = this.q('update activity set reviewed = 1, review_id = ? where id = ?')
    for (const id of ids) stmt.run(reviewId, id)
  }

  sessionProjects(sessionId) {
    return this.q(`select distinct project_id from activity where session_id = ? and project_id != ''`).all(sessionId).map(r => r.project_id)
  }

  // ---- reviews
  insertReview(r) {
    this.q(`insert into reviews(id, project_id, session_id, source, trigger, created_at, state, status, status_reason, title,
              built, benefits, evidence, resolved, implemented, error, model, dedupe)
            values (:id, :project_id, :session_id, :source, :trigger, :created_at, :state, :status, :status_reason, :title,
              :built, :benefits, :evidence, :resolved, :implemented, :error, :model, :dedupe)`).run(r)
  }

  reviewByDedupe(dedupe) {
    return this.q('select id from reviews where dedupe = ?').get(dedupe)
  }

  reviewRow(id) {
    return this.q('select * from reviews where id = ?').get(id)
  }

  reviewSummaries(projectId, limit = 60) {
    return this.q('select id, created_at, title, status, state, trigger, source from reviews where project_id = ? order by created_at desc limit ?')
      .all(projectId, limit).map(r => ({
        id: r.id, createdAt: r.created_at, title: r.title, status: r.status, state: r.state, trigger: r.trigger, source: r.source,
      }))
  }

  latestReviewId(projectId) {
    return this.q('select id from reviews where project_id = ? order by created_at desc limit 1').get(projectId)?.id
  }

  review(id) {
    const r = this.reviewRow(id)
    if (!r) return null
    const recs = this.q('select * from recommendations where review_id = ? order by rowid').all(id).map(decodeRec)
    const resolved = json(r.resolved, []).map(x => ({ ...x, text: this.q('select text from drawbacks where id = ?').get(x.drawbackId)?.text || '' }))
    const implemented = json(r.implemented, []).map(x => ({ ...x, title: this.q('select title from recommendations where id = ?').get(x.recommendationId)?.title || '' }))
    return {
      id: r.id, projectId: r.project_id, sessionId: r.session_id, source: r.source, trigger: r.trigger, createdAt: r.created_at,
      state: r.state, status: r.status, statusReason: r.status_reason || '', title: r.title || '',
      built: json(r.built, []), benefits: json(r.benefits, []), evidence: json(r.evidence, []),
      drawbacks: this.q('select * from drawbacks where review_id = ? order by rowid').all(id).map(decodeDrawback),
      recommendations: recs, resolved, implemented, error: r.error || null,
    }
  }

  // ---- drawbacks, recommendations, links, decisions
  insertDrawback(d) {
    this.q(`insert into drawbacks(id, project_id, review_id, text, detail, status, created_at, updated_at)
            values (:id, :project_id, :review_id, :text, :detail, 'open', :at, :at)`).run({ ...d, at: now() })
  }

  drawback(id) {
    const row = this.q('select * from drawbacks where id = ?').get(id)
    return row ? decodeDrawback(row) : null
  }

  drawbacks(projectId) {
    return this.q('select * from drawbacks where project_id = ? order by created_at desc').all(projectId).map(decodeDrawback)
  }

  setDrawback(id, fields) {
    const d = this.q('select * from drawbacks where id = ?').get(id)
    if (!d) return null
    const next = { status: d.status, resolved_by_review_id: d.resolved_by_review_id, resolved_note: d.resolved_note, ...fields }
    this.q('update drawbacks set status = ?, resolved_by_review_id = ?, resolved_note = ?, updated_at = ? where id = ?')
      .run(next.status, next.resolved_by_review_id ?? null, next.resolved_note ?? null, now(), id)
    return this.drawback(id)
  }

  insertRec(r) {
    const at = now()
    this.q(`insert into recommendations(id, project_id, review_id, title, why, benefit, drawback, priority, effort, explore, simple,
              connection, addresses_drawback_id, status, fingerprint, created_at, updated_at)
            values (:id, :project_id, :review_id, :title, :why, :benefit, :drawback, :priority, :effort, :explore, :simple,
              :connection, :addresses_drawback_id, 'suggested', :fingerprint, :at, :at)`).run({ ...r, at })
  }

  rec(id) {
    const row = this.q('select * from recommendations where id = ?').get(id)
    return row ? decodeRec(row) : null
  }

  recs(projectId) {
    return this.q('select * from recommendations where project_id = ? order by created_at desc').all(projectId).map(decodeRec)
  }

  recRows(projectId) {
    return this.q('select id, title, status, fingerprint from recommendations where project_id = ?').all(projectId)
  }

  setRec(id, fields) {
    const r = this.q('select * from recommendations where id = ?').get(id)
    if (!r) return null
    const next = { status: r.status, completed_how: r.completed_how, completed_evidence: r.completed_evidence, ...fields }
    this.q('update recommendations set status = ?, completed_how = ?, completed_evidence = ?, updated_at = ?, decided_at = ? where id = ?')
      .run(next.status, next.completed_how ?? null, next.completed_evidence ?? null, now(), now(), id)
    return this.rec(id)
  }

  addLink(projectId, fromType, fromId, toType, toId, relation, note = '') {
    this.q(`insert into links(id, project_id, from_type, from_id, to_type, to_id, relation, note, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId('l'), projectId, fromType, fromId, toType, toId, relation, note, now())
  }

  links(projectId) {
    return this.q('select * from links where project_id = ? order by created_at').all(projectId).map(l => ({
      id: l.id, projectId: l.project_id, fromType: l.from_type, fromId: l.from_id, toType: l.to_type, toId: l.to_id,
      relation: l.relation, note: l.note || '', createdAt: l.created_at,
    }))
  }

  addDecision(projectId, { recommendationId = null, drawbackId = null, action, note = '' }) {
    this.q('insert into decisions(id, project_id, recommendation_id, drawback_id, action, note, at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('x'), projectId, recommendationId, drawbackId, action, note, now())
  }

  decisions(projectId, limit = 100) {
    return this.q('select * from decisions where project_id = ? order by at desc limit ?').all(projectId, limit).map(d => ({
      id: d.id, projectId: d.project_id, recommendationId: d.recommendation_id, drawbackId: d.drawback_id,
      action: d.action, note: d.note || '', at: d.at,
    }))
  }

  // ---- jobs
  insertJob(j) {
    this.q(`insert into jobs(id, project_id, session_id, trigger, source, kind, state, created_at, started_at, payload)
            values (:id, :project_id, :session_id, :trigger, :source, :kind, :state, :created_at, :started_at, :payload)`)
      .run({ session_id: null, started_at: null, payload: '{}', created_at: now(), ...j })
  }

  job(id) {
    return this.q('select * from jobs where id = ?').get(id)
  }

  activeJob(projectId) {
    return this.q(`select * from jobs where project_id = ? and state in ('queued', 'running') order by created_at limit 1`).get(projectId)
  }

  nextQueuedJob() {
    return this.q(`select * from jobs where state = 'queued' and kind = 'headless' order by created_at limit 1`).get()
  }

  updateJob(id, fields) {
    const sets = Object.keys(fields).map(k => `${k} = :${k}`).join(', ')
    this.q(`update jobs set ${sets} where id = :id`).run({ ...fields, id })
  }

  jobs(limit = 15) {
    return this.q('select * from jobs order by created_at desc limit ?').all(limit)
  }

  staleJobs() {
    return this.q(`select * from jobs where state = 'running'`).all()
  }

  // ---- actions for live sessions
  addAction(sessionId, projectId, kind, payload = {}) {
    const id = newId('a')
    this.q('insert into actions(id, session_id, project_id, kind, payload, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, projectId, kind, JSON.stringify(payload), now())
    return id
  }

  takeActions(sessionId) {
    const rows = this.q('select * from actions where session_id = ? and taken_at is null order by created_at').all(sessionId)
    const stmt = this.q('update actions set taken_at = ? where id = ?')
    for (const row of rows) stmt.run(now(), row.id)
    return rows.map(r => ({ id: r.id, kind: r.kind, projectId: r.project_id, ...json(r.payload, {}) }))
  }

  untakenActions(olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    return this.q('select * from actions where taken_at is null and created_at < ?').all(cutoff)
  }

  dropAction(id) {
    this.q('delete from actions where id = ?').run(id)
  }
}

function decodeActivity(a) {
  return { ...a, files: json(a.files, []), commands: json(a.commands, []) }
}

function decodeDrawback(d) {
  return {
    id: d.id, projectId: d.project_id, reviewId: d.review_id, text: d.text || '', detail: d.detail || '', status: d.status,
    resolvedByReviewId: d.resolved_by_review_id || null, resolvedNote: d.resolved_note || null,
    createdAt: d.created_at, updatedAt: d.updated_at,
  }
}

function decodeRec(r) {
  return {
    id: r.id, projectId: r.project_id, reviewId: r.review_id, title: r.title || '', why: r.why || '', benefit: r.benefit || '',
    drawback: r.drawback || '', priority: r.priority || 'medium', effort: r.effort || 'medium', explore: r.explore || '',
    simple: r.simple || '', connection: r.connection || '', addressesDrawbackId: r.addresses_drawback_id || null,
    status: r.status, completedHow: r.completed_how || null, completedEvidence: r.completed_evidence || null,
    createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at || null,
  }
}
