// The codex-live sidecar's wire pieces: realtime headers, the call id, the
// session payload, server events, context chunking, the JSON-lines protocol
// with the mod, and the instructions. No network, no native module.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CODEX_CLIENT_VERSION,
  CONTEXT_CHUNK_BYTES,
  DEFAULT_VOICE,
  LIVE_VOICES,
  LineDecoder,
  SIGNALING_URL,
  agentFinalMessage,
  buildDelegationContextAppend,
  buildInstructions,
  buildLiveSessionPayload,
  buildSessionClose,
  buildSessionContextAppend,
  buildSidebandUrl,
  chunkLiveContext,
  commandFileName,
  delegationText,
  encodeLine,
  liveHeaders,
  microphoneLevel,
  noticeMessage,
  parseCommand,
  parseLiveCallId,
  parseLiveServerEvent,
} from '../../scripts/codex-live/protocol.mjs'

const jwt = claims =>
  ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part, at) => (at < 2 ? Buffer.from(part).toString('base64url') : part)).join('.')

test('the signaling URL and sideband URL', () => {
  assert.equal(SIGNALING_URL, 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas')
  assert.equal(buildSidebandUrl('rtc_ab-1'), 'wss://api.openai.com/v1/live/rtc_ab-1')
})

test('the call id is the rtc_ segment of Location', () => {
  assert.equal(parseLiveCallId('/v1/realtime/calls/rtc_abc-123?x=1'), 'rtc_abc-123')
  assert.equal(parseLiveCallId('https://h/x/rtc_Z9'), 'rtc_Z9')
  assert.equal(parseLiveCallId('/calls/abc'), undefined)
  assert.equal(parseLiveCallId(null), undefined)
  assert.equal(parseLiveCallId('/calls/rtc_bad!'), undefined)
})

test('headers name the Codex Desktop client, the account, and the session ids', () => {
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })
  assert.deepEqual(liveHeaders({ accessToken: token }, 'sess-1', 'rt-1'), {
    Authorization: `Bearer ${token}`,
    'OpenAI-Alpha': 'quicksilver=v2',
    'User-Agent': `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    'x-session-id': 'rt-1',
    originator: 'Codex Desktop',
    version: CODEX_CLIENT_VERSION,
    'session-id': 'sess-1',
    'thread-id': 'sess-1',
    'chatgpt-account-id': 'acct-9',
  })
  // An explicit account id wins; none at all leaves the header out.
  assert.equal(liveHeaders({ accessToken: token, accountId: 'acct-x' }, 's', 'r')['chatgpt-account-id'], 'acct-x')
  assert.equal('chatgpt-account-id' in liveHeaders({ accessToken: 'opaque' }, 's', 'r'), false)
})

test('the session payload asks for client delegation in the chosen voice', () => {
  assert.deepEqual(buildLiveSessionPayload('be brief', 'marin'), {
    model: 'gpt-live-1-codex',
    instructions: 'be brief',
    audio: { output: { voice: 'marin' } },
    delegation: { type: 'client' },
  })
})

test('the voices are pi-live-codex\'s, sol first and default', () => {
  assert.deepEqual(LIVE_VOICES, ['sol', 'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'])
  assert.equal(DEFAULT_VOICE, 'sol')
})

test('server events parse; malformed ones are null; unknown ones say their type', () => {
  assert.deepEqual(parseLiveServerEvent('{"type":"input_transcript.added","item":{"text":"hola"}}'), {
    type: 'input_transcript.added',
    item: { text: 'hola' },
  })
  assert.deepEqual(parseLiveServerEvent({ type: 'turn.done', turn: { role: 'assistant', transcript: 'ok' } }), {
    type: 'turn.done',
    turn: { role: 'assistant', transcript: 'ok' },
  })
  assert.deepEqual(
    parseLiveServerEvent({
      type: 'delegation.created',
      item: { type: 'delegation', target: 'client', id: 'd1', content: [{ type: 'input_text', text: 'fix' }, { type: 'x' }] },
    }),
    { type: 'delegation.created', item: { type: 'delegation', target: 'client', id: 'd1', content: [{ type: 'input_text', text: 'fix' }] } },
  )
  assert.deepEqual(parseLiveServerEvent({ type: 'error', error: { message: 'boom' } }), { type: 'error', message: 'boom' })
  assert.deepEqual(parseLiveServerEvent({ type: 'response.weird' }), { type: 'unknown', wireType: 'response.weird' })
  assert.equal(parseLiveServerEvent('{bad'), null)
  assert.equal(parseLiveServerEvent({ type: 'turn.done', turn: { role: 'system', transcript: '' } }), null)
  assert.equal(delegationText({ item: { content: [{ text: ' a ' }, { text: 'b' }] } }), 'a \nb')
})

test('client messages: session and delegation context, close', () => {
  assert.deepEqual(buildSessionContextAppend('x', 'speakable'), {
    type: 'session.context.append',
    channel: 'speakable',
    content: [{ type: 'input_text', text: 'x' }],
  })
  assert.deepEqual(buildDelegationContextAppend('d1', 'y'), {
    type: 'delegation.context.append',
    delegation_item_id: 'd1',
    content: [{ type: 'input_text', text: 'y' }],
  })
  assert.deepEqual(buildSessionClose(), { type: 'session.close' })
  assert.equal(agentFinalMessage('Done.'), '"Agent Final Message":\n\nDone.')
  assert.equal(agentFinalMessage('  '), '"Agent Final Message":\n\nThe operation ended without a final response.')
  assert.equal(noticeMessage('Build passed.'), '"Notice":\n\nBuild passed.')
})

test('context is cut into chunks of at most 500 UTF-8 bytes, never inside a character', () => {
  assert.equal(CONTEXT_CHUNK_BYTES, 500)
  assert.deepEqual(chunkLiveContext(''), [''])
  assert.deepEqual(chunkLiveContext('abc'), ['abc'])
  const ascii = 'a'.repeat(1001)
  assert.deepEqual(chunkLiveContext(ascii).map(chunk => chunk.length), [500, 500, 1])
  const accents = 'ñ'.repeat(300) // 2 bytes each
  const chunks = chunkLiveContext(accents)
  assert.deepEqual(chunks.map(chunk => Buffer.byteLength(chunk)), [500, 100])
  const emoji = '😀'.repeat(130) // 4 bytes, surrogate pairs
  const pieces = chunkLiveContext(emoji)
  assert.equal(pieces.join(''), emoji)
  for (const piece of pieces) {
    assert.ok(Buffer.byteLength(piece) <= 500)
    assert.ok(!/[\uD800-\uDBFF]$/.test(piece))
  }
})

test('JSON lines: one event per line; the decoder joins split chunks and skips junk', () => {
  assert.equal(encodeLine({ type: 'user', text: 'a\nb' }), '{"type":"user","text":"a\\nb"}\n')
  const decoder = new LineDecoder()
  assert.deepEqual(decoder.push('{"type":"ready"}\n{"type":"le'), [{ type: 'ready' }])
  assert.deepEqual(decoder.push('vel","in":0.5,"out":0}\nnot json\n[1]\n'), [{ type: 'level', in: 0.5, out: 0 }])
  assert.deepEqual(decoder.push('{"type":"closed"}'), [])
  assert.deepEqual(decoder.push('\n'), [{ type: 'closed' }])
})

test('commands from the mod are validated', () => {
  assert.deepEqual(parseCommand({ type: 'final', id: 'd1', text: 'ok' }), { type: 'final', id: 'd1', text: 'ok' })
  assert.deepEqual(parseCommand({ type: 'commentary', id: 'd1', text: 'reading' }), { type: 'commentary', id: 'd1', text: 'reading' })
  assert.deepEqual(parseCommand({ type: 'notice', text: 'n' }), { type: 'notice', text: 'n' })
  assert.deepEqual(parseCommand({ type: 'mute', on: true }), { type: 'mute', on: true })
  assert.deepEqual(parseCommand({ type: 'cancel' }), { type: 'cancel' })
  assert.deepEqual(parseCommand({ type: 'cancel', id: 'd2' }), { type: 'cancel', id: 'd2' })
  assert.deepEqual(parseCommand({ type: 'close' }), { type: 'close' })
  assert.equal(parseCommand({ type: 'final', text: 'no id' }), undefined)
  assert.equal(parseCommand({ type: 'mute', on: 'yes' }), undefined)
  assert.equal(parseCommand({ type: 'rm -rf' }), undefined)
  assert.equal(parseCommand(null), undefined)
  assert.equal(commandFileName(7), '00000007.json')
  assert.equal(commandFileName(123456789), '123456789.json')
})

test('the microphone level is the RMS, clamped to 1', () => {
  assert.equal(microphoneLevel(new Float32Array()), 0)
  assert.equal(microphoneLevel(new Float32Array([0.5, -0.5])), 0.5)
  assert.equal(microphoneLevel(new Float32Array([3, -3])), 1)
})

test('the instructions name Claude Code, the language, the controls and the final message', () => {
  const es = buildInstructions({ language: 'es' })
  assert.match(es, /Claude Code/)
  assert.match(es, /Spanish/)
  assert.match(es, /\[\[live:status\]\]/)
  assert.match(es, /\[\[live:cancel-current\]\]/)
  assert.match(es, /"Agent Final Message":/)
  assert.match(es, /"Notice":/)
  assert.match(es, /brief/i)
  assert.doesNotMatch(es, /\bPi\b/)
  assert.match(buildInstructions({ language: 'en' }), /English/)
  assert.match(buildInstructions({ language: 'xx' }), /language code xx/)
})
