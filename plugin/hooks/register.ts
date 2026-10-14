// Project Pulse for Claude Code: notices when a development task is finished, asks the session
// for a short review (a tool-less fork of its own transcript) and hands it to the local Pulse
// service, which shows it in the Pulse window. It never edits files or sends prompts by itself.
import type { Register } from 'claude-code'

type FileTouch = { path: string; op: string }
type Command = { cmd: string; isError: boolean }
type Turn = { prompt: string; files: FileTouch[]; commands: Command[] }
type Action = { id: string; kind: 'review' | 'discuss' | 'generate' | 'open'; projectId?: string; prompt?: string; jobId?: string; model?: string }
type Conn = { base: string; token: string }
type Trigger = 'task-complete' | 'manual'
type Ops = {
  call: <T = any>(path: string, body: unknown) => Promise<T | null>
  ensureService: () => Promise<void>
  runReview: (trigger: Trigger, options: { force: boolean; projectId?: string }) => Promise<string>
  schedule: (ms: number) => void
  reviewLater: () => void
}

const HEARTBEAT_MS = 10_000
const fresh = (prompt = ''): Turn => ({ prompt, files: [], commands: [] })

export const register: Register = on => {
  let disabled = false
  let turn: Turn = fresh()
  let timer: { cancel(): void } | null = null
  // Built in session.start: every helper closes over that hook's own `$`, which keeps
  // working for the timers and heartbeat that outlive it.
  let ops: Ops | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (await $.env.get('PROJECT_PULSE_DISABLE')) {
      disabled = true
      return started
    }
    let conn: Conn | null = null
    let lastStartAttempt = 0
    let reviewing = false
    let beating = false

    const home = async (): Promise<string> => {
      const custom = await $.env.get('PROJECT_PULSE_HOME')
      if (custom) return custom
      const profile = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
      return `${profile}\\.project-pulse`
    }

    const connection = async (): Promise<Conn | null> => {
      if (conn) return conn
      try {
        const dir = await home()
        const token = (await $.fs.read(`${dir}\\data\\token`)).trim()
        let port = 47821
        try {
          port = Number(JSON.parse(await $.fs.read(`${dir}\\data\\service.json`)).port) || port
        } catch {}
        conn = { base: `http://127.0.0.1:${port}`, token }
        return conn
      } catch {
        return null
      }
    }

    const call = async <T = any>(path: string, body: unknown): Promise<T | null> => {
      const c = await connection()
      if (!c) return null
      try {
        const res = await $.http.fetch(c.base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pulse-Token': c.token },
          body: JSON.stringify(body),
        })
        if (res.status === 401) conn = null
        return res.ok ? (JSON.parse(res.text) as T) : null
      } catch {
        return null
      }
    }

    // Starts the Pulse service when it is not running (at most once a minute).
    const ensureService = async (): Promise<void> => {
      try {
        const res = await $.http.fetch(`${(await connection())?.base ?? 'http://127.0.0.1:47821'}/api/health`)
        if (res.ok) return
      } catch {}
      const at = await $.clock.now()
      if (at - lastStartAttempt < 60_000) return
      lastStartAttempt = at
      try {
        await $.process.run(['wscript.exe', '//B', '//Nologo', `${await home()}\\app\\bin\\start-service.vbs`], { timeoutMs: 15_000 })
        conn = null
      } catch (err) {
        $.ui.log(`Project Pulse could not start its service: ${String(err)}`, { to: 'debug' })
      }
    }

    const runReview = async (trigger: Trigger, options: { force: boolean; projectId?: string }): Promise<string> => {
      if (reviewing) return 'A Project Pulse review is already being written.'
      reviewing = true
      try {
        const sessionId = await $.session.id()
        const ctx = await call('/api/hook/review-context', { sessionId, trigger, force: options.force, projectId: options.projectId })
        if (!ctx) {
          await ensureService()
          return 'Project Pulse is starting up. Try /pulse again in a few seconds.'
        }
        if (ctx.nothing) return `Project Pulse: ${ctx.message}`
        $.ui.status('Project Pulse is reviewing…')
        const reply = await $.model.fork({ prompt: ctx.prompt })
        if (reply.isAnswered && reply.text.trim()) {
          const saved = await call('/api/hook/review', { sessionId, jobIds: ctx.jobIds, text: reply.text, model: await $.session.model() })
          const titles: string[] = (saved?.reviews ?? []).map((r: { title: string }) => r.title)
          if (titles.length) {
            $.ui.toast(`Project Pulse: ${titles.join(' · ')}`, { timeoutMs: 6000 })
            return `Project Pulse review ready: ${titles.join('; ')}. It's in the Pulse window (/pulse open).`
          }
          return 'Project Pulse could not read that review, so it is writing it again from the session log.'
        }
        const reason = reply.isAnswered ? 'empty-reply' : reply.reason
        await call('/api/hook/review-failed', { sessionId, jobIds: ctx.jobIds, reason })
        return `Project Pulse could not review in-session (${reason}); it will write the review from the session log instead.`
      } finally {
        reviewing = false
        $.ui.status(undefined)
      }
    }

    const act = async (action: Action): Promise<void> => {
      if (action.kind === 'review') {
        $.ui.toast(await runReview('manual', { force: true, projectId: action.projectId }), { timeoutMs: 6000 })
      } else if (action.kind === 'discuss' && action.prompt) {
        // Only places text in the prompt box; the person decides whether to send it.
        const box = await $.prompt.read()
        const hasDraft = box.text.trim() !== ''
        await $.prompt.fill({ text: hasDraft ? `\n\n${action.prompt}` : action.prompt, mode: hasDraft ? 'append' : 'replace' })
        $.ui.toast('Project Pulse added a recommendation to your prompt box. Edit it, or press Enter to discuss it.', { timeoutMs: 8000 })
      } else if (action.kind === 'generate' && action.prompt && action.jobId) {
        const model = action.model || 'sonnet'
        const reply = await $.model.complete({ model, prompt: action.prompt, maxTokens: 4000, timeoutMs: 240_000 })
        await call('/api/hook/generated', {
          jobId: action.jobId,
          text: reply.isAnswered ? reply.text : '',
          error: reply.isAnswered ? undefined : reply.reason,
          model,
        })
      }
    }

    const beat = async (): Promise<void> => {
      if (disabled || beating) return
      beating = true
      try {
        const res = await call<{ actions: Action[] }>('/api/hook/heartbeat', { sessionId: await $.session.id(), cwd: await $.session.cwd(), canGenerate: true })
        if (!res) return void (await ensureService())
        for (const action of res.actions ?? []) {
          await act(action).catch(err => $.ui.log(`Project Pulse action failed: ${String(err)}`, { to: 'debug' }))
        }
      } finally {
        beating = false
      }
    }

    ops = {
      call,
      ensureService,
      runReview,
      // A finished answer that changed files: wait for a quiet spell before calling the task done.
      schedule: ms => {
        timer?.cancel()
        timer = $.clock.after(ms, () => {
          timer = null
          void runReview('task-complete', { force: false })
        })
      },
      // Runs after /pulse returns, so the prompt stays free while the review is written.
      reviewLater: () => {
        $.clock.after(50, () => {
          void runReview('manual', { force: true }).then(text => $.ui.toast(text, { timeoutMs: 8000 }))
        })
      },
    }

    await $.command.register({
      name: 'pulse',
      description: 'Project Pulse: review this session now, open the Pulse window, or turn automatic reviews on/off',
      argumentHint: '[review | open | status | on | off | off all | on all]',
    })
    await ensureService()
    $.clock.every(HEARTBEAT_MS, () => void beat())
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!disabled) {
      // Someone kept working: this is not the end of the task yet.
      timer?.cancel()
      timer = null
      turn = fresh(e.text)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (disabled || ran.deny !== undefined) return ran
    try {
      const tool = String(e.tool)
      if (e.tool === 'Edit' || e.tool === 'Write') {
        if (!ran.isError) turn.files.push({ path: e.file_path, op: tool.toLowerCase() })
      } else if (e.tool === 'NotebookEdit') {
        if (!ran.isError) turn.files.push({ path: e.notebook_path, op: 'notebook' })
      } else if (tool === 'MultiEdit') {
        const path = (e as unknown as { file_path?: string }).file_path
        if (!ran.isError && typeof path === 'string') turn.files.push({ path, op: 'edit' })
      } else if (e.tool === 'Bash' || e.tool === 'PowerShell') {
        turn.commands.push({ cmd: e.command.slice(0, 300), isError: ran.isError === true })
      }
    } catch {}
    return ran
  }).catch(($, e, next) => next(e)) // an observer only: if it ever fails, the tool call goes on untouched

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (disabled || !ops || e.agentId !== undefined) return result
    const done = turn
    turn = fresh()
    try {
      const reply = await ops.call<{ schedule: boolean; settleMs: number }>('/api/hook/activity', {
        sessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        seq: await $.clock.now(),
        prompt: done.prompt,
        answer: e.answer,
        reason: e.reason,
        files: done.files,
        commands: done.commands,
      })
      if (reply?.schedule) ops.schedule(reply.settleMs)
    } catch (err) {
      $.ui.log(`Project Pulse: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (!disabled && ops) {
      timer?.cancel()
      timer = null
      await ops.call('/api/hook/session-end', { sessionId: e.sessionId, reason: e.reason })
    }
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($, e) => {
    if (disabled) return { text: 'Project Pulse is turned off in this session (PROJECT_PULSE_DISABLE).' }
    if (!ops) return { text: 'Project Pulse is still starting. Try again in a moment.' }
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'open') {
      const res = await ops.call('/api/window/open', { cwd: await $.session.cwd() })
      if (!res) {
        await ops.ensureService()
        return { text: 'Starting Project Pulse… run /pulse open again in a few seconds.' }
      }
      return { text: 'Opened the Project Pulse window.' }
    }
    if (['status', 'on', 'off', 'on all', 'off all'].includes(arg)) {
      const res = await ops.call<{ text: string }>('/api/hook/control', { sessionId: await $.session.id(), cwd: await $.session.cwd(), command: arg })
      if (!res) {
        await ops.ensureService()
        return { text: 'Project Pulse is not running yet; it is starting now. Try again in a few seconds.' }
      }
      return { text: res.text }
    }
    if (arg !== '' && arg !== 'review') return { text: 'Usage: /pulse [review | open | status | on | off | off all | on all]' }
    ops.reviewLater()
    return { text: 'Project Pulse is reviewing this session. The review will appear in the Pulse window.' }
  })
}
