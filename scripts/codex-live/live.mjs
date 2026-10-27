// The live call: a WebRTC peer (audio both ways, through the
// `@oh-my-pi/pi-natives` addon) and the sideband socket for events and
// context, ported from pi-live-codex's `transport.ts` and `controller.ts`
// (MIT). macOS attestation is left out, as pi-live-codex does on Linux.

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  SIGNALING_URL,
  agentFinalMessage,
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionClose,
  buildSessionContextAppend,
  buildSidebandUrl,
  chunkLiveContext,
  delegationText,
  liveHeaders,
  microphoneLevel,
  noticeMessage,
  parseLiveCallId,
  parseLiveServerEvent,
} from './protocol.mjs'

/** Where Pi installs the native addon and `ws`; used read-only when nothing else is named. */
export const DEFAULT_MODULES = join(homedir(), '.pi', 'agent', 'npm', 'node_modules')
export const INSTALL_HINT =
  'Install them with: npm install --prefix ~/.local/share/live-voice @oh-my-pi/pi-natives@18.4.9 ws@8.22.0, ' +
  'then set LIVE_VOICE_CODEX_MODULES=~/.local/share/live-voice/node_modules (or pass --natives).'

const SIDEBAND_CONNECT_ATTEMPTS = 5
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY = 300
const OUTPUT_ACTIVE_LEVEL = 0.015
const MIN_BARGE_IN_LEVEL = 0.04
const OUTPUT_ECHO_RATIO = 0.65
const LEVEL_EVERY_MS = 125
const MICROPHONE_STALL_MS = 5_000

