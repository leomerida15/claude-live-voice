import { describe, expect, test } from 'claude-code/testing'

import {
  CODE_OMITTED,
  CONFIG_USAGE,
  DEFAULT_COLORS,
  USAGE,
  liveColors,
  audioBarWaveWidth,
  cellWidth,
  SentenceChunker,
  claim,
  cleanTranscript,
  killPattern,
  flatRow,
  bounceRow,
  levelGlyph,
  smoothLevel,
  parseListenerLine,
  parseLiveCommand,
  sessionTag,
  stripMarkdown,
  tunable,
  wave,
  waveRow,
} from '../hooks/text.ts'

const speakAll = (pieces: string[]) => {
  const chunker = new SentenceChunker()
  const out = pieces.flatMap(piece => chunker.push(piece))

  return [...out, ...chunker.flush()]
}

describe('parseLiveCommand', () => {
  test('no argument toggles', () => {
    expect(parseLiveCommand('')).toEqual({ kind: 'toggle' })
    expect(parseLiveCommand('   ')).toEqual({ kind: 'toggle' })
  })

  test('reads on, off, mute and status in any case', () => {
    expect(parseLiveCommand('on')).toEqual({ kind: 'on' })
    expect(parseLiveCommand(' OFF ')).toEqual({ kind: 'off' })
    expect(parseLiveCommand('mute')).toEqual({ kind: 'mute' })
    expect(parseLiveCommand('status')).toEqual({ kind: 'status' })
  })

  test('voice takes a Kokoro voice name', () => {
    expect(parseLiveCommand('voice em_alex')).toEqual({ kind: 'voice', voice: 'em_alex' })
    expect(parseLiveCommand('voice').kind).toBe('error')
    expect(parseLiveCommand('voice ../../etc').kind).toBe('error')
  })

  test('config opens the colors, resets them or sets one', () => {
    expect(parseLiveCommand('config')).toEqual({ kind: 'config' })
    expect(parseLiveCommand('config reset')).toEqual({ kind: 'config-reset' })
    expect(parseLiveCommand('CONFIG Agent Magenta')).toEqual({ kind: 'config-set', target: 'agent', color: 'magenta' })
    expect(parseLiveCommand('config idle gray')).toEqual({ kind: 'config-set', target: 'idle', color: 'gray' })
  })

  test('a bad config target or color answers the usage with the valid values', () => {
    for (const args of ['config agent', 'config mic red', 'config user pink', 'config user red extra', 'config reset now']) {
      const parsed = parseLiveCommand(args)
      expect(parsed.kind).toBe('error')
      expect(parsed.kind === 'error' && parsed.message).toBe(CONFIG_USAGE)
    }
    expect(CONFIG_USAGE).toContain('user|agent|dot|idle')
    expect(CONFIG_USAGE).toContain('red|green|yellow|blue|magenta|cyan|white|gray')
  })

  test('the usage names config', () => {
    expect(USAGE).toContain('config')
  })

  test('anything else is an error naming the usage', () => {
    const parsed = parseLiveCommand('dance')
    expect(parsed.kind).toBe('error')
    expect(parsed.kind === 'error' && parsed.message).toMatch(/on\|off/)
  })
})

describe('cleanTranscript', () => {
  test('trims real speech', () => {
    expect(cleanTranscript('  ¿Qué hora es?\n')).toBe('¿Qué hora es?')
  })

  test('drops empty, very short and hallucinated transcripts', () => {
    expect(cleanTranscript('')).toBeUndefined()
    expect(cleanTranscript(' . ')).toBeUndefined()
    expect(cleanTranscript('a')).toBeUndefined()
    expect(cleanTranscript('[BLANK_AUDIO]')).toBeUndefined()
    expect(cleanTranscript(' (música) ')).toBeUndefined()
    expect(cleanTranscript('Subtítulos realizados por la comunidad de Amara.org')).toBeUndefined()
    expect(cleanTranscript('¡Gracias por ver el video!')).toBeUndefined()
  })
})

describe('stripMarkdown', () => {
  test('removes emphasis, inline code, headings, bullets and links', () => {
    expect(stripMarkdown('## **Paso uno**')).toBe('Paso uno')
    expect(stripMarkdown('- usa `npm test` ahora')).toBe('usa npm test ahora')
    expect(stripMarkdown('1. Lee [la guía](https://example.com).')).toBe('Lee la guía.')
    expect(stripMarkdown('> *cita* _suave_')).toBe('cita suave')
    expect(stripMarkdown('| a | b |')).toBe('a, b')
  })

  test('leaves nothing speakable for rules and bare URLs', () => {
    expect(stripMarkdown('---')).toBe('')
    expect(stripMarkdown('https://example.com/x')).toBe('')
  })
})

