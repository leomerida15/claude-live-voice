// The codex-live sidecar's wire pieces, ported from pi-live-codex
// (`protocol.ts`, `transport.ts`, MIT): the realtime call's headers and
// payload, the server events, context chunking; plus the JSON-lines protocol
// the sidecar speaks with the live-voice mod and the spoken instructions.

export const LIVE_MODEL = 'gpt-live-1-codex'
export const CONTEXT_CHUNK_BYTES = 500
export const CODEX_CLIENT_VERSION = '0.144.1'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
export const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`
const LIVE_ORIGINATOR = 'Codex Desktop'
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/** The realtime voices pi-live-codex offers; `sol` is the default. */
export const LIVE_VOICES = ['sol', 'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse']
export const DEFAULT_VOICE = 'sol'

/** What the model asks the client for to report on work, and to stop it. */
export const STATUS_REQUEST = '[[live:status]]'
export const CANCEL_CURRENT_REQUEST = '[[live:cancel-current]]'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function accountIdOf(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return undefined
    const id = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/** The headers of the signaling POST and the sideband socket. */
export function liveHeaders(access, sessionId, realtimeSessionId) {
  const headers = {
    Authorization: `Bearer ${access.accessToken}`,
    'OpenAI-Alpha': 'quicksilver=v2',
    'User-Agent': `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    'x-session-id': realtimeSessionId,
    originator: LIVE_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    'session-id': sessionId,
    'thread-id': sessionId,
  }
  const accountId = access.accountId ?? accountIdOf(access.accessToken)
  if (accountId) headers['chatgpt-account-id'] = accountId

  return headers
}

/** The `rtc_...` call id in the signaling answer's Location, or undefined. */
export function parseLiveCallId(location) {
  if (!location) return undefined
  return location
    .split('?', 1)[0]
    ?.split('/')
    .find(segment => LIVE_CALL_ID_PATTERN.test(segment))
}

export function buildSidebandUrl(callId) {
  return `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`
}

export function buildLiveSessionPayload(instructions, voice) {
  return { model: LIVE_MODEL, instructions, audio: { output: { voice } }, delegation: { type: 'client' } }
}

export function buildSessionContextAppend(text, channel) {
  return { type: 'session.context.append', ...(channel ? { channel } : {}), content: [{ type: 'input_text', text }] }
}

export function buildDelegationContextAppend(delegationId, text, channel) {
  return {
    type: 'delegation.context.append',
    delegation_item_id: delegationId,
    ...(channel ? { channel } : {}),
    content: [{ type: 'input_text', text }],
  }
}

export function buildSessionClose() {
  return { type: 'session.close' }
}

/** Claude's finished answer, as the model is told to present it. */
export function agentFinalMessage(text) {
  const body = String(text ?? '').trim()

  return `"Agent Final Message":\n\n${body || 'The operation ended without a final response.'}`
}

/** A reply to a turn the person did not start (a task notification, a schedule). */
export function noticeMessage(text) {
  return `"Notice":\n\n${String(text ?? '').trim()}`
}

const utf8Bytes = codePoint => (codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4)

/** Context cut into pieces of at most 500 UTF-8 bytes, never inside a character. */
export function chunkLiveContext(text) {
  if (text.length === 0) return ['']
  const chunks = []
  let start = 0
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const size = utf8Bytes(codePoint)
    if (bytes + size > CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += size
    index += codePoint > 0xffff ? 2 : 1
  }
  chunks.push(text.slice(start))

  return chunks
}

function parseError(payload) {
  if (typeof payload.message === 'string') return { type: 'error', message: payload.message }
  const error = payload.error
  if (isObject(error) && typeof error.message === 'string') return { type: 'error', message: error.message }
  if (error === undefined) return null
  try {
    return { type: 'error', message: JSON.stringify(error) }
  } catch {
    return { type: 'error', message: String(error) }
  }
}

/** A sideband or data channel event, or null when it is not one. */
export function parseLiveServerEvent(payload) {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') return null
  switch (parsed.type) {
    case 'session.started':
    case 'session.updated':
      return isObject(parsed.session) && typeof parsed.session.id === 'string' ? { type: parsed.type, session: { id: parsed.session.id } } : null
    case 'output_audio.delta':
      return typeof parsed.audio === 'string' ? { type: parsed.type, audio: parsed.audio } : null
    case 'input_transcript.added':
    case 'output_transcript.added':
      return isObject(parsed.item) && typeof parsed.item.text === 'string' ? { type: parsed.type, item: { text: parsed.item.text } } : null
    case 'turn.done': {
      const turn = parsed.turn
      if (!isObject(turn) || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.transcript !== 'string') return null
      return { type: 'turn.done', turn: { role: turn.role, transcript: turn.transcript } }
    }
    case 'delegation.created': {
      const item = parsed.item
      if (!isObject(item) || item.type !== 'delegation' || item.target !== 'client' || typeof item.id !== 'string' || !Array.isArray(item.content)) {
        return null
      }
      const content = item.content
        .filter(one => isObject(one) && one.type === 'input_text' && typeof one.text === 'string')
        .map(one => ({ type: 'input_text', text: one.text }))
      return { type: 'delegation.created', item: { type: 'delegation', target: 'client', id: item.id, content } }
    }
    case 'error':
      return parseError(parsed)
    default:
      return { type: 'unknown', wireType: parsed.type }
  }
}

