import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CHORDS, SUGGESTED_CHORDS, applyChords, checkChord, chordLabel, chordsHint, liveChords, parseLiveCommand, readChords } from '../hooks/text.ts'

const MUTE = 'permission:toggleDebug'
const STOP = 'footer:dismiss'

describe('chords', () => {
  test('checkChord normalizes modifiers: alt, opt and option are meta; order ctrl, meta, shift', () => {
    expect(checkChord('alt+m')).toEqual({ chord: 'meta+m' })
    expect(checkChord(' Option+S ')).toEqual({ chord: 'meta+s' })
    expect(checkChord('shift+control+k')).toEqual({ chord: 'ctrl+shift+k' })
    expect(checkChord('meta+space')).toEqual({ chord: 'meta+space' })
    expect(checkChord('ctrl+]')).toEqual({ chord: 'ctrl+]' })
    expect(checkChord('ctrl+\\')).toEqual({ chord: 'ctrl+\\' })
    expect(checkChord('meta+F5')).toEqual({ chord: 'meta+f5' })
    expect(checkChord('ctrl+7')).toEqual({ chord: 'ctrl+7' })
  })

  test('checkChord refuses bare keys, shift alone, unknown parts and reserved chords', () => {
    for (const bad of ['m', 'space', 'shift+m', 'hyper+m', 'ctrl+meta', 'ctrl+enter', 'meta+f13', 'ctrl+m+k', 'ctrl+ctrl+k', '', 'meta+m meta+s']) {
      expect('error' in checkChord(bad)).toBe(true)
    }
    for (const reserved of ['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+i', 'ctrl+[', 'ctrl+h', 'ctrl+z', 'ctrl+x']) {
      const checked = checkChord(reserved)
      expect('error' in checked && checked.error).toMatch(/reserved|taken/)
    }
  })

  test('the suggested chords all pass, the defaults are meta+m and meta+s, meta shows as alt', () => {
    for (const chord of SUGGESTED_CHORDS) expect(checkChord(chord)).toEqual({ chord })
    expect(DEFAULT_CHORDS).toEqual({ mute: 'meta+m', stop: 'meta+s' })
    expect(chordLabel('meta+space')).toBe('alt+space')
    expect(chordLabel('ctrl+meta+k')).toBe('ctrl+alt+k')
    expect(chordsHint({ mute: 'meta+m', stop: 'ctrl+]' })).toBe('alt+m mute · ctrl+] stop')
  })

  test('liveChords keeps valid, different stored chords and falls back otherwise', () => {
    expect(liveChords(undefined)).toEqual(DEFAULT_CHORDS)
    expect(liveChords({ mute: 'alt+q', stop: 'ctrl+]' })).toEqual({ mute: 'meta+q', stop: 'ctrl+]' })
    expect(liveChords({ mute: 'ctrl+c', stop: 'ctrl+]' })).toEqual({ mute: 'meta+m', stop: 'ctrl+]' })
    expect(liveChords({ mute: 'meta+x', stop: 'meta+x' })).toEqual(DEFAULT_CHORDS)
  })

  test('applyChords creates a file when there is none', () => {
    const made = applyChords(undefined, { mute: 'meta+m', stop: 'meta+s' })
    expect('text' in made && JSON.parse(made.text)).toEqual({ bindings: [{ context: 'Global', bindings: { 'meta+m': MUTE, 'meta+s': STOP } }] })
  })

  test('applyChords replaces only the two actions, in every context, and keeps the rest', () => {
    const before = {
      $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'alt+space': MUTE, 'ctrl+s': null } },
        { context: 'Global', bindings: { 'alt+s': STOP, 'ctrl+t': 'app:toggleTodos' } },
      ],
    }
    const after = applyChords(JSON.stringify(before), { mute: 'meta+q', stop: 'ctrl+]' })
    expect('text' in after).toBe(true)
    if (!('text' in after)) return
    expect(after.text.endsWith('\n')).toBe(true)
    expect(after.text).toContain('\n  "bindings": [')
    expect(JSON.parse(after.text)).toEqual({
      $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+s': null } },
        { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos', 'meta+q': MUTE, 'ctrl+]': STOP } },
      ],
    })
    expect(readChords(after.text)).toEqual({ mute: 'meta+q', stop: 'ctrl+]' })
  })

  test('applyChords refuses invalid JSON, a wrong shape and a chord bound to another action', () => {
    expect('error' in applyChords('{ nope', DEFAULT_CHORDS)).toBe(true)
    expect('error' in applyChords('{"bindings": 3}', DEFAULT_CHORDS)).toBe(true)
    expect('error' in applyChords('[]', DEFAULT_CHORDS)).toBe(true)
    const taken = applyChords(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'alt+m': 'chat:fastMode' } }] }), DEFAULT_CHORDS)
    expect('error' in taken && taken.error).toMatch(/chat:fastMode/)
  })

  test('/live config keys, keys apply, mute and stop parse; a bad chord answers why', () => {
    expect(parseLiveCommand('config keys')).toEqual({ kind: 'config-keys' })
    expect(parseLiveCommand('config keys apply')).toEqual({ kind: 'config-keys-apply' })
    expect(parseLiveCommand('config mute alt+q')).toEqual({ kind: 'config-chord', which: 'mute', chord: 'meta+q' })
    expect(parseLiveCommand('config stop ctrl+]')).toEqual({ kind: 'config-chord', which: 'stop', chord: 'ctrl+]' })
    const bad = parseLiveCommand('config mute ctrl+c')
    expect(bad.kind).toBe('error')
    expect(bad.kind === 'error' && bad.message).toMatch(/reserved/)
    expect(parseLiveCommand('mute')).toEqual({ kind: 'mute' })
  })
})