describe('SentenceChunker', () => {
  test('splits streamed text into sentences as they complete', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('Hola. Esto es')).toEqual(['Hola.'])
    expect(chunker.push(' una prueba! Y')).toEqual(['Esto es una prueba!'])
    expect(chunker.push(' más')).toEqual([])
    expect(chunker.flush()).toEqual(['Y más'])
  })

  test('a newline ends a sentence', () => {
    expect(speakAll(['Primera línea\nSegunda', ' línea'])).toEqual(['Primera línea', 'Segunda línea'])
  })

  test('does not split decimals or list numbers', () => {
    expect(speakAll(['Cuesta 3.5 euros. Vale\n'])).toEqual(['Cuesta 3.5 euros.', 'Vale'])
    expect(speakAll(['1. Primero\n2', '. Segundo\n'])).toEqual(['Primero', 'Segundo'])
  })

  test('strips markdown from each sentence', () => {
    expect(speakAll(['Usa **siempre** `bun`.\n'])).toEqual(['Usa siempre bun.'])
  })

  test('skips code blocks and says so once per reply', () => {
    const out = speakAll([
      'Mira esto:\n```ts\nconst a = 1.',
      ' b = 2\n```\nY esto:\n~~~\nx\n~~~\nFin.',
    ])
    expect(out).toEqual(['Mira esto:', CODE_OMITTED, 'Y esto:', 'Fin.'])
  })

  test('drops pieces with nothing to say', () => {
    expect(speakAll(['---\n\n***\nHola\n'])).toEqual(['Hola'])
  })
})

describe('claim', () => {
  const sent = (text: string, entered?: string, isEntering = false) => ({ sent: text, entered, isEntering })

  test('a turn holding the rewritten text claims its prompt', () => {
    const prompt = sent('hola', 'hola (rewritten)')
    expect(claim([prompt], 'hola (rewritten)')).toBe(prompt)
  })

  test('merged queued prompts claim the oldest they hold', () => {
    const first = sent('hola', 'hola')
    const second = sent('adiós', 'adiós')
    expect(claim([first, second], 'hola\nadiós')).toBe(first)
  })

  test('a turn starting while its prompt is entering claims it', () => {
    const prompt = sent('hola', undefined, true)
    expect(claim([prompt], 'translated beyond recognition')).toBe(prompt)
  })

  test('a turn with unrelated text claims nothing once prompts entered', () => {
    expect(claim([sent('hola', 'hola')], 'something typed')).toBeUndefined()
    expect(claim([], 'hola')).toBeUndefined()
  })
})

describe('sessionTag and killPattern', () => {
  test('the tag names the session, odd characters made safe', () => {
    expect(sessionTag('ab-12')).toBe('live-voice-ab-12')
    expect(sessionTag('a b/c.d')).toBe('live-voice-a-b-c-d')
  })

  test('the pattern matches this session\'s child only', () => {
    const pattern = new RegExp(killPattern('listen.py', 'live-voice-abc'))
    expect(pattern.test('python3 -I /p/scripts/listen.py --dir /d --tag live-voice-abc')).toBe(true)
    expect(pattern.test('python3 -I /p/scripts/listen.py --dir /d --tag live-voice-abcd')).toBe(false)
    expect(pattern.test('python3 -I /p/scripts/listen.py --dir /d')).toBe(false)
    expect(pattern.test('bash /p/scripts/speak.sh --tag live-voice-abc ef_dora')).toBe(false)
    expect(new RegExp(killPattern('speak.sh', 'live-voice-abc')).test('bash /p/scripts/speak.sh --tag live-voice-abc ef_dora')).toBe(true)
  })
})

describe('tunable', () => {
  test('a positive number stands', () => {
    expect(tunable(500, 800)).toBe(500)
    expect(tunable(4.5, 3)).toBe(4.5)
    expect(tunable('250', 800)).toBe(250)
  })

  test('anything else falls back to the default', () => {
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY, '', 'loud', undefined, true]) {
      expect(tunable(bad, 800)).toBe(800)
    }
  })
})

