export type LiveVoiceState = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted'

export type LiveVoiceStatus = {
  isOn: boolean
  state: LiveVoiceState
  queue: number
  voice: string
  /**
   * The mic level (0..1) while listening, smoothed (fast attack, slow decay);
   * 0 in any other state. It sets the height of the listening wave.
   */
  level: number
  /** The wave's frame: it moves 8 times a second while listening or speaking. */
  wave: number
  /** Whether the audio bar's live dot is lit: it blinks every 500 ms while on and not muted. */
  dot: boolean
}

/** A color the band takes: one of the terminal's named colors. */
export type LiveVoiceColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray'

/**
 * The band's colors, set with `/live config` and kept in `$.store` under
 * `colors`: the wave while the person speaks (`user`) and while Claude speaks
 * (`agent`), the live dot and the muted mic (`dot`), the flat line (`idle`).
 */
export type LiveVoiceColors = { user: LiveVoiceColor; agent: LiveVoiceColor; dot: LiveVoiceColor; idle: LiveVoiceColor }

/** How the band's wave moves: a bouncing line, bars, or not at all (a still dim line). */
export type LiveVoiceAnimation = 'wave' | 'bars' | 'off'

/**
 * The settings `/live config` changes beside the colors, each kept in
 * `$.store` under its own key: the Kokoro voice, how the wave moves, and the
 * silence (ms) that ends an utterance.
 */
export type LiveVoiceSettings = { voice: string; animation: LiveVoiceAnimation; silenceMs: number }

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { status: LiveVoiceStatus; colors: LiveVoiceColors; settings: LiveVoiceSettings }
  }
}
