/** `connecting`: the Codex engine's call is being set up (the local engine never shows it). */
export type LiveVoiceState = 'off' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted'

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

/** One of the terminal's named colors. */
export type LiveVoiceNamedColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray'

/** A theme key the band offers: drawn in the person's theme, so it follows a theme change. */
export type LiveVoiceThemeColor =
  | 'claude'
  | 'success'
  | 'suggestion'
  | 'warning'
  | 'error'
  | 'permission'
  | 'planMode'
  | 'ide'
  | 'remember'
  | 'inactive'
  | 'subtle'

/** A color the band takes: a theme key, a named color, or a custom `#rrggbb` (lowercase). */
export type LiveVoiceColor = LiveVoiceThemeColor | LiveVoiceNamedColor | `#${string}`

/**
 * The band's colors, set with `/live config` and kept in `$.store` under
 * `colors`: the wave while the person speaks (`user`) and while Claude speaks
 * (`agent`), the live dot and the muted mic (`dot`), the flat line (`idle`).
 */
export type LiveVoiceColors = { user: LiveVoiceColor; agent: LiveVoiceColor; dot: LiveVoiceColor; idle: LiveVoiceColor }

/** How the band's wave moves: a bouncing line, bars, or not at all (a still dim line). */
export type LiveVoiceAnimation = 'wave' | 'bars' | 'off'

/**
 * How speaking over a spoken reply interrupts it (barge-in): `off` pauses the
 * mic while Claude speaks; `headphones` listens with the normal start;
 * `speakers` needs a louder, sustained start so the reply's echo does not count.
 */
export type LiveVoiceInterrupt = 'off' | 'headphones' | 'speakers'

/**
 * Who listens and speaks: `local` (listen.py, Whisper, Kokoro) or `codex`
 * (the codex-live sidecar's realtime voice, which delegates work to Claude).
 */
export type LiveVoiceEngine = 'local' | 'codex'

/**
 * The settings `/live config` changes beside the colors, each kept in
 * `$.store` under its own key: the Kokoro voice, how the wave moves, the
 * silence (ms) that ends an utterance, how speaking interrupts a reply, the
 * engine, and the Codex realtime voice.
 */
export type LiveVoiceSettings = {
  voice: string
  animation: LiveVoiceAnimation
  silenceMs: number
  interrupt: LiveVoiceInterrupt
  engine: LiveVoiceEngine
  codexVoice: string
}

/**
 * The settings dialog's color editor: which color the theme swatches and the
 * R G B bars change, and how far one press moves a channel (1 fine, 16 coarse);
 * and the native language whose voices the voice picker lists (absent: the
 * current voice's). Picking a language does not change the voice.
 */
export type LiveVoiceEditor = { target: keyof LiveVoiceColors; step: 1 | 16; voiceLanguage?: string }

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { status: LiveVoiceStatus; colors: LiveVoiceColors; settings: LiveVoiceSettings; editor: LiveVoiceEditor }
  }
}
