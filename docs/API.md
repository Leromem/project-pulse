# Project Pulse — local API contract

The Pulse service listens on `http://127.0.0.1:47821` (port from `data/service.json`).
Everything is JSON. Every `/api/*` call needs the token:

- header `X-Pulse-Token: <token>`, or
- query `?t=<token>` (only for `GET /api/events` and `POST /api/window/state`, which use EventSource / sendBeacon).

The window is opened at `/?t=<token>&project=<projectId>`. The page keeps the token in
`sessionStorage`, then strips it from the URL with `history.replaceState`.

Requests from another `Origin`, or with a `Host` other than `127.0.0.1:<port>` / `localhost:<port>`, are refused.

## Shapes

```ts
type Status = 'completed' | 'partial' | 'needs-testing' | 'blocked' | 'no-changes'

type Project = {
  id: string; name: string; path: string
  createdAt: string; lastActivityAt: string | null; lastReviewAt: string | null
  counts: { suggested: number; planned: number; openDrawbacks: number; reviews: number }
  live: boolean                     // a Claude Code session for it reported in the last 60 s
  job: Job | null                   // a review being written right now
  autoReviews: boolean              // effective setting
}

type Job = { id: string; state: 'queued' | 'running' | 'failed'; trigger: string; startedAt: string | null; error: string | null }

type ReviewSummary = {
  id: string; createdAt: string; title: string; status: Status
  state: 'ready' | 'failed'; trigger: 'task-complete' | 'session-end' | 'manual' | 'retry'
  source: 'claude-code' | 'claude-desktop' | 'pulse-window'
}

type Review = ReviewSummary & {
  projectId: string; sessionId: string | null
  statusReason: string             // evidence for the status, one line
  built: string[]                  // "What you just built"
  benefits: string[]
  drawbacks: Drawback[]            // introduced by this review
  evidence: string[]               // what the review is based on
  recommendations: Recommendation[]// suggested by this review (current status included)
  resolved: { drawbackId: string; note: string; text: string }[]           // older drawbacks this work fixed
  implemented: { recommendationId: string; evidence: string; title: string }[] // older suggestions this work did
  error: string | null             // when state === 'failed'
}

type Drawback = {
  id: string; projectId: string; reviewId: string
  text: string; detail: string
  status: 'open' | 'resolved' | 'accepted'
  resolvedByReviewId: string | null; resolvedNote: string | null
  createdAt: string; updatedAt: string
}

type Recommendation = {
  id: string; projectId: string; reviewId: string
  title: string; why: string; benefit: string; drawback: string
  priority: 'high' | 'medium' | 'low'; effort: 'small' | 'medium' | 'large'
  explore: string                  // "Explore": the longer explanation
  simple: string                   // "Ask Why": plain-language version
  connection: string               // how it links to the work / drawback
  addressesDrawbackId: string | null
  status: 'suggested' | 'planned' | 'dismissed' | 'completed'
  completedHow: 'detected' | 'tested' | 'tests-pass' | 'reviewed' | null
  completedEvidence: string | null
  createdAt: string; updatedAt: string; decidedAt: string | null
}

type Link = {
  id: string; projectId: string
  fromType: 'review' | 'drawback' | 'recommendation'; fromId: string
  toType: 'review' | 'drawback' | 'recommendation'; toId: string
  relation: 'introduced' | 'addresses' | 'resolved' | 'implemented' | 'suggested'
  note: string; createdAt: string
}

type Decision = { id: string; projectId: string; recommendationId: string | null; drawbackId: string | null; action: string; note: string; at: string }

type Settings = {
  autoReviews: boolean          // default true
  autoOpenWindow: boolean       // default true
  maxRecommendations: 1 | 2 | 3 // default 3
  detail: 'brief' | 'standard' | 'detailed' // default 'brief'
  notifications: boolean        // default true
  animations: boolean           // default true
  theme: 'system' | 'dark' | 'light'
  openWhileTyping: boolean      // default false: the window waits until you pause typing
  settleSeconds: number         // quiet time after a finished task before the review, default 90
  reviewModel: string           // model for reviews written outside a live session, default 'sonnet'
  workspaces: string[]          // folders that hold several projects
}
// Per-project overrides: any of autoReviews, autoOpenWindow, maxRecommendations, detail, notifications; null = use global.
```

