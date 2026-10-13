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
- [x] T1 Scaffold: plugin.json, hooks.json, marketplace.json, README, .gitignore.
- [x] T2 Audio helpers: `scripts/listen.py` (VAD recorder), `scripts/speak.sh` (Kokoro -> paplay).
- [x] T3 Mod module `hooks/register.tsx` + state contract `types/index.d.ts`.
- [x] T4 Tests (`*.test.ts`) and checks: `claude plugin validate`, `tsc -p`, `claude plugin test`.

## Acceptance criteria
- `claude plugin validate .` passes; type-check passes; `claude plugin test .` passes.
- Helpers run standalone (listen.py prints a WAV path per utterance; speak.sh plays text).
- Loaded with `claude --plugin-dir <repo>`, `/live` starts the loop and the band shows state.

## Delivery strategy
ask-on-risk. Forecast ~600 authored lines.

## Routes
- T1–T4: delegated direct (writer trigger: 2+ non-trivial files).

## Progress / Evidence
- T1 done (route: delegated direct). Commit b3c2487. Evidence: `claude plugin validate .` passed with no warnings
  (marketplace, manifest with userConfig, hooks.json, state contract `live-voice.status`).

- T2 done (route: delegated direct). Commit e7eec62. RED: `python3 -I -m unittest discover -s test -p 'test_*.py'`
  -> 5 errors (script missing); GREEN: same command -> 5 tests OK (one utterance -> one WAV path, two -> two,
  120 ms blip ignored, pause flag "1" discards, "0" keeps). `bash -n scripts/speak.sh` ok;
  `echo "Hola, prueba de voz." | scripts/speak.sh ef_dora` exit 0 (audible); empty text exit 2; bad URL exit 1;
  SIGTERM mid-playback exit 143 in 3 ms, no paplay or temp WAV left. Real chain: Kokoro WAV -> listen.py --stdin
  -> one WAV (2.19 s) -> Whisper `" o la clau de que hora es en Madrid."` (same text as posting the Kokoro WAV
  directly, so the VAD does not clip; the gap is Whisper model quality).

- T3 done (route: delegated direct). Commit aed8338. Pure helpers in `hooks/text.ts` (command parsing,
  transcript filter, markdown stripping, sentence chunker with code-block skip). RED: `claude plugin test .` ->
  "the file did not load: Export named 'CODE_OMITTED' not found" (stub module); GREEN: 14 pass, 0 fail.
  `claude plugin validate .` passed (hooks: session.start, session.end, command.run{command=live}, turn.start,
  turn.step, turn.complete, ui.render{component=AbovePrompt}). Type-check with the d.ts header tsconfig kept in
  /tmp/claude-1000/live-voice-tsc: no errors. Validator rule learned: `$` may only be passed to functions declared
  at the top level of the module, so all `$`-taking helpers live at module scope.

- T4 done (route: delegated direct). Commit a26b2a8 adds engine-level tests (`/live status|voice|mute|<bad>`
  answers, band leaves the engine's drawing while off). Checks observed:
  `claude plugin validate .` passed; `tsc -p /tmp/claude-1000/live-voice-tsc` no errors;
  `claude plugin test .` 19 pass / 0 fail; `python3 -I -m py_compile scripts/listen.py` ok;
  `python3 -I -m unittest discover -s test -p 'test_*.py'` 5 OK; `bash -n scripts/speak.sh` ok.
  Headless smoke: `claude -p --plugin-dir . "/live status"` -> "Live voice is off. Voice ef_dora.";
  `"/live on"` -> "Live voice on." and the listener was gone after the session ended (no stray listen.py/arecord).
- Not verified (no runnable RED, needs a person at the mic): the interactive loop end to end (speak -> prompt ->
  spoken reply), band rendering and hotkeys in a live terminal, Esc abort stopping playback.

## Next step
Manual acceptance in an interactive session: `claude --plugin-dir <repo>`, `/live`, speak a question.
