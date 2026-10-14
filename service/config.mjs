// Paths, port and the local access token. PROJECT_PULSE_HOME moves everything (tests use it).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '1.0.0'
export const HOME = process.env.PROJECT_PULSE_HOME || path.join(os.homedir(), '.project-pulse')
export const DATA_DIR = path.join(HOME, 'data')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
export const DB_FILE = path.join(DATA_DIR, 'pulse.db')
export const TOKEN_FILE = path.join(DATA_DIR, 'token')
export const SERVICE_FILE = path.join(DATA_DIR, 'service.json')
export const BROWSER_PROFILE = path.join(DATA_DIR, 'window-profile')
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const UI_DIR = path.join(APP_DIR, 'ui')
export const PORT = Number(process.env.PROJECT_PULSE_PORT || 47821)

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true })
}

export function loadToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[a-f0-9]{32,}$/.test(token)) return token
  } catch {}
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

export function writeServiceFile(info) {
  fs.writeFileSync(SERVICE_FILE, JSON.stringify(info, null, 2))
}