## Read

| Call | Answer |
| --- | --- |
| `GET /api/health` | `{ ok, version, port }` (no token needed) |
| `GET /api/projects` | `Project[]`, most recent activity first |
| `GET /api/projects/:id` | `{ project, settings: { effective, overrides }, latestReview: Review \| null, reviews: ReviewSummary[], recommendations: Recommendation[], drawbacks: Drawback[], links: Link[], decisions: Decision[] }` |
| `GET /api/reviews/:id` | `Review` |
| `GET /api/settings` | `{ global: Settings, defaults: Settings }` |
| `GET /api/diagnostics` | `{ version, port, dataDir, logFile, logTail: string, jobs: Job[] }` |

## Act

| Call | Body | Answer |
| --- | --- | --- |
| `POST /api/projects/:id/review` | `{}` | `{ mode: 'live-session' \| 'headless' \| 'none', message }` — "Review now" |
| `POST /api/reviews/:id/retry` | `{}` | `{ mode, message }` |
| `POST /api/recommendations/:id/action` | `{ action: 'plan' \| 'unplan' \| 'dismiss' \| 'restore' \| 'complete', how?: 'tested' \| 'tests-pass' \| 'reviewed', note? }` | `{ recommendation }` |
| `POST /api/recommendations/:id/discuss` | `{}` | `{ mode: 'sent-to-claude-code' \| 'copy', prompt, message }` |
| `GET /api/recommendations/:id/prompt` | — | `{ prompt }` — preview of the Discuss prompt; logs nothing, queues nothing (404 for an unknown id) |
| `POST /api/drawbacks/:id/action` | `{ action: 'accept' \| 'reopen' \| 'resolve', note? }` | `{ drawback }` |
| `PUT /api/settings` | partial `Settings` | `{ global }` |
| `PUT /api/projects/:id/settings` | `{ overrides }` (null value = inherit) | `{ effective, overrides }` |
| `DELETE /api/projects/:id` | — | `{ ok }` forget a project and its history |
| `POST /api/window/state` | `{ visible, focused, bounds: { x, y, w, h }, projectId }` (token in query) | `{ ok }` |
| `POST /api/diagnostics/open-log` | `{}` | `{ ok }` opens the log folder in the file manager (Explorer, Finder or the Linux default) |

Nothing here runs code from recommendation text. "Discuss in Claude" only places text in a prompt box; you send it.

## Live updates: `GET /api/events?t=<token>` (Server-Sent Events)

| event | data |
| --- | --- |
| `hello` | `{ version }` |
| `project` | `{ projectId }` — reload that project |
| `review` | `{ projectId, reviewId, title }` — a new review is ready |
| `job` | `{ projectId, state: 'queued' \| 'running' \| 'done' \| 'failed', error? }` |
| `settings` | `{}` |
| `focus` | `{ projectId }` — show this project (from `/pulse open`) |

## Used by the Claude Code mod and the MCP server

| Call | Purpose |
| --- | --- |
| `POST /api/hook/activity` | one finished turn: `{ sessionId, cwd, seq, prompt, answer, reason, files: [{ path, op }], commands: [{ cmd, isError }] }` → `{ meaningful, schedule: boolean, settleMs }` |
| `POST /api/hook/session-end` | `{ sessionId, reason }` → `{ queued: boolean }` |
| `POST /api/hook/heartbeat` | `{ sessionId, cwd }` → `{ actions: [{ id, kind: 'review' \| 'discuss' \| 'open', projectId, prompt? }] }` |
| `POST /api/hook/review-context` | `{ sessionId, projectId?, force? }` → `{ prompt, projectIds, toSeq }` or `{ nothing: true, message }` |
| `POST /api/hook/review` | `{ sessionId, trigger, toSeq, projectIds, text }` (the model's raw reply) → `{ reviews: [{ id, projectId, title }] }` |
| `POST /api/hook/review-failed` | `{ sessionId, trigger, projectIds, reason }` → `{ queued }` (falls back to a headless review) |
| `POST /api/mcp/prepare-review` | `{ projectPath?, projectId?, projectName? }` → `{ projectId, instructions, openItems }` |
| `POST /api/mcp/submit-review` | `{ projectId, review }` → `{ reviewId }` |