/** The addon's peer and capture classes and the `ws` socket, from a node_modules directory. */
export function loadNatives(modulesDir) {
  const require = createRequire(join(modulesDir, 'live-voice-resolve.cjs'))
  const native = require(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`)
  const ws = require('ws')

  return { LiveWebRtcPeer: native.LiveWebRtcPeer, AudioCapture: native.AudioCapture, WebSocket: ws.WebSocket ?? ws }
}

const bounded = text => {
  const flat = String(text).trim().replace(/\s+/g, ' ').replace(/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[redacted]')
  return flat.length <= MAX_ERROR_BODY ? flat : `${flat.slice(0, MAX_ERROR_BODY)}…`
}

/** The WebRTC call and its sideband, as pi-live-codex's CodexLiveTransport. */
class Transport {
  #natives
  #options
  #realtimeSessionId = crypto.randomUUID()
  #peer
  #sideband
  #state = 'idle'
  #muted = false
  #failed = false
  #tail = Promise.resolve()

  constructor(natives, options) {
    this.#natives = natives
    this.#options = options
  }

  async connect() {
    this.#state = 'connecting'
    const { LiveWebRtcPeer } = this.#natives
    const peer = new LiveWebRtcPeer(
      (error, payload) => (error ? this.#fail(error.message) : this.#peerEvent(payload)),
      (error, level) => (error ? this.#fail(error.message) : this.#outputLevel(level)),
      (error, message) => this.#fail(error?.message ?? message),
    )
    this.#peer = peer
    const offer = await peer.createOffer()
    const access = await this.#options.getAccess()
    const response = await fetch(SIGNALING_URL, {
      method: 'POST',
      headers: { ...liveHeaders(access, this.#options.sessionId, this.#realtimeSessionId), Accept: '*/*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: offer, session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice) }),
    })
    const answer = await response.text()
    if (!response.ok) throw new Error(`Codex live signaling failed (${response.status}): ${bounded(answer) || response.statusText}`)
    if (!answer.trim()) throw new Error('Codex live signaling returned an empty SDP answer')
    const callId = parseLiveCallId(response.headers.get('location'))
    if (!callId) throw new Error('Codex live signaling returned no valid call ID')
    await peer.acceptAnswer(answer)
    peer.setMuted(this.#muted)
    await peer.waitForOpen()
    await this.#connectSideband(callId, access)
    this.#state = 'connected'
  }

  async #connectSideband(callId, access) {
    let failure = new Error('Codex live sideband connection failed')
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.#openSideband(callId, access)
        return
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause))
        if (this.#state !== 'connecting') throw failure
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt))
      }
    }
    throw failure
  }

  #openSideband(callId, access) {
    const { WebSocket } = this.#natives
    const socket = new WebSocket(buildSidebandUrl(callId), { headers: liveHeaders(access, this.#options.sessionId, this.#realtimeSessionId) })

    return new Promise((resolve, reject) => {
      let opened = false
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error('Codex live sideband connection timed out'))
      }, SIDEBAND_CONNECT_TIMEOUT_MS)
      timer.unref()
      socket.once('open', () => {
        opened = true
        clearTimeout(timer)
        this.#sideband = socket
        resolve()
      })
      socket.on('message', (data, isBinary) => {
        if (isBinary) this.#fail('Codex live sideband returned a binary frame')
        else this.#event(data.toString('utf8'))
      })
      socket.on('error', error => {
        if (!opened) {
          clearTimeout(timer)
          socket.terminate()
          reject(new Error(`Codex live sideband connection failed${error.message ? `: ${error.message}` : ''}`))
        } else {
          this.#fail(`Codex live sideband failed${error.message ? `: ${error.message}` : ''}`)
        }
      })
      socket.on('close', code => {
        if (!opened) {
          clearTimeout(timer)
          reject(new Error(`Codex live sideband closed before connecting (${code})`))
          return
        }
        if (this.#sideband !== socket) return
        this.#sideband = undefined
        if (this.#state === 'connected') this.#fail(`Codex live sideband closed (${code})`)
      })
    })
  }

  #event(payload) {
    if (this.#state === 'closing' || this.#state === 'closed') return
    const event = parseLiveServerEvent(payload)
    if (event) this.#options.onEvent(event)
  }

  // The data channel repeats the sideband's events; only its errors count once the sideband is open.
  #peerEvent(payload) {
    if (this.#state === 'closing' || this.#state === 'closed') return
    const event = parseLiveServerEvent(payload)
    if (!event) return
    if (this.#sideband?.readyState === 1 && event.type !== 'error') return
    this.#options.onEvent(event)
  }

  #outputLevel(level) {
    if (this.#state === 'connected' && Number.isFinite(level)) this.#options.onOutputLevel(Math.min(1, Math.max(0, level)))
  }

  #fail(message) {
    if ((this.#state !== 'connecting' && this.#state !== 'connected') || this.#failed) return
    this.#failed = true
    this.#options.onFailure(message)
  }

  send(message) {
    const operation = this.#tail.then(() => {
      if (this.#state !== 'connected' || this.#sideband?.readyState !== 1) throw new Error('Codex live sideband is not connected')
      this.#sideband.send(JSON.stringify(message))
    })
    this.#tail = operation.catch(() => undefined)

    return operation
  }

  pushAudio(samples) {
    if (this.#state === 'connected' && !this.#muted && samples.length > 0) this.#peer?.pushAudio(samples)
  }

  setMuted(muted) {
    this.#muted = muted
    if (this.#state === 'connected') this.#peer?.setMuted(muted)
  }

  async close() {
    if (this.#state === 'closed') return
    this.#state = 'closing'
    const sideband = this.#sideband
    const peer = this.#peer
    this.#sideband = undefined
    this.#peer = undefined
    if (sideband && (sideband.readyState === 0 || sideband.readyState === 1)) sideband.close(1000, 'done')
    await peer?.close().catch(() => undefined)
    this.#state = 'closed'
  }
}

/**
 * Runs one live session until it closes: emits events for the mod (`emit`)
 * and takes its commands (`handle`). Resolves with the exit code.
 * `createTransport` replaces the WebRTC call in tests.
 */
export function runLive({ natives, getAccess, sessionId, voice, instructions, emit, createTransport = options => new Transport(natives, options) }) {
  let muted = false
  let closing
  let resolveDone
  const done = new Promise(resolve => {
    resolveDone = resolve
  })
  let inputLevel = 0
  let outputLevel = 0
  let lastLevels = ''
  let recorder
  let lastFrameAt = 0
  let restarted = false
  const timers = []
  const seen = new Set()
  let inputTranscript = ''
  let outputTranscript = ''

  const transport = createTransport({
    getAccess,
    sessionId,
    voice,
    instructions,
    onOutputLevel: level => {
      outputLevel = level
    },
    onEvent: event => onEvent(event),
    // The call itself failed (sideband, peer, binary frame): the session ends.
    onFailure: message => fail(message),
  })

  const sendText = (text, build) => {
    for (const chunk of chunkLiveContext(text)) transport.send(build(chunk)).catch(error => fail(error.message))
  }

  function onEvent(event) {
    if (closing) return
    switch (event.type) {
      case 'input_transcript.added':
        inputTranscript = event.item.text.startsWith(inputTranscript) ? event.item.text : inputTranscript + event.item.text
        break
      case 'output_transcript.added':
        outputTranscript = event.item.text.startsWith(outputTranscript) ? event.item.text : outputTranscript + event.item.text
        break
      case 'turn.done': {
        const role = event.turn.role
        const text = (event.turn.transcript || (role === 'user' ? inputTranscript : outputTranscript)).trim()
        if (role === 'user') inputTranscript = ''
        else outputTranscript = ''
        if (text) emit({ type: role === 'user' ? 'user' : 'assistant', text })
        break
      }
      case 'delegation.created': {
        if (seen.has(event.item.id)) break
        seen.add(event.item.id)
        const text = delegationText(event)
        if (text) emit({ type: 'delegation', id: event.item.id, text })
        break
      }
      // A server error (e.g. an unknown delegation id) leaves the session usable: report it only.
      case 'error':
        emit({ type: 'error', message: event.message })
        break
      default:
        break
    }
  }

  function fail(message) {
    if (closing) return
    emit({ type: 'error', message })
    void close(1)
  }

  function onAudio(error, samples) {
    if (closing) return
    if (error) return fail(error.message)
    lastFrameAt = Date.now()
    if (muted) return
    inputLevel = microphoneLevel(samples)
    // While the voice plays, only speech clearly louder than its echo goes up.
    const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, outputLevel * OUTPUT_ECHO_RATIO)
    if (outputLevel <= OUTPUT_ACTIVE_LEVEL || inputLevel >= echoThreshold) transport.pushAudio(samples)
  }

  function startMicrophone() {
    recorder = new natives.AudioCapture(16_000, onAudio)
    lastFrameAt = Date.now()
  }

  function stopMicrophone() {
    try {
      recorder?.stop()
    } catch {
      // Already stopped.
    }
    recorder = undefined
  }

  // A capture that stops delivering frames is restarted once, then fails.
  function watchMicrophone() {
    if (closing || !recorder || Date.now() - lastFrameAt < MICROPHONE_STALL_MS) return
    if (restarted) return fail('Microphone capture stopped responding after a restart.')
    restarted = true
    stopMicrophone()
    try {
      startMicrophone()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  function emitLevels() {
    const levels = { in: muted ? 0 : Math.round(inputLevel * 100) / 100, out: Math.round(outputLevel * 100) / 100 }
    const key = `${levels.in} ${levels.out}`
    if (key === lastLevels) return
    lastLevels = key
    emit({ type: 'level', ...levels })
  }

  async function close(code) {
    if (closing) return closing
    closing = (async () => {
      for (const timer of timers) clearInterval(timer)
      stopMicrophone()
      await transport.send(buildSessionClose()).catch(() => undefined)
      await transport.close().catch(() => undefined)
      emit({ type: 'closed' })
      resolveDone(code)
    })()

    return closing
  }

  /** One command from the mod. */
  function handle(command) {
    if (closing) return
    switch (command.type) {
      case 'final':
        sendText(agentFinalMessage(command.text), chunk => buildDelegationContextAppend(command.id, chunk))
        break
      case 'commentary':
        sendText(command.text, chunk => buildDelegationContextAppend(command.id, chunk, 'commentary'))
        break
      case 'notice':
        sendText(noticeMessage(command.text), chunk => buildSessionContextAppend(chunk, 'speakable'))
        break
      case 'mute':
        muted = command.on
        inputLevel = 0
        transport.setMuted(muted)
        break
      case 'cancel':
        if (command.id) sendText(agentFinalMessage('I stopped the current operation.'), chunk => buildDelegationContextAppend(command.id, chunk))
        else sendText('The user pressed stop. Stop speaking now and wait for the user.', chunk => buildSessionContextAppend(chunk, 'commentary'))
        break
      case 'close':
        void close(0)
        break
    }
  }

  void (async () => {
    try {
      await transport.connect()
      if (closing) return
      startMicrophone()
      timers.push(setInterval(emitLevels, LEVEL_EVERY_MS), setInterval(watchMicrophone, 1_000))
      emit({ type: 'ready' })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })()

  return { done, handle, close }
}
