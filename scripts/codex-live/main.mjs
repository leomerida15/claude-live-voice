#!/usr/bin/env node
// The live-voice Codex sidecar. Subcommands:
//   login [--device]   sign in with ChatGPT in the browser (PKCE), or with a device code
//   logout             forget this plugin's Codex credentials
//   status             signed-in | expired | signed-out (no secrets)
//   run --commands <dir> [--tag <tag>] [--voice <v>] [--language <code>] [--natives <node_modules>] [--session-id <id>]
// Every subcommand prints JSON lines on stdout. `run` reads its commands from
// numbered JSON files the mod writes into `--commands`. No token is ever printed.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import {
  CALLBACK_PATH,
  CALLBACK_PORT,
  DEVICE_VERIFICATION_URI,
  buildAuthorizeUrl,
  createPkce,
  createState,
  credentialStatus,
  credentialsPath,
  deleteCredentials,
  exchangeCode,
  finishDeviceAuth,
  getAccess,
  loadCredentials,
  parseAuthorizationInput,
  redact,
  saveCredentials,
  startDeviceAuth,
} from './auth.mjs'
import { DEFAULT_MODULES, INSTALL_HINT, loadNatives, runLive } from './live.mjs'
import { DEFAULT_VOICE, LIVE_VOICES, buildInstructions, encodeLine, parseCommand } from './protocol.mjs'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const COMMAND_POLL_MS = 100
// A command file that is still not JSON after this many polls was cut short: dropped.
const COMMAND_PARSE_ATTEMPTS = 20

const emit = value => {
  try {
    process.stdout.write(encodeLine(value))
  } catch {
    // The mod went away.
  }
}
const message = error => redact(error instanceof Error ? error.message : String(error))

function parseArgs(argv) {
  const [command = '', ...rest] = argv
  const flags = {}
  for (let at = 0; at < rest.length; at++) {
    const arg = rest[at]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const value = rest[at + 1]
    if (value === undefined || value.startsWith('--')) flags[name] = true
    else {
      flags[name] = value
      at++
    }
  }

  return { command, flags }
}

const page = text =>
  `<!doctype html><meta charset="utf-8"><title>live-voice</title><body style="font-family:sans-serif;margin:3em"><p>${text}</p></body>`

// Waits for the browser's redirect on 127.0.0.1:1455; rejects when the port is taken.
function startCallbackServer(state) {
  return new Promise((resolveStart, rejectStart) => {
    let settle
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    result.catch(() => undefined)
    let handled = false
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const reply = (status, text) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(page(text))
      }
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) return reply(404, 'Not found.')
      if (url.searchParams.get('state') !== state) return reply(400, 'State mismatch.')
      if (handled) return reply(409, 'This sign-in was already handled.')
      const error = url.searchParams.get('error')
      if (error) {
        handled = true
        reply(400, 'Sign-in failed. You may close this page.')
        return settle.reject(new Error(`Sign-in failed: ${redact(error)}`))
      }
      const code = url.searchParams.get('code')
      if (!code) return reply(400, 'Missing authorization code.')
      handled = true
      reply(200, 'Signed in to Codex for live-voice. You may close this page.')
      settle.resolve(code)
    })
    server.once('error', rejectStart)
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      server.off('error', rejectStart)
      resolveStart({ code: result, close: () => server.close() })
    })
  })
}

function openBrowser(url) {
  try {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The URL is printed anyway.
  }
}

// A line pasted in the terminal (the redirect URL or the code), when there is one.
function pastedInput() {
  if (!process.stdin.isTTY) return new Promise(() => undefined)
  const lines = createInterface({ input: process.stdin })

  return new Promise(resolve => {
    lines.once('line', line => {
      lines.close()
      resolve(line)
    })
  })
}

async function loginDevice(path) {
  const device = await startDeviceAuth()
  emit({ type: 'device', code: device.userCode, url: DEVICE_VERIFICATION_URI })
  openBrowser(DEVICE_VERIFICATION_URI)
  await saveCredentials(path, await finishDeviceAuth(device))
}

