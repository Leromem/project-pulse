// The mod against the engine itself (claude plugin test). The hooks registered with `on` here
// stand for the engine and the Pulse service beneath the plugin.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Call = { path: string; body: any }
type Replies = Record<string, (body: any) => unknown>

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const REVIEW = JSON.stringify({ reviews: [{ project_id: 'p1', title: 'Added pricing', status: 'needs-testing' }] })

function world(on: On, replies: Replies, env: Record<string, string> = {}, fork?: () => unknown) {
  const calls: Call[] = []
  const forks: string[] = []
  const fills: { text: string; mode?: string }[] = []
  const toasts: string[] = []
  mock.env(on, { USERPROFILE: 'C:\\Users\\me', ...env })
  const clock = mock.clock(on, { now: 1_000_000 })
  // Ops on `$` answer { value }; the engine's events answer their result.
  on('fs.read', ($, e) => ({ value: e.path.endsWith('token') ? 'tok\n' : '{"port":47821}' }))
  on('http.fetch', ($, e) => {
    const path = e.url.replace('http://127.0.0.1:47821', '')
    const body = e.init?.body ? JSON.parse(e.init.body) : null
    calls.push({ path, body })
    const out = replies[path] ? replies[path](body) : {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(out) } }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:\\code\\app' }))
  on('session.model', () => ({ value: 'opus' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: (fork ? fork() : { isAnswered: true, text: REVIEW, usage: USAGE }) as never }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: { filePath: 'x' } as never, isError: false }) as never)
  return { calls, forks, fills, toasts, clock }
}

const paths = (calls: Call[]) => calls.map(c => c.path)

async function start($: any) {
  await $.session.start({ cwd: 'C:\\code\\app', surface: null, isInteractive: true })
}

async function finishedTurn($: any, text = 'Add pricing', id = 't1') {
  await $.turn.start({ text, turnId: id })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\code\\app\\pricing.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.turn.complete({ answer: 'Done: pricing added, tests pass.', durationMs: 10, isAborted: false, turnId: id, reason: 'answer' })
}

const SCHEDULING: Replies = {
  '/api/hook/activity': () => ({ schedule: true, settleMs: 60_000, meaningful: true }),
  '/api/hook/review-context': () => ({ prompt: 'REVIEW PROMPT', projectIds: ['p1'], jobIds: ['j1'] }),
  '/api/hook/review': () => ({ reviews: [{ id: 'rv1', projectId: 'p1', title: 'Added pricing' }] }),
  '/api/hook/heartbeat': () => ({ actions: [] }),
}

test('a finished task reports its files, then is reviewed only after the quiet time', async ($, on) => {
  const w = world(on, SCHEDULING)
  await start($)
  await finishedTurn($)
  const activity = w.calls.find(c => c.path === '/api/hook/activity')
  expect(activity?.body.files).toEqual([{ path: 'C:\\code\\app\\pricing.ts', op: 'edit' }])
  expect(activity?.body.commands).toEqual([{ cmd: 'npm test', isError: false }])
  expect(activity?.body.prompt).toBe('Add pricing')
  expect(activity?.body.reason).toBe('answer')

  await w.clock.advance(59_000)
  expect(paths(w.calls)).not.toContain('/api/hook/review-context')
  await w.clock.advance(2_000)
  expect(w.forks).toEqual(['REVIEW PROMPT'])
  const posted = w.calls.find(c => c.path === '/api/hook/review')
  expect(posted?.body.jobIds).toEqual(['j1'])
  expect(posted?.body.text).toBe(REVIEW)
  expect(w.toasts.some(t => t.includes('Added pricing'))).toBe(true)
})

test('a new prompt before the quiet time ends means work goes on: no review yet', async ($, on) => {
  const w = world(on, SCHEDULING)
  await start($)
  await finishedTurn($)
  await w.clock.advance(30_000)
  await $.turn.start({ text: 'also add a currency switch', turnId: 't2' })
  await w.clock.advance(120_000)
  expect(w.forks).toEqual([])
  expect(paths(w.calls)).not.toContain('/api/hook/review-context')
})

test('when the service says not to schedule (no changes, or reviews off), nothing is reviewed', async ($, on) => {
  const w = world(on, { ...SCHEDULING, '/api/hook/activity': () => ({ schedule: false, settleMs: 60_000 }) })
  await start($)
  await finishedTurn($)
  await w.clock.advance(600_000)
  expect(w.forks).toEqual([])
})

test('Discuss in Claude only fills the prompt box; it never sends', async ($, on) => {
  let given = false
  const w = world(on, {
    ...SCHEDULING,
    '/api/hook/heartbeat': () => {
      if (given) return { actions: [] }
      given = true
      return { actions: [{ id: 'a1', kind: 'discuss', projectId: 'p1', prompt: 'Recommendation: Allow manual starting bids' }] }
    },
  })
  await start($)
  await w.clock.advance(10_500)
  expect(w.fills).toEqual([{ text: 'Recommendation: Allow manual starting bids', mode: 'replace' }])
  expect(w.toasts.some(t => t.includes('prompt box'))).toBe(true)
})

test('a failed in-session review hands the job back to the service', async ($, on) => {
  const w = world(on, SCHEDULING, {}, () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE }))
  await start($)
  await finishedTurn($)
  await w.clock.advance(61_000)
  const failed = w.calls.find(c => c.path === '/api/hook/review-failed')
  expect(failed?.body).toEqual({ sessionId: 'sess-1', jobIds: ['j1'], reason: 'api-error' })
})

test('ending the session hands unreviewed work to the service', async ($, on) => {
  const w = world(on, SCHEDULING)
  await start($)
  await finishedTurn($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { sessionId: 'sess-1' } as never })
  expect(w.calls.find(c => c.path === '/api/hook/session-end')?.body).toEqual({ sessionId: 'sess-1', reason: 'prompt_input_exit' })
  await w.clock.advance(120_000)
  expect(w.forks).toEqual([])
})

test('PROJECT_PULSE_DISABLE turns the mod off (used by Pulse’s own headless runs)', async ($, on) => {
  const w = world(on, SCHEDULING, { PROJECT_PULSE_DISABLE: '1' })
  await start($)
  await finishedTurn($)
  await w.clock.advance(120_000)
  expect(w.calls).toEqual([])
})

test('/pulse reviews now, and /pulse status, on and off talk to the service', async ($, on) => {
  const w = world(on, { ...SCHEDULING, '/api/hook/control': body => ({ text: `did ${body.command}` }) })
  await start($)
  await finishedTurn($)
  const review = await $.command.run({ command: 'pulse', args: '' })
  expect(review.text).toContain('reviewing')
  await w.clock.advance(100)
  expect(w.calls.find(c => c.path === '/api/hook/review-context')?.body).toEqual({ sessionId: 'sess-1', trigger: 'manual', force: true })
  expect(w.forks).toEqual(['REVIEW PROMPT'])
  expect((await $.command.run({ command: 'pulse', args: 'off' })).text).toBe('did off')
  expect((await $.command.run({ command: 'pulse', args: 'status' })).text).toBe('did status')
  expect((await $.command.run({ command: 'pulse', args: 'nonsense' })).text).toContain('Usage')
})
