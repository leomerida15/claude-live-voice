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
| `/live voice <name>` | Changes the Kokoro voice, for example `ef_dora` or `em_alex`. |
| `/live status` | Shows the current state, the voice and the queue. |

While live mode is on, a band above the prompt shows
`🎙 live · <state>`, where the state is `listening`, `transcribing`, `thinking`,
`speaking` or `muted`. Next to the state is a small meter: while listening it is
the live microphone level of the last second (`▁▁▃▅█▇▃▁`), so you can see the mic
hears you; while Claude speaks it is a looping wave. The band also shows how many
sentences are waiting to be spoken and which voice is in use. Focus the band with `ctrl+x tab`, then press
`m` to mute or unmute, or `s` to stop speaking.

To mute or stop straight from the prompt, bind chords in
`~/.claude/keybindings.json`. A mod cannot define its own keybinding actions,
so the band's buttons borrow two that Claude Code does not act on:
`permission:toggleDebug` presses Mute and `footer:dismiss` presses Stop.

```json
{
  "bindings": [
    { "context": "Global", "bindings": { "meta+space": "permission:toggleDebug", "meta+s": "footer:dismiss" } }
  ]
}
```

`meta` is Alt on Linux. Use a chord or a modified key: a bare letter does not
reach the band. `ctrl+m` is Enter in a terminal, and many desktops keep
`Super+Space` for themselves. If a chord does nothing, run `claude --debug` to
see binding warnings, or try the `Chat` context.

Press `Esc` while Claude answers to interrupt the turn. That also stops playback
and drops the sentences still waiting to be spoken.

Only replies to prompts you spoke are read aloud. Prompts you type are answered
as usual, in silence. Code blocks are never read: the mod says "código omitido"
once instead.

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
| `vadEndSilenceMs` | `800`: silence that ends an utterance |
| `vadStartFrames` | `3`: loud 30 ms frames in a row that start an utterance |
| `vadThresholdFactor` | `3`: how many times louder than the room's noise speech must be |

The last four tune the echo guard and the voice detector. If the reply's echo
is taken for speech, raise `echoTailMs` or `vadThresholdFactor`; if your
sentences are cut in two, raise `vadEndSilenceMs`. A value that is not a
positive number falls back to its default.

## Limitations

- **Half-duplex.** The microphone ignores audio while Claude speaks, so the reply
  is not transcribed back as a new prompt. You cannot interrupt by talking; press
  `Esc` or the band's `s` button instead.
- **No global keys.** A mod cannot bind keys outside the terminal. To mute from
  anywhere, use your desktop's microphone mute shortcut (on KDE, for example, a
  shortcut such as `Meta+Space` bound to "Mute microphone").
- **Energy-based voice detection.** A loud, steady background noise can end your
  sentence early or start a false one. The detector calibrates to the room's
  noise during the first half second, so start live mode in a quiet moment.
- **Linux only.** Recording and playback use ALSA and PulseAudio tools.

## Development

Before a release, run the interactive checklist in [docs/smoke-test.md](docs/smoke-test.md).

```
claude plugin validate .
claude plugin test .
python3 -I -m unittest discover -s test -p 'test_*.py'
```
