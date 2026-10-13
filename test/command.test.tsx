import { expect, test } from 'claude-code/testing'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

test('/live status answers while live voice is off', async $ => {
  const ran = await $.command.run(live('status'))
  expect(ran.text).toMatch(/Live voice is off/)
})

test('/live with an unknown argument answers the usage', async $ => {
  const ran = await $.command.run(live('dance'))
  expect(ran.text).toMatch(/Usage: \/live/)
})

test('/live voice changes the voice the status reports', async $ => {
  await $.command.run(live('voice em_alex'))
  const ran = await $.command.run(live('status'))
  expect(ran.text).toMatch(/em_alex/)
})

test('/live mute while off says live voice is off', async $ => {
  const ran = await $.command.run(live('mute'))
  expect(ran.text).toMatch(/Live voice is off/)
})

test('the band leaves the engine its own drawing while live voice is off', async ($, on) => {
  // Stands for the engine's own band beneath the plugin.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'live-voice', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
    expect(await ui.find({ key: 'mute' })).toBeUndefined()
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  }
})