/** A delegation's request text. */
export function delegationText(event) {
  return event.item.content
    .map(one => one.text)
    .join('\n')
    .trim()
}

/** The microphone level of a frame: its RMS, at most 1. */
export function microphoneLevel(samples) {
  if (samples.length === 0) return 0
  let squares = 0
  for (const sample of samples) squares += sample * sample

  return Math.min(1, Math.sqrt(squares / samples.length))
}

/** One JSON object as one line. */
export function encodeLine(value) {
  return `${JSON.stringify(value)}\n`
}

/** Splits a stream of text into JSON objects, one per line; anything else is skipped. */
export class LineDecoder {
  #pending = ''

  push(text) {
    this.#pending += text
    const values = []
    let newline = this.#pending.indexOf('\n')
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline).trim()
      this.#pending = this.#pending.slice(newline + 1)
      if (line) {
        try {
          const value = JSON.parse(line)
          if (isObject(value)) values.push(value)
        } catch {
          // Not a JSON line.
        }
      }
      newline = this.#pending.indexOf('\n')
    }

    return values
  }
}

const isText = value => typeof value === 'string'

/** A command from the mod, checked, or undefined. */
export function parseCommand(value) {
  if (!isObject(value)) return undefined
  switch (value.type) {
    case 'final':
    case 'commentary':
      return isText(value.id) && value.id !== '' && isText(value.text) ? { type: value.type, id: value.id, text: value.text } : undefined
    case 'notice':
      return isText(value.text) ? { type: 'notice', text: value.text } : undefined
    case 'mute':
      return typeof value.on === 'boolean' ? { type: 'mute', on: value.on } : undefined
    case 'cancel':
      return isText(value.id) && value.id !== '' ? { type: 'cancel', id: value.id } : { type: 'cancel' }
    case 'close':
      return { type: 'close' }
    default:
      return undefined
  }
}

/** A command file's name: its sequence number, zero-padded so names sort in order. */
export function commandFileName(sequence) {
  return `${String(sequence).padStart(8, '0')}.json`
}

const LANGUAGE_NAMES = {
  es: 'Spanish',
  en: 'English',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  zh: 'Chinese',
  hi: 'Hindi',
}

/** The realtime model's instructions: pi-live-codex's, for Claude Code and the session language. */
export function buildInstructions({ language = 'es' } = {}) {
  const code = String(language).trim().toLowerCase()
  const name = LANGUAGE_NAMES[code.slice(0, 2)]
  const speak = name ? `Speak ${name} unless the user speaks another language.` : `Speak the language code ${code} unless the user speaks another language.`

  return `You are the realtime voice surface of one unified coding assistant.

The user speaks to you. ${speak} Respond directly, briefly, conversationally, and without markdown unless asked for detail. Do not greet, introduce yourself, or speak merely because the session connected or received commentary context. Remain silent until the user speaks or you receive explicitly speakable context.

The Claude Code coding agent is your execution surface with repository context and tools. For coding, investigation, repository changes, commands, or verification, promptly create a client delegation containing the complete request and relevant conversational context. Do not attempt repository work yourself. A new request while work is active must create another client delegation. Independent requests are queued by the client so they remain correctly correlated; do not assume they steer an earlier request.

When the user asks only for the current status or progress of work already in flight, create a client delegation whose entire text is exactly ${STATUS_REQUEST}. Do not say you are checking or promise a later update; wait for the returned status and present it directly. Do not use this control when the user also asks to change, investigate, retry, or add work.

When the user unambiguously asks to stop the operation currently being performed, create a client delegation whose entire text is exactly ${CANCEL_CURRENT_REQUEST}. If the target is ambiguous, ask the user instead of guessing.

Treat delegation context as your own internal progress and results. Never mention a backend, delegation, protocol, or separate assistant. Commentary context is silent progress for conversational continuity. Context beginning with "Agent Final Message": is the completed result; say its useful content faithfully and concisely as your own, without inventing anything it does not say, and skip code, paths and long lists unless asked. Session context beginning with "Notice": is an update the user did not ask for in this conversation (a finished background task, a message, a schedule); briefly tell the user what it says. Never claim work or verification before a result arrives.`
}
