// The codex-live sidecar's own ChatGPT sign-in, ported from Pi's OpenAI Codex
// OAuth flow (pi-ai `auth/oauth/openai-codex.js`): PKCE in the browser with a
// local callback on port 1455, a device code fallback, and refresh. The
// credentials live in this plugin's own file; no other application's file is
// ever read. Nothing here prints or logs a token, and no error carries a
// response body (a token endpoint's body can hold tokens).

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
export const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
export const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
export const REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = '/auth/callback'
export const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
export const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
export const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
// Who asks, as the authorize URL names it (Pi names itself the same way).
const ORIGINATOR = 'live-voice'
// Refresh this long before the access token expires.
const REFRESH_MARGIN_MS = 60_000

/** Bytes as base64url without padding. */
export function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/** A PKCE verifier (32 random bytes) and its S256 challenge. */
export async function createPkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** A random state for the authorize request. */
export function createState() {
  return randomBytes(16).toString('hex')
}

/** The browser sign-in URL, as Pi builds it. */
export function buildAuthorizeUrl({ challenge, state, originator = ORIGINATOR }) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)

  return url.toString()
}

/** A pasted redirect URL, `code#state`, a query string or a bare code. */
export function parseAuthorizationInput(input) {
  const value = String(input ?? '').trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return pick(url.searchParams.get('code'), url.searchParams.get('state'))
  } catch {
    // Not a URL.
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return pick(code, state)
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return pick(params.get('code'), params.get('state'))
  }

  return { code: value }
}

const pick = (code, state) => ({ ...(code ? { code } : {}), ...(state ? { state } : {}) })

/** The ChatGPT account id in an access token's claims, or undefined. */
export function accountIdFromJwt(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/** Hides JWT-shaped and long opaque strings, so an error can be shown. */
export function redact(text) {
  return String(text)
    .replace(/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
}

// An OAuth error code (`invalid_grant`) is safe to say; nothing else of a body is.
function oauthErrorCode(body) {
  try {
    const error = JSON.parse(body)?.error
    const code = typeof error === 'object' && error !== null ? error.code : error
    return typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Credentials from a token endpoint's answer, expiring `expires_in` after
 * `now`. Throws an error naming only the status and an OAuth error code.
 */
export function parseTokenResponse(status, body, operation, now) {
  const prefix = `Codex token ${operation}`
  if (status < 200 || status >= 300) {
    const code = oauthErrorCode(body)
    throw new Error(`${prefix} failed (${status})${code ? `: ${code}` : ''}`)
  }
  let json
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`${prefix} returned a response that is not JSON`)
  }
  if (typeof json?.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error(`${prefix} response is missing access_token, refresh_token or expires_in`)
  }
  const accountId = accountIdFromJwt(json.access_token)
  if (!accountId) throw new Error(`${prefix} returned a token without a ChatGPT account id`)

  return { type: 'oauth', access: json.access_token, refresh: json.refresh_token, expires: now + json.expires_in * 1000, accountId }
}

/** Whether the access token expires within the refresh margin. */
export function needsRefresh(creds, now) {
  return now + REFRESH_MARGIN_MS >= creds.expires
}

/** `signed-in`, `expired` (a refresh will be tried) or `signed-out`. */
export function credentialStatus(creds, now) {
  if (!creds) return 'signed-out'
  return now >= creds.expires ? 'expired' : 'signed-in'
}

/** `${XDG_CONFIG_HOME:-~/.config}/live-voice/codex-auth.json`. */
export function credentialsPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(env.HOME ?? '', '.config')

  return join(base, 'live-voice', 'codex-auth.json')
}

const isCredentials = value =>
  typeof value === 'object' &&
  value !== null &&
  value.type === 'oauth' &&
  typeof value.access === 'string' &&
  typeof value.refresh === 'string' &&
  typeof value.expires === 'number' &&
  typeof value.accountId === 'string'

/** The saved credentials, or undefined (no file, unreadable, or not ours). */
export async function loadCredentials(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return isCredentials(value)
      ? { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires, accountId: value.accountId }
      : undefined
  } catch {
    return undefined
  }
}

