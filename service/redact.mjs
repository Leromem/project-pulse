// Removes secrets from any text Pulse stores, shows or sends to a model.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted key]'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{12,}/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted key]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, '$1 [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [
    /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)(?:[_-][A-Za-z0-9]+)*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    '$1$2[redacted]',
  ],
]

export function redact(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export function redactDeep(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = redactDeep(inner)
    return out
  }
  return value
}
