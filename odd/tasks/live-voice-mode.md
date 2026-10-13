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

### v1 hardening (authorized 2026-10-13)
- [x] T5 `CLAUDE.md`: what the mod is, layout, all checks, dev-run, mod API gotchas.
- [x] T6 Correlate live turns by prompt origin (`prompt.submit` hook sees `origin.kind === 'plugin'`,
  `name === 'live-voice'`), not by matching the raw transcript text. Test-first.
- [x] T7 Scope processes per session: a session token in the children's argv, a per-session runtime dir
  and pause flag; stop/silence kill only this session's children (no global `pkill -f <script>`). Test-first.
- [x] T8 Hot-reload recovery: on `session.start`, kill this session's orphaned children; if `$.state` says
  live was on, resume the listener (product decision: resume, not switch off). Test-first.
- [x] T9 Echo-guard tunables: `userConfig` options for the post-playback tail and the VAD thresholds,
  passed to `listen.py` as flags; defaults unchanged. Test-first (python + engine tests).
- [x] T10 Interactive smoke-test checklist for the human (`docs/smoke-test.md`), linked from the README.

## Acceptance criteria
- `claude plugin validate .` passes; type-check passes; `claude plugin test .` passes.
- Helpers run standalone (listen.py prints a WAV path per utterance; speak.sh plays text).
- Loaded with `claude --plugin-dir <repo>`, `/live` starts the loop and the band shows state.

## Delivery strategy
ask-on-risk. Forecast ~600 authored lines.

## Routes
- T1–T4: delegated direct (writer trigger: 2+ non-trivial files).
- T5: inline (one doc file, already understood). T6–T9: delegated direct (module + tests + types/scripts).
  T10: inline (one doc file).

## Out of scope (hardening)
Barge-in, global keybindings, cloud providers.

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

- T6 done (route: delegated direct). Live prompts are records `{ sent, entered, isEntering }` kept from the
  plugin's own `$.prompt.submit` call: its result is the prompt as it entered (after other plugins' rewrites, or
  a drop); `turn.start` claims the oldest record whose sent or entered text the turn's text holds (merged queued
  prompts), else the oldest still entering. Raw transcript equality is gone. Deviation from the plan: the plugin's
  own `prompt.submit` hook never runs for its own `$.prompt.submit` (observed in the test kit: neither the hook nor
  its `.catch` re-entry handler is called; the same prompt raised by the test does reach it), so the record lives
  in the submit call, not in a hook; the CLAUDE.md gotcha about `prompt.submit` hooks seeing the plugin origin
  holds for other plugins' hooks only. New engine harness `test/fake.ts` (processes, files, session id, mocked
  clock, model reply). RED: `claude plugin test .` -> 2 fail ("a transcript the plugin submitted is a live turn
  even when another plugin rewrites it" and "queued live prompts merged into one turn", spoken `[]`); GREEN: 26
  pass / 0 fail (with 4 `claim` unit tests). `claude plugin validate .` passed (only the pre-existing CLAUDE.md
  warning); `tsc -p <scratchpad tsconfig>` no errors; python 5 OK; `bash -n scripts/speak.sh` ok.
  Commit 238755b.

- T7 done (route: delegated direct). Session tag `live-voice-<session id>` (from `$.session.id()` at
  `session.start`, odd characters made `-`) in every child's argv: `listen.py ... --tag <tag>` (argparse accepts and
  ignores it) and `speak.sh --tag <tag> <voice>` (optional leading flag, old usage unchanged). Per-session runtime
  dir `$XDG_RUNTIME_DIR/live-voice/<session id>` holding the pause flag. Stop/silence still `return()` the stream
  first; the fallback is `pkill -TERM -f -- '<script>\. (.* )?--tag <tag>( |$)'`, never a bare script path.
  RED: `claude plugin test .` -> 2 fail (argv without `--tag`, pkill pattern without the tag);
  `python3 -I -m unittest ...` -> 1 error (`--tag` exit 2) + 1 fail (speak.sh took `--tag` as the voice).
  GREEN: engine 30 pass / 0 fail (incl. `sessionTag`/`killPattern` unit tests); python 8 OK. Real pkill check:
  two sleepers tagged `live-voice-AAA` and `live-voice-AAAB`, the pattern for AAA killed only AAA.
  `claude plugin validate .` passed (pre-existing CLAUDE.md warning); tsc no errors; `bash -n` ok.
  Not covered: children started before a `/clear` (new session id, no `session.start`) keep the old tag, which the
  module still holds until a reload. Commit 32ff9f1.

- T8 done (route: delegated direct). `session.start` reads the status before anything else, lets go of the children
  the module held and resets its runtime state, keeps the status on when it was on, and detaches `recover` with
  `$.clock.after(0)`: scoped kill of this session's `listen.py` and `speak.sh` orphans (T7 pattern), then, when live
  was on, `start` again (muted again if the status said muted). In tests a reload is a second `session.start` with
  `$.state` saying on (the kit has no `$.state` noun on the test's `$` to seed it directly). RED:
  `claude plugin test .` -> 1 fail (no scoped pkill and no second listener after the second `session.start`);
  GREEN: 33 pass / 0 fail (resume, start while off spawns nothing, resume muted). `claude plugin validate .` passed
  (pre-existing CLAUDE.md warning); tsc no errors; python 8 OK; `bash -n` ok.
  Not verified: a real hot reload in an interactive session (needs a person). Commit 5975774.

- T9 done (route: delegated direct). `userConfig` numbers `echoTailMs` (350), `vadEndSilenceMs` (800),
  `vadStartFrames` (3), `vadThresholdFactor` (3, listen.py's `START_RATIO` over the calibrated noise floor);
  `tunable()` falls back to the default on NaN, <= 0, infinity or non-numbers, frame and ms values rounded and at
  least 1. `listen.py` takes `--end-silence-ms`, `--start-frames`, `--threshold-factor` (same defaults, argparse
  refuses non-positive or non-finite values with exit 2); register passes them. README Settings table documents
  them. RED: python -> 3 errors (unrecognized flags); engine -> 3 fail (no tunables in the listener argv, and the
  status was already `listening` 400 ms after playback with `echoTailMs` 1000). GREEN: python 12 OK (shorter end
  silence splits two utterances the default joins, 20 start frames ignore a 0.4 s burst, factor 8 ignores a quiet
  voice over a 200 rms floor, bad values refused); engine 38 pass / 0 fail (incl. `tunable` unit tests).
  `claude plugin validate .` passed (pre-existing CLAUDE.md warning); tsc no errors; `bash -n` ok.
  Commit aec8393.
- Follow-up for CLAUDE.md (outside T6–T9's edit surface): the gotcha "its `prompt.submit` hooks see
  `origin: { kind: 'plugin', ... }`" holds for other plugins' hooks; the plugin's own hook does not run for its own
  `$.prompt.submit` (test kit). Engine tests need `{ value }`-wrapped answers for `$` nouns and ~1 s of real time
  per mocked-clock advance while a stream is open (hence `timeoutMs: 30_000`).

- T10 done (route: inline). `docs/smoke-test.md`: preconditions, start, one spoken turn, echo guard, code
  skipping, typed prompts silent, controls, two sessions (process scoping), hot reload, failure paths.
  Linked from README. Passive doc: structural readback only. CLAUDE.md corrected (own `prompt.submit`
  hook does not see own submissions) and the expected validate warning documented.

## Next step
The human runs `docs/smoke-test.md` with the microphone and reports failed steps. Not verified yet:
the real voice loop, a real hot reload, two concurrent sessions. Known gap: children started before a
`/clear` keep the old session tag, so a later reload misses them.
