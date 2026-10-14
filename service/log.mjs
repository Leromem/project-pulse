// Diagnostic log: data/logs/pulse.log, rotated at 1 MB, three old files kept.
import fs from 'node:fs'
import path from 'node:path'
import { LOG_DIR } from './config.mjs'
import { redact } from './redact.mjs'

export const LOG_FILE = path.join(LOG_DIR, 'pulse.log')
const MAX_BYTES = 1024 * 1024

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return
    for (let i = 2; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`)
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {}
}

function write(level, message, extra) {
  const detail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra))
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(message + detail)}\n`
  try {
    rotate()
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
  if (process.env.PROJECT_PULSE_LOG_STDOUT) process.stdout.write(line)
}

export const log = {
  info: (message, extra) => write('INFO', message, extra),
  warn: (message, extra) => write('WARN', message, extra),
  error: (message, extra) => write('ERROR', message, extra),
}

export function tail(lines = 150) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    return text.split('\n').slice(-lines - 1).join('\n')
  } catch {
    return ''
  }
}