describe('meter', () => {
  test('parseListenerLine tells level lines from WAV paths', () => {
    expect(parseListenerLine('level 0.42')).toEqual({ kind: 'level', value: 0.42 })
    expect(parseListenerLine(' level 1.00 ')).toEqual({ kind: 'level', value: 1 })
    expect(parseListenerLine('level 7')).toEqual({ kind: 'level', value: 1 })
    expect(parseListenerLine('/run/user/1000/live-voice/utt-1.wav')).toEqual({
      kind: 'wav',
      path: '/run/user/1000/live-voice/utt-1.wav',
    })
    expect(parseListenerLine('')).toBeUndefined()
    expect(parseListenerLine('level nan')).toBeUndefined()
    expect(parseListenerLine('level -1')).toBeUndefined()
    expect(parseListenerLine('relative.wav')).toBeUndefined()
  })

  test('levelGlyph maps 0..1 to the eight block heights', () => {
    expect(levelGlyph(0)).toBe('▁')
    expect(levelGlyph(0.5)).toBe('▅')
    expect(levelGlyph(0.4)).toBe('▄')
    expect(levelGlyph(1)).toBe('█')
    expect(levelGlyph(-3)).toBe('▁')
    expect(levelGlyph(9)).toBe('█')
  })

  test('bounceRow is a moving wave of exactly its width whose height follows the level', () => {
    const height = (row: string) => [...row].reduce((sum, glyph) => sum + '▁▂▃▄▅▆▇█'.indexOf(glyph), 0) / [...row].length
    expect([...bounceRow(0, 0.5, 70)]).toHaveLength(70)
    expect([...bounceRow(3, 1, 7)]).toHaveLength(7)
    expect(bounceRow(0, 1, 0)).toBe('')
    expect(bounceRow(0, 1, -2)).toBe('')
    // Silence: a low ripple, never above the second block.
    expect(bounceRow(0, 0, 70)).toMatch(/^[▁▂]+$/)
    // Louder is taller, on average and at its peak.
    expect(height(bounceRow(0, 0.5, 70))).toBeGreaterThan(height(bounceRow(0, 0, 70)) + 1)
    expect(height(bounceRow(0, 1, 70))).toBeGreaterThan(height(bounceRow(0, 0.5, 70)) + 1)
    expect(bounceRow(0, 1, 70)).toMatch(/[▇█]/)
    // The whole line moves from one frame to the next, at any level.
    expect(bounceRow(1, 0.6, 70)).not.toBe(bounceRow(0, 0.6, 70))
    expect(bounceRow(1, 0, 70)).not.toBe(bounceRow(0, 0, 70))
    // Out-of-range levels are clamped.
    expect(bounceRow(2, 7, 30)).toBe(bounceRow(2, 1, 30))
    expect(bounceRow(2, -1, 30)).toBe(bounceRow(2, 0, 30))
  })

  test('smoothLevel rises fast and falls slowly', () => {
    const up = smoothLevel(0, 1)
    expect(up).toBeGreaterThan(0.5)
    const down = smoothLevel(1, 0)
    expect(down).toBeGreaterThan(0.6)
    expect(down).toBeLessThan(1)
    expect(smoothLevel(0.4, 0.4)).toBe(0.4)
    expect(smoothLevel(0, Number.NaN)).toBe(0)
    let level = 1
    for (let i = 0; i < 20; i += 1) level = smoothLevel(level, 0)
    expect(level).toBeLessThan(0.05)
  })

  test('flatRow is the lowest block at exactly its width', () => {
    expect(flatRow(3)).toBe('▁▁▁')
    expect(flatRow(-1)).toBe('')
  })

  test('waveRow tiles the wave across exactly its width and moves with the frame', () => {
    expect([...waveRow(0, 100)]).toHaveLength(100)
    expect([...waveRow(5, 3)]).toHaveLength(3)
    expect(waveRow(0, 20).startsWith(wave(0))).toBe(true)
    expect(waveRow(1, 20)).not.toBe(waveRow(0, 20))
    expect(waveRow(8, 20)).toBe(waveRow(0, 20))
    expect(waveRow(0, 0)).toBe('')
  })

  test('cellWidth counts emoji as two cells and joiners as none', () => {
    expect(cellWidth('Mute')).toBe(4)
    expect(cellWidth('🎙🔴')).toBe(4)
    expect(cellWidth('●🎙')).toBe(3)
    expect(cellWidth('m: 🔇 Mute')).toBe(10)
    expect(cellWidth('s: ⏹ Stop')).toBe(10)
    expect(cellWidth('⏹\uFE0F')).toBe(2)
    expect(cellWidth('')).toBe(0)
  })

  test('audioBarWaveWidth is what the parts, their gaps and the margin leave of the columns', () => {
    // 4 + 10 + 10 + 1 cells, a gap after each of the four parts, a margin of 2.
    expect(audioBarWaveWidth(100, ['🔴🎙', 'm: 🔇 Mute', 's: ⏹ Stop', '│'])).toBe(69)
    expect(audioBarWaveWidth(100, ['ab'], 0, 0)).toBe(98)
    expect(audioBarWaveWidth(10, ['🔴🎙', 'm: 🔇 Mute'])).toBe(0)
  })

  test('liveColors keeps the valid stored colors and defaults the rest', () => {
    expect(liveColors(undefined)).toEqual(DEFAULT_COLORS)
    expect(DEFAULT_COLORS).toEqual({ user: 'green', agent: 'cyan', dot: 'red', idle: 'gray' })
    expect(liveColors({ user: 'blue', agent: 'pink', dot: 7 })).toEqual({ ...DEFAULT_COLORS, user: 'blue' })
    expect(liveColors('red')).toEqual(DEFAULT_COLORS)
    expect(liveColors([1])).toEqual(DEFAULT_COLORS)
  })

  test('wave loops through its frames at a fixed width', () => {
    expect(wave(0)).toHaveLength(8)
    expect(wave(1)).not.toBe(wave(0))
    expect(wave(8)).toBe(wave(0))
    expect(wave(-1)).toBe(wave(7))
  })
})
