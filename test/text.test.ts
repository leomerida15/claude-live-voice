import { describe, expect, test } from 'claude-code/testing'

import {
  CODE_OMITTED,
  SentenceChunker,
  cleanTranscript,
  parseLiveCommand,
  stripMarkdown,
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