/** Saves the credentials atomically: file 0600, directory 0700. */
export async function saveCredentials(path, creds) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(creds)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

/** Forgets the credentials. */
export async function deleteCredentials(path) {
  await rm(path, { force: true })
}

async function postForm(fetchImpl, url, form, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal,
  })

  return { status: response.status, body: await response.text().catch(() => '') }
}

/** Trades an authorization code for credentials. */
export async function exchangeCode({ code, verifier, redirectUri = REDIRECT_URI, fetch: fetchImpl = fetch, now = Date.now, signal }) {
  const { status, body } = await postForm(
    fetchImpl,
    TOKEN_URL,
    { grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri },
    signal,
  )

  return parseTokenResponse(status, body, 'exchange', now())
}

/** New credentials from the refresh token. */
export async function refreshCredentials(creds, { fetch: fetchImpl = fetch, now = Date.now, signal } = {}) {
  let answer
  try {
    answer = await postForm(fetchImpl, TOKEN_URL, { grant_type: 'refresh_token', refresh_token: creds.refresh, client_id: CLIENT_ID }, signal)
  } catch (error) {
    throw new Error(`Codex token refresh error: ${redact(error instanceof Error ? error.message : String(error))}`)
  }

  return parseTokenResponse(answer.status, answer.body, 'refresh', now())
}

/**
 * A valid access token and account id: the saved one, or a refreshed one
 * (saved before it is returned) when it expires within a minute.
 */
export async function getAccess(path, { fetch: fetchImpl = fetch, now = Date.now, signal } = {}) {
  let creds = await loadCredentials(path)
  if (!creds) throw new Error('Codex: not signed in, run /live-config codex login')
  if (needsRefresh(creds, now())) {
    creds = await refreshCredentials(creds, { fetch: fetchImpl, now, signal })
    await saveCredentials(path, creds)
  }

  return { accessToken: creds.access, accountId: creds.accountId }
}

/** Starts a device code sign-in: the code the person types, and how often to poll. */
export async function startDeviceAuth({ fetch: fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error('Codex device code login is not enabled; use the browser login.')
    throw new Error(`Codex device code request failed (${response.status})`)
  }
  const json = await response.json().catch(() => undefined)
  const interval = typeof json?.interval === 'string' ? Number(json.interval.trim()) : json?.interval
  if (typeof json?.device_auth_id !== 'string' || typeof json.user_code !== 'string' || !Number.isFinite(interval) || interval < 0) {
    throw new Error('Codex device code response is not valid')
  }

  return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds: interval }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Login cancelled'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Login cancelled'))
    }, { once: true })
  })

/** Polls a device code sign-in until it is approved, then trades it for credentials. */
export async function finishDeviceAuth(device, { fetch: fetchImpl = fetch, now = Date.now, signal } = {}) {
  const deadline = now() + DEVICE_CODE_TIMEOUT_MS
  let intervalMs = Math.max(1000, Math.floor((device.intervalSeconds || 5) * 1000))
  while (now() < deadline) {
    const response = await fetchImpl(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
    })
    if (response.ok) {
      const json = await response.json().catch(() => undefined)
      if (typeof json?.authorization_code !== 'string' || typeof json.code_verifier !== 'string') {
        throw new Error('Codex device auth response is not valid')
      }
      return exchangeCode({ code: json.authorization_code, verifier: json.code_verifier, redirectUri: DEVICE_REDIRECT_URI, fetch: fetchImpl, now, signal })
    }
    const body = await response.text().catch(() => '')
    const code = oauthErrorCode(body)
    if (response.status === 403 || response.status === 404 || code === 'deviceauth_authorization_pending') {
      // Still waiting for the person.
    } else if (code === 'slow_down') {
      intervalMs += 5000
    } else {
      throw new Error(`Codex device auth failed (${response.status})${code ? `: ${code}` : ''}`)
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal)
  }
  throw new Error('Codex device code sign-in timed out')
}
