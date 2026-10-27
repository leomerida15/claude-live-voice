// The live session's lifetime: a server `error` event is reported and the
// session stays open; a transport failure still closes it. A fake transport
// and a fake microphone stand in for the WebRTC call: no network, no native
// module.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runLive } from '../../scripts/codex-live/live.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

// A session over a fake transport; `transport.options` holds the callbacks runLive handed it.
function session() {
  const events = []
  const sent = []
  const transport = {
    options: undefined,
    connect: async () => undefined,
    send: async message => {
      sent.push(message)
    },
    close: async () => undefined,
    pushAudio: () => undefined,
    setMuted: () => undefined,
  }
  const natives = {
    AudioCapture: class {
      stop() {}
    },
  }
  const live = runLive({
    natives,
    getAccess: async () => ({}),
    sessionId: 's',
    voice: 'sol',
    instructions: '',
    emit: event => events.push(event),
    createTransport: options => {
      transport.options = options
      return transport
    },
  })

  return { live, events, sent, transport }
}

const types = events => events.filter(event => event.type !== 'level').map(event => event.type)

test('a server error event is reported and the session stays open', async () => {
  const { live, events, sent, transport } = session()
  await tick()
  assert.deepEqual(types(events), ['ready'])
  transport.options.onEvent({ type: 'error', message: 'Unknown delegation item id: item_bogus123' })
  await tick()
  assert.deepEqual(events.at(-1), { type: 'error', message: 'Unknown delegation item id: item_bogus123' })
  assert.ok(!types(events).includes('closed'))
  // Still usable: a later command reaches the transport.
  live.handle({ type: 'final', id: 'd1', text: 'Listo.' })
  await tick()
  assert.equal(sent.length, 1)
  await live.close(0)
  assert.equal(await live.done, 0)
})

test('a transport failure closes the session', async () => {
  const { live, events, transport } = session()
  await tick()
  transport.options.onFailure('Codex live sideband closed (1006)')
  assert.equal(await live.done, 1)
  assert.deepEqual(types(events), ['ready', 'error', 'closed'])
  assert.equal(events[1].message, 'Codex live sideband closed (1006)')
})

test('a send failure closes the session', async () => {
  const { live, events, transport } = session()
  await tick()
  transport.send = async () => {
    throw new Error('Codex live sideband is not connected')
  }
  live.handle({ type: 'notice', text: 'Hecho.' })
  assert.equal(await live.done, 1)
  assert.ok(events.some(event => event.type === 'error' && event.message === 'Codex live sideband is not connected'))
})
