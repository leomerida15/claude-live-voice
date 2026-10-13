# live-voice

A Claude Code mod for hands-free voice conversation in the terminal. You talk,
local Whisper transcribes what you said and submits it as your prompt, and
Claude's reply is read aloud sentence by sentence through local Kokoro. Then the
mod listens again.

Claude Code's built-in `/voice` only dictates. VoiceMode needs a tool call for
every turn. This mod keeps the loop running by itself, and because both speech
services run locally, it adds no cost beyond your Claude plan.

## Requirements

- Linux with PipeWire or PulseAudio. The mod uses `arecord` (alsa-utils) to
  record and `paplay` (pulseaudio-utils or pipewire-pulse) to play.
- `python3` (standard library only), `curl` and `bash`.
- A local OpenAI-compatible **Whisper** server, by default
  `http://127.0.0.1:2022/v1/audio/transcriptions` (whisper.cpp server).
- A local OpenAI-compatible **Kokoro** server, by default
  `http://127.0.0.1:8880/v1/audio/speech`.

[VoiceMode](https://github.com/mbailey/voicemode) installs and runs both
services (`voicemode service install whisper` and `voicemode service install kokoro`).

## Install

From the prompt of a Claude Code terminal session:

```
/plugin install live-voice --marketplace leomerida15/claude-live-voice
```

Answer `y` to add the marketplace, then pick a scope.

To develop it, load it straight from a checkout:

```
claude --plugin-dir /path/to/claude-live-voice
```

## Usage

| Command | What it does |
| --- | --- |
| `/live` | Turns live mode on or off. |
| `/live on` / `/live off` | Starts or stops live mode. `off` also stops playback. |
| `/live mute` | Mutes or unmutes the microphone. Replies are still spoken. |
| `/live voice <name>` | Changes the Kokoro voice, for example `ef_dora` or `em_alex`, and keeps it. |
| `/live status` | Shows the current state, the voice and the queue. |
| `/live config` | Opens the settings dialog: voice, colors, animation, end-of-speech silence, interrupt. |
| `/live-config` | The same dialog as `/live config`; every `/live config ...` shortcut works as `/live-config ...` (a command name cannot hold a colon, so there is no `/live:config`). |
| `/live config voice <name>` | Sets the voice, like `/live voice`. |
| `/live config test` | Says a short sample in the selected voice (Spanish voices in Spanish, the rest in English). |
| `/live config <user\|agent\|dot\|idle> <color>` | Sets one color directly: a theme color, a named color or `#rrggbb`, for example `/live config agent magenta`, `/live config user claude` or `/live config dot #ff8800`. |
| `/live config animation <wave\|bars\|off>` | How the band's wave moves. |
| `/live config silence <1000\|1500\|2000\|2500\|3000>` | The silence (ms) that ends what you say; restarts the listener. |
| `/live config interrupt <off\|headphones\|speakers>` | How speaking over a reply interrupts it (see [Interrupting by voice](#interrupting-by-voice)). |
| `/live config reset` | Restores every setting above to its default. |

While live mode is on, a band of two rows sits above the prompt.

The **audio bar** reads `●🎙  m: 🔇 Mute  s: ⏹ Stop  │ ▁▁▃▅█▇▃▁…`: a red dot that
blinks while the microphone is live (a steady red `🔇` while muted), the Mute and
Stop controls, then a wave across the rest of the band. While listening the wave
is a still green line until your voice is heard, then the same moving wave
Claude speaks with, in green, so you can see the mic hears you; while Claude
speaks it is that wave in cyan; otherwise it is a flat dim gray line. The colors and the animation can be changed (see Live settings).

The **text bar** below reads `<state> · <voice>`, plus `N queued` while
sentences wait to be spoken, with the current mute and stop chords on the
right (`alt+m mute · alt+s stop` by default). The state is `listening`, `transcribing`,
`thinking`, `speaking` or `muted`. In a narrow terminal the chord hint goes
first, then the wave shrinks; the controls are never cut.

Focus the band with `ctrl+x tab`, then press `m` to mute or unmute, or `s` to
stop speaking.

To mute or stop straight from the prompt, chords are bound in
`~/.claude/keybindings.json`. A mod cannot define its own keybinding actions,
so the band's buttons borrow two that Claude Code does not act on:
`permission:toggleDebug` presses Mute and `footer:dismiss` presses Stop.

Pick the chords from the settings dialog (`Shortcuts  Mute ▾  Stop ▾`) or with
`/live config mute <chord>` and `/live config stop <chord>` (defaults `alt+m`
and `alt+s`; many desktops take `alt+space`). `/live config keys` shows the
chords and what the file binds; `/live config keys apply` writes the current
ones. Claude Code reloads the file on its own.

The mod edits only those two entries: it removes every binding to
`permission:toggleDebug` or `footer:dismiss`, in any context, adds the new
chords under `Global`, and keeps every other binding and field. Before each
write it copies the old file to `keybindings.json.live-voice.bak`; a missing
file is created. A file that is not valid JSON, or a chord another action
already holds, is never overwritten: the answer says why. The file is written
only when you change a chord, never on its own.

```json
{
  "bindings": [
    { "context": "Global", "bindings": { "meta+m": "permission:toggleDebug", "meta+s": "footer:dismiss" } }
  ]
}
```

`meta` is Alt on Linux (the hint shows it as `alt`). A chord needs `ctrl` or
`alt` plus a letter, digit, `space`, punctuation or f1-f12: a bare or shifted
key types into the prompt. Reserved chords are refused (`ctrl+c`, `ctrl+d`,
`ctrl+m`, `ctrl+i`, `ctrl+[`, `ctrl+h`, `ctrl+z`, and `ctrl+x`, the prefix of
Claude Code's own chords). If a chord does nothing, run `claude --debug` to see
binding warnings.

Press `Esc` while Claude answers to interrupt the turn. That also stops playback
and drops the sentences still waiting to be spoken.

Only replies to prompts you spoke are read aloud. Prompts you type are answered
as usual, in silence. Code blocks are never read: the mod says "código omitido"
once instead.

## Interrupting by voice

While Claude speaks a reply to a prompt you spoke, the microphone keeps
listening. Speak over the reply and the mod cuts the voice at once, drops the
sentences still waiting, aborts Claude's turn (as `Esc` does) and sends what you
said as the next prompt. Prompts you typed are never aborted by voice, and while
the microphone is muted nothing interrupts. The `interrupt` setting chooses how:

| Mode | While a reply plays |
| --- | --- |
| `speakers` (default) | Listens, but speech must be twice as far over the room's noise as usual and last about 400 ms, so the reply's own echo does not count. The pause after playback (`echoTailMs`) still applies. |
| `headphones` | Listens with the normal thresholds: no echo reaches the microphone. |
| `off` | The microphone is paused while Claude speaks (half-duplex). Interrupt with `Esc` or the band's `s` button. |

Echo cancellation helps barge-in on speakers. PulseAudio and PipeWire offer
`module-echo-cancel`; the mod never loads it or changes your audio setup, but
you may set it up yourself and make its source the default microphone.

## Live settings

`/live config` opens a dialog with one picker per setting, plus `Restore` (the
defaults) and `Close`; `Esc` closes it too. Changes take at once and are kept
for later sessions. In fullscreen the dialog docks beside the transcript and
asks for 100 columns (a width you drag it to wins); its rows pack to the width
it gets, so nothing wraps. Where the dialog cannot be shown, `/live config`
answers with every current setting and the commands that change them.

| Setting | What it changes | Default |
| --- | --- | --- |
| Voice | The Kokoro voice, shown as `Dora · Spanish · female (ef_dora)`. The list comes from Kokoro (`/v1/audio/voices`), grouped by each voice's native language (the id's first letter: `a` American English, `b` British English, `e` Spanish, `f` French, `h` Hindi, `i` Italian, `j` Japanese, `p` Brazilian Portuguese, `z` Mandarin Chinese; the second letter is `f` female or `m` male), the session `language` first; a built-in list when Kokoro does not answer. Two pickers, as a picker takes at most 64 entries and Kokoro lists more: `Language` (starts on the current voice's), then `Voice` with only that language's voices (`Dora (female)`); changing the language alone keeps the voice. `Test voice` (hotkey `t`) says a sample with it; it is refused while a reply is being spoken. | `voice` below |
| Animation | `wave` (a line bouncing with the sound), `bars` (the same, as bars) or `off` (a still dim line). | `wave` |
| End silence | 1000-3000 ms of silence that ends what you say; a change restarts the listener. | `vadEndSilenceMs` below |
| Interrupt | How speaking over a reply interrupts it: `off`, `headphones` or `speakers` (see [Interrupting by voice](#interrupting-by-voice)). | `speakers` |
| Colors | The band's colors, below. | |
| Shortcuts | The mute and stop chords, written to `~/.claude/keybindings.json` (see above). `Restore` leaves them as they are. | `alt+m`, `alt+s` |

### Colors

| Color | Colors | Default |
| --- | --- | --- |
| `user` | The line while listening, and the wave while you speak. | `green` |
| `agent` | The wave while Claude speaks. | `cyan` |
| `dot` | The blinking live dot and the muted mic. | `red` |
| `idle` | The flat line while muted, transcribing or thinking. | `gray` |

A color is one of:

- a **theme color**, drawn in your Claude Code theme so it follows a theme
  change: `claude`, `success`, `suggestion`, `warning`, `error`, `permission`,
  `planMode`, `ide`, `remember`, `inactive`, `subtle` (any case);
- a **named color** of the terminal: `red`, `green`, `yellow`, `blue`,
  `magenta`, `cyan`, `white`, `gray`;
- a **custom** `#rrggbb` (or `#rgb`), kept as lowercase `#rrggbb`.

In the dialog, `Edit color` picks which color the editor below it changes:
the `Theme` row of swatches (`●` in each theme color, press one to use it),
and the `Red`, `Green`, `Blue` bars, each with `−` and `+` (hotkeys `q`/`w`,
`a`/`s`, `z`/`x` while the dialog has the keyboard). `1` makes a press move a
channel by 1, `2` by 16 (the default). A theme color has no RGB here, so its
bars start at mid gray; a named color's start at its usual RGB. `Preview`
draws the wave in the color, and the band changes at once. The live dot is
`●`, not an emoji, so it can take a color.

## Settings

Set these in `/config` or in `pluginConfigs["live-voice"].options` in
`settings.json`:

| Option | Default |
| --- | --- |
| `voice` | `ef_dora` |
| `language` | `es` |
| `whisperUrl` | `http://127.0.0.1:2022/v1/audio/transcriptions` |
| `kokoroUrl` | `http://127.0.0.1:8880/v1/audio/speech` |
| `echoTailMs` | `350`: pause after a reply is spoken before listening again |
| `vadEndSilenceMs` | `2000`: silence that ends an utterance, so a pause to think does not cut a sentence |
| `vadStartFrames` | `3`: loud 30 ms frames in a row that start an utterance |
| `vadThresholdFactor` | `3`: how many times louder than the room's noise speech must be |

The last four tune the echo guard and the voice detector. If the reply's echo
is taken for speech, raise `echoTailMs` or `vadThresholdFactor`; if your
sentences are cut in two, raise `vadEndSilenceMs`. A value that is not a
positive number falls back to its default.

## Limitations

- **Barge-in on speakers is a threshold, not echo cancellation.** With
  `interrupt speakers` the reply's own sound reaches the microphone; only speech
  clearly louder than it (and held about 400 ms) interrupts. A loud speaker, a
  quiet voice or a far microphone can miss a barge-in or take the echo for one:
  use headphones, lower the volume, or set `interrupt off`.
- **No global keys.** A mod cannot bind keys outside the terminal. To mute from
  anywhere, use your desktop's microphone mute shortcut (on KDE, for example, a
  shortcut such as `Meta+Space` bound to "Mute microphone").
- **Energy-based voice detection.** A loud, steady background noise can end your
  sentence early or start a false one. The detector calibrates to the room's
  noise during the first half second, so start live mode in a quiet moment.
- **Linux only.** Recording and playback use ALSA and PulseAudio tools.
- **Kokoro restarts.** VoiceMode's Kokoro service restarts itself every 25
  requests (`UVICORN_LIMIT_MAX_REQUESTS=25` in its systemd unit) and is gone
  for about 30 s each time. `speak.sh` keeps trying for up to 40 s
  (`KOKORO_RETRY_S`), so a reply pauses there instead of losing sentences.
  When a sentence still fails, the toast carries `speak.sh`'s reason (curl's
  error, Kokoro's HTTP status and answer, or paplay's message).

## Development

Before a release, run the interactive checklist in [docs/smoke-test.md](docs/smoke-test.md).

```
claude plugin validate .
claude plugin test .
python3 -I -m unittest discover -s test -p 'test_*.py'
```