async function loginBrowser(path) {
  const { verifier, challenge } = await createPkce()
  const state = createState()
  const url = buildAuthorizeUrl({ challenge, state })
  const callback = await startCallbackServer(state).catch(() => undefined)
  if (!callback && !process.stdin.isTTY) {
    emit({ type: 'progress', message: `Port ${CALLBACK_PORT} is in use; signing in with a device code instead.` })
    return loginDevice(path)
  }
  emit({ type: 'url', url })
  emit({ type: 'progress', message: 'Opening the browser to sign in with ChatGPT.' })
  openBrowser(url)
  if (process.stdin.isTTY) process.stderr.write('Complete the sign-in in the browser, or paste the redirect URL here:\n')
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Sign-in timed out')), LOGIN_TIMEOUT_MS)
  })
  try {
    const answer = await Promise.race([
      callback ? callback.code.then(code => ({ code })) : new Promise(() => undefined),
      pastedInput().then(line => ({ line })),
      timeout,
    ])
    let code = answer.code
    if (answer.line !== undefined) {
      const parsed = parseAuthorizationInput(answer.line)
      if (parsed.state && parsed.state !== state) throw new Error('State mismatch')
      code = parsed.code
    }
    if (!code) throw new Error('Missing authorization code')
    await saveCredentials(path, await exchangeCode({ code, verifier }))
  } finally {
    clearTimeout(timer)
    callback?.close()
  }
}

async function login(flags) {
  const path = credentialsPath()
  try {
    if (flags.device) await loginDevice(path)
    else await loginBrowser(path)
    emit({ type: 'done', message: 'Signed in to Codex.' })
    return 0
  } catch (error) {
    emit({ type: 'error', message: message(error) })
    return 1
  }
}

async function status() {
  const creds = await loadCredentials(credentialsPath())
  const state = credentialStatus(creds, Date.now())
  emit({ type: 'status', status: state, ...(creds ? { expires: new Date(creds.expires).toISOString() } : {}) })

  return 0
}

async function logout() {
  await deleteCredentials(credentialsPath())
  emit({ type: 'status', status: 'signed-out' })

  return 0
}

// Reads the mod's numbered command files in order, deleting each once read.
function watchCommands(dir, handle) {
  const attempts = new Map()
  let busy = false
  const poll = async () => {
    if (busy) return
    busy = true
    try {
      const names = (await readdir(dir).catch(() => [])).filter(name => /^\d+\.json$/.test(name)).sort()
      for (const name of names) {
        const file = join(dir, name)
        let value
        try {
          value = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          const tries = (attempts.get(name) ?? 0) + 1
          attempts.set(name, tries)
          if (tries < COMMAND_PARSE_ATTEMPTS) break // Maybe still being written: keep the order.
          value = undefined
        }
        attempts.delete(name)
        await rm(file, { force: true })
        const command = parseCommand(value)
        if (command) handle(command)
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void poll(), COMMAND_POLL_MS)

  return () => clearInterval(timer)
}

async function run(flags) {
  if (typeof flags.commands !== 'string') {
    emit({ type: 'error', message: 'run needs --commands <dir>' })
    return 2
  }
  const voice = typeof flags.voice === 'string' && LIVE_VOICES.includes(flags.voice) ? flags.voice : DEFAULT_VOICE
  const language = typeof flags.language === 'string' ? flags.language : 'es'
  const path = credentialsPath()
  if (credentialStatus(await loadCredentials(path), Date.now()) === 'signed-out') {
    emit({ type: 'error', code: 'signed-out', message: 'Codex: not signed in, run /live-config codex login' })
    return 3
  }
  const modules = typeof flags.natives === 'string' ? flags.natives : process.env.LIVE_VOICE_CODEX_MODULES || DEFAULT_MODULES
  let natives
  try {
    natives = loadNatives(modules)
  } catch {
    emit({ type: 'error', code: 'natives', message: `Codex: the native audio addon or ws is missing in ${modules}. ${INSTALL_HINT}` })
    return 4
  }
  await mkdir(flags.commands, { recursive: true, mode: 0o700 })
  const session = runLive({
    natives,
    getAccess: () => getAccess(path),
    sessionId: typeof flags['session-id'] === 'string' ? flags['session-id'] : randomUUID(),
    voice,
    instructions: buildInstructions({ language }),
    emit,
  })
  const stopCommands = watchCommands(flags.commands, session.handle)
  const shutdown = () => void session.close(0)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.stdout.on('error', shutdown)
  const code = await session.done
  stopCommands()

  return code
}

const { command, flags } = parseArgs(process.argv.slice(2))
const commands = { login, logout, status, run }
const chosen = commands[command]
if (!chosen) {
  emit({ type: 'error', message: 'usage: main.mjs login [--device] | logout | status | run --commands <dir> [--voice <v>] [--language <code>]' })
  process.exit(2)
}
process.exitCode = await chosen(flags).catch(error => {
  emit({ type: 'error', message: message(error) })
  return 1
})
// Native handles (audio, sockets) can keep the loop alive after a close.
if (command === 'run') process.exit(process.exitCode)
