// The codex-live sidecar's own sign-in: PKCE, the authorize URL, token
// responses, refresh decisions and the credentials file. Synthetic tokens
// only; no network.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AUTHORIZE_URL,
  CLIENT_ID,
  REDIRECT_URI,
  accountIdFromJwt,
  base64url,
  buildAuthorizeUrl,
  createPkce,
  credentialStatus,
  credentialsPath,
  deleteCredentials,
  getAccess,
  loadCredentials,
  needsRefresh,
  parseAuthorizationInput,
  parseTokenResponse,
  redact,
  saveCredentials,
} from '../../scripts/codex-live/auth.mjs'

// A JWT-shaped token (unsigned) carrying a ChatGPT account id claim.
const jwt = (claims) =>
  ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part, at) => (at < 2 ? Buffer.from(part).toString('base64url') : part)).join('.')
const ACCESS = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } })
const REFRESH = 'refresh-synthetic-0001'

test('PKCE: a 43-char base64url verifier and its S256 challenge', async () => {
  const { verifier, challenge } = await createPkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.equal(base64url(new Uint8Array([251, 255, 0])), '-_8A')
})

test('the authorize URL carries the Codex client, PKCE and the local redirect', () => {
  const url = new URL(buildAuthorizeUrl({ challenge: 'chal', state: 'st4te' }))
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL)
  const params = Object.fromEntries(url.searchParams)
  assert.deepEqual(params, {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    code_challenge: 'chal',
    code_challenge_method: 'S256',
    state: 'st4te',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'live-voice',
  })
  assert.equal(REDIRECT_URI, 'http://localhost:1455/auth/callback')
})

test('a pasted redirect URL, code#state, query or bare code all parse', () => {
  assert.deepEqual(parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseAuthorizationInput('abc#xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseAuthorizationInput('code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseAuthorizationInput('  abc  '), { code: 'abc' })
  assert.deepEqual(parseAuthorizationInput('   '), {})
})

test('the JWT account id claim is read, anything else is undefined', () => {
  assert.equal(accountIdFromJwt(ACCESS), 'acct-123')
  assert.equal(accountIdFromJwt(jwt({ sub: 'x' })), undefined)
  assert.equal(accountIdFromJwt('not-a-jwt'), undefined)
  assert.equal(accountIdFromJwt('a.%%%.c'), undefined)
})

test('a good token response becomes credentials expiring expires_in later', () => {
  const body = JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, id_token: 'idtok' })
  assert.deepEqual(parseTokenResponse(200, body, 'exchange', 1_000), {
    type: 'oauth',
    access: ACCESS,
    refresh: REFRESH,
    expires: 1_000 + 3_600_000,
    accountId: 'acct-123',
  })
})

test('token errors never carry the response body or a token', () => {
  const leaky = JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH })
  for (const [status, body] of [
    [200, leaky], // missing expires_in
    [400, leaky],
    [401, `{"error":"invalid_grant","error_description":"${REFRESH}"}`],
    [500, `<html>${ACCESS}</html>`],
    [200, 'not json'],
  ]) {
    assert.throws(
      () => parseTokenResponse(status, body, 'refresh', 0),
      error => {
        assert.ok(!error.message.includes(ACCESS), error.message)
        assert.ok(!error.message.includes(REFRESH), error.message)
        assert.ok(!error.message.includes('description'), error.message)
        assert.match(error.message, /^Codex token refresh /)
        return true
      },
    )
  }
  // An OAuth error code is safe to say.
  assert.throws(() => parseTokenResponse(401, '{"error":"invalid_grant"}', 'refresh', 0), /\(401\): invalid_grant$/)
  // A token without the account claim is refused, without the token.
  const noAccount = jwt({ sub: 'x' })
  assert.throws(
    () => parseTokenResponse(200, JSON.stringify({ access_token: noAccount, refresh_token: REFRESH, expires_in: 1 }), 'exchange', 0),
    error => !error.message.includes(noAccount) && /account/.test(error.message),
  )
})

test('redact hides JWT-shaped and long opaque strings', () => {
  assert.equal(redact(`token ${ACCESS} end`), 'token [redacted] end')
  assert.equal(redact('Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789'), 'Bearer [redacted]')
  assert.equal(redact('call failed (404): not found'), 'call failed (404): not found')
})

test('refresh is due a minute before expiry; status reads the file state', () => {
  const creds = { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 100_000, accountId: 'acct-123' }
  assert.equal(needsRefresh(creds, 30_000), false)
  assert.equal(needsRefresh(creds, 40_000), true)
  assert.equal(needsRefresh(creds, 200_000), true)
  assert.equal(credentialStatus(creds, 30_000), 'signed-in')
  assert.equal(credentialStatus(creds, 200_000), 'expired')
  assert.equal(credentialStatus(undefined, 0), 'signed-out')
})

test('the credentials path follows XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/a' }), '/x/cfg/live-voice/codex-auth.json')
  assert.equal(credentialsPath({ HOME: '/home/a' }), '/home/a/.config/live-voice/codex-auth.json')
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: '', HOME: '/home/a' }), '/home/a/.config/live-voice/codex-auth.json')
})

test('credentials are saved 0600 in a 0700 directory, read back, and deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-auth-'))
  try {
    const dir = join(root, 'live-voice')
    await mkdir(dir, { mode: 0o755 })
    await chmod(dir, 0o755)
    const path = join(dir, 'codex-auth.json')
    const creds = { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 5, accountId: 'acct-123' }
    await saveCredentials(path, creds)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.deepEqual(await loadCredentials(path), creds)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), creds)
    // A broken or foreign file reads as signed out.
    await writeFile(path, '{"access":1}')
    assert.equal(await loadCredentials(path), undefined)
    await writeFile(path, 'garbage')
    assert.equal(await loadCredentials(path), undefined)
    await deleteCredentials(path)
    assert.equal(await loadCredentials(path), undefined)
    await deleteCredentials(path) // twice is fine
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('getAccess refreshes an expiring token, saves it, and never refreshes a fresh one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-auth-'))
  try {
    const path = join(root, 'live-voice', 'codex-auth.json')
    await saveCredentials(path, { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 100_000, accountId: 'acct-123' })
    const calls = []
    const NEW = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' }, n: 2 })
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: String(init.body) })
      return new Response(JSON.stringify({ access_token: NEW, refresh_token: 'refresh-2', expires_in: 100 }), { status: 200 })
    }
    assert.deepEqual(await getAccess(path, { fetch: fetchImpl, now: () => 0 }), { accessToken: ACCESS, accountId: 'acct-123' })
    assert.equal(calls.length, 0)
    assert.deepEqual(await getAccess(path, { fetch: fetchImpl, now: () => 99_990 }), { accessToken: NEW, accountId: 'acct-123' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token')
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: CLIENT_ID,
    })
    const saved = await loadCredentials(path)
    assert.equal(saved.refresh, 'refresh-2')
    assert.equal(saved.expires, 99_990 + 100_000)
    // Signed out: a clear error, no request.
    await deleteCredentials(path)
    await assert.rejects(getAccess(path, { fetch: fetchImpl, now: () => 0 }), /not signed in/)
    assert.equal(calls.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
