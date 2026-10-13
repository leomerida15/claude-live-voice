# Feature: live-voice-mode

## Objective
A Claude Code mod that clones pi-live-codex for Claude: a hands-free live voice
conversation in the terminal, using local Whisper (STT) and Kokoro (TTS).

## Problem / Why
Claude Code's built-in `/voice` is dictation only. VoiceMode needs an explicit tool
call per turn. We want a continuous loop: speak -> prompt -> spoken reply, at no
extra cost (local services + Claude plan).

## Scope (v1)
- `/live` command: `on` | `off` (toggle with no arg), `mute`, `voice <name>`, `status`.
- Listener: `arecord` (16 kHz mono S16_LE) + energy-based VAD (Python stdlib) writing
  one WAV per utterance, path printed on stdout; long-running child via `$.process.spawn`.
- STT: `curl -F file=@... http://127.0.0.1:2022/v1/audio/transcriptions` (language es).
- Submit transcript with `$.prompt.submit({ text, asUser: true })` (engine queues while busy).
- TTS: sentence-chunk streamed `turn.step` text; queue sentences; `curl` Kokoro
  `http://127.0.0.1:8880/v1/audio/speech` -> WAV -> `paplay`. Default voice `ef_dora`.
- Half-duplex: listener ignores utterances while speaking (no echo loop).
- Cancel: aborted turn (Esc) stops playback and clears the TTS queue; `/live off` stops all.
- AbovePrompt band: state (listening / transcribing / thinking / speaking / muted),
  queue depth, buttons `m` mute, `s` stop.

## Out of scope (v1)
Barge-in while speaking, global keybindings (mic mute is handled by the KDE
Meta+Space shortcut), cloud providers, non-Linux audio.

## Constraints
- Mod API (Claude Code 2.1.296): no Node/DOM; `$.http`/`$.fs.write` text only, so all
  binary audio goes through child processes; `$.audio.play` is silent on Linux.
- Long work must be detached from hooks (hook budget).
- English for all code, comments and docs.

## Tasks
- [ ] T1 Scaffold: plugin.json, hooks.json, marketplace.json, README, .gitignore.
- [ ] T2 Audio helpers: `scripts/listen.py` (VAD recorder), `scripts/speak.sh` (Kokoro -> paplay).
- [ ] T3 Mod module `hooks/register.tsx` + state contract `types/index.d.ts`.
- [ ] T4 Tests (`*.test.ts`) and checks: `claude plugin validate`, `tsc -p`, `claude plugin test`.

## Acceptance criteria
- `claude plugin validate .` passes; type-check passes; `claude plugin test .` passes.
- Helpers run standalone (listen.py prints a WAV path per utterance; speak.sh plays text).
- Loaded with `claude --plugin-dir <repo>`, `/live` starts the loop and the band shows state.

## Delivery strategy
ask-on-risk. Forecast ~600 authored lines.

## Routes
- T1–T4: delegated direct (writer trigger: 2+ non-trivial files).

## Progress / Evidence
(pending)

## Next step
T1.
