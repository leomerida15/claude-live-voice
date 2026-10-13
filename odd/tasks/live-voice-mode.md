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
Global keybindings (mic mute is handled by the KDE
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
- [x] T6 Correlate live turns with the plugin's own submissions: each `$.prompt.submit` keeps a record
  (post-rewrite text from the submit result, or a drop); `turn.start` claims the oldest matching record
  instead of matching the raw transcript text. (A `prompt.submit` hook was planned, but a plugin's own hook
  does not run for its own submission.) Test-first.
- [x] T7 Scope processes per session: a session token in the children's argv, a per-session runtime dir
  and pause flag; stop/silence kill only this session's children (no global `pkill -f <script>`). Test-first.
- [x] T8 Hot-reload recovery: on `session.start`, kill this session's orphaned children; if `$.state` says
  live was on, resume the listener (product decision: resume, not switch off). Test-first.
- [x] T9 Echo-guard tunables: `userConfig` options for the post-playback tail and the VAD thresholds,
  passed to `listen.py` as flags; defaults unchanged. Test-first (python + engine tests).
- [x] T10 Interactive smoke-test checklist for the human (`docs/smoke-test.md`), linked from the README.
- [x] T11 Prompt-level chords for the band (authorized 2026-10-13): the Mute and Stop buttons also declare
  `action` with engine keybinding actions the engine ignores (`permission:toggleDebug` for mute,
  `footer:dismiss` for stop), so a chord the user binds in `~/.claude/keybindings.json` (suggested
  `meta+space`, `meta+s`) presses them from the prompt. A mod cannot define its own action names.
  Docs: README and smoke test. Test-first where the test kit can press a Button by action.
- [x] T12 Live voice meter in the band (authorized 2026-10-13, user chose the real meter over a canned
  animation): `listen.py` prints throttled `level <0..1>` lines (about 8 per second) beside the WAV paths
  while listening; the mod keeps a short history and the band draws it as a sparkline (`▁▂▃▅▇`) while
  listening; while speaking, a looping wave animation driven by `$.clock`, stopped when speech ends.
  Redraw rate bounded; no level lines while paused. Test-first (python + engine).
- [x] T13 Band layout (user feedback 2026-10-13, design refined twice the same day): two rows. The audio
  bar: a blinking red dot (~500 ms) and the mic (`🔇` in red, steady, while muted), the plain Mute and
  Stop Buttons (same `key`, `hotkey`, `action`; emoji labels), a dim `│`, then the wave filling the rest
  of `bodyColumns` (emoji counted 2 cells, margin 2): the mic meter while listening (green, scrolling,
  newest right), the moving wave while speaking (cyan), else a flat dim line. The text bar: dim
  `<state> · <voice>` (+ `N queued`), right-aligned `alt+space mute · alt+s stop`. Narrow: the hint goes
  first, then the wave shrinks (omitted under 4 cells); controls never cut. History capped at 200
  levels, appended only while listening (R3-002). Test-first (engine + helpers).

- [x] T14 `/live config` colors (authorized 2026-10-13): `user` (wave while the person speaks, default
  green), `agent` (wave while Claude speaks, default cyan), `dot` (blinking dot, default red), `idle` (flat
  line, default gray), persisted in `$.store` across sessions, loaded on session.start, read by the band.
  `/live config` opens a dialog pane with one Select per color, Restore and Close; changes apply live.
  `/live config <user|agent|dot|idle> <color>` sets one; `/live config reset` restores defaults; bad input
  answers the usage with the valid values. Parser in `hooks/text.ts` with unit tests; engine tests.

### Live-test feedback (authorized 2026-10-13)
- [x] T15 Longer end-of-speech silence: default `vadEndSilenceMs` 2000 ms (listen.py, manifest, register,
  README, tests; folds in an uncommitted 800 -> 1500 edit). A 1.5 s pause inside speech no longer splits.
- [x] T16 Speaking-style mic animation: the listening wave is a moving wave (like the speaking one) whose
  height follows the current smoothed mic level (fast attack, slow decay), not a scrolling history; the
  200-level history leaves `$.state`. Pure `bounceRow(frame, level, width)` + engine test.
- [x] T17 `/live config` that always shows: a focused dialog with voice (Kokoro's voice list, static
  fallback), the four colors, animation (`wave|bars|off`) and end-of-speech silence (1000-3000 ms,
  restarts the listener); persisted in `$.store`; text summary answer when the pane is not placed;
  shortcuts `voice|<target>|animation|silence|reset`; `/live` hint mentions config.
- [x] T18 Surface speak.sh failures: its stderr's first line in the toast; specific speak.sh errors
  (HTTP status and body, mktemp, paplay); reproduce the ~35 ms exit-1 failures and fix a deterministic cause.
- [x] T19 Listening animation identical to the speaking one (user request after a live test): with
  animation `wave`, while listening and the smoothed mic level is at or above `SPEECH_GATE` (0.15) the band
  draws exactly `waveRow(frame, width)` in the `user` color; below it, a still `flatRow` in the `user` color
  (no redraw every tick). Speaking stays `waveRow` in `agent`; `bars` and `off` unchanged. `bounceRow` removed.
- [x] T20 `/live-config` command (user request 2026-10-13: `/live:config` is impossible, a command name
  allows only letters, digits, `_`, `-`): an alias that answers exactly as `/live config <args>`.

### Settings dialog, round 2 (user-approved design 2026-10-13)
- [x] T21 Voices by native language + "Test voice": `describeVoice(id)` (Kokoro id = language letter, gender
  letter, `_name`, `v0` stripped) and `groupVoices(ids, language)` (session language first, the rest
  alphabetically, names sorted within a group); the dialog shows `Dora · Spanish · female (ef_dora)` and
  lists `Spanish — Dora (female)` options (Select has no group headers); a "Test voice" button (hotkey `t`)
  and `/live config test` speak a language-matching sample with the selected voice through speak.sh (session
  tag, kill-scoped), live on or off, mic paused while it plays, "busy" while live voice is speaking. The
  `/live config` summary describes the voice. Test-first.
- [x] T22 Theme colors + custom RGB + hex: each color target takes a theme key (follows the person's theme),
  a named color, or `#rrggbb`/`#rgb` (normalized lowercase `#rrggbb`); defaults unchanged. Pure `parseColor`,
  `hexToRgb`, `rgbToHex`, `stepChannel`, `channelBar`. Dialog: a target picker, a row of theme swatches, R/G/B
  bars with −/+ (hotkeys q/w, a/s, z/x), step `1` fine (1) / `2` coarse (16, default), a live preview. Shortcut
  `/live config <target> <theme|name|#hex>`; usage lists the kinds. Test-first.
- [x] T23 Two-step voice picker (bug from a live session: the engine refused the pane, `Select "voice" options
  must be 1 to 64 entries`, Kokoro lists 67 voices): a "Language" Select of the native languages present
  (session language first, per `groupVoices`) and a "Voice" Select of only that language's voices, labelled
  `Dora (female)`. The language defaults to the current voice's; changing it does not change the voice until
  one is picked. The language choice lives in the `editor` state (`voiceLanguage`). A pure `selectOptions`
  guard caps any option list at 64 (sorted input kept in order). Test-first with the real 67 Kokoro ids.
- [x] T24 Wider, non-wrapping settings dock (live session, fullscreen 189 columns: the pane docked on the
  right ~50 columns wide; each RGB bar split over two lines, value digits split, the voice row wrapped). Open
  with `columns: 100` (the dock's width request; the person's drag wins) besides `rows` inline. The layout
  reads the Pane's `bodyColumns` and packs compact fields into rows that fit (a pure `packRows`): language,
  voice and Test on one row when wide; the current voice truncated at the end; the four color pickers with a
  colored dot; one R/G/B row each with its bar sized to what is left (min 6 cells) and a 3-digit padded value;
  step, preview, animation, silence, Restore, Close. Keys, hotkeys and behavior unchanged; Selects <= 64.
  Test-first: mount at 50 and 100 columns, no drawn row wider than the body, each RGB row one Box holding its
  value, `$.ui.open` called with `columns: 100`.
- [x] T25 Configurable mute/stop chords (user: the OS takes alt+space, maybe alt+s). The chords live in
  `~/.claude/keybindings.json`; the mod manages only the bindings whose action is `permission:toggleDebug`
  (mute) or `footer:dismiss` (stop): removes them in every context, adds the new chords under `Global`, keeps
  every other binding and field, writes pretty JSON after a one-file backup (`keybindings.json.live-voice.bak`);
  creates the file when missing; never writes over invalid JSON (answers an error). Pure `checkChord`
  (ctrl/alt/meta/shift + letter, digit, space, punctuation or f1-f12; ctrl or meta required; alt spelled
  meta; reserved ctrl+c/d/m/i/[/h/z and the ctrl+x chord prefix refused) and `applyChords`. `/live config
  keys` shows them, `keys apply` writes them, `mute <chord>` / `stop <chord>` change one (mute != stop).
  Dialog row with Mute / Stop Selects of suggested chords. Defaults meta+m / meta+s; kept in `$.store`; the
  band's hint shows the current chords (meta drawn as alt). Only a change writes the file. Test-first.

### Barge-in (user-approved behavior 2026-10-13)
- [x] T26 Barge-in: interrupt the agent by speaking. When the person speaks over a spoken reply, cut the voice
  at once, drop the queued sentences, abort the live turn (`$.turn.abort({ turnId })`, the id `turn.start`
  handed the plugin), and submit what they said as the next live prompt. Setting `interrupt`
  (`off|headphones|speakers`, default `speakers`) in `/live config interrupt <mode>`, the dialog, the summary,
  `$.store`, README. Pause file modes: `1` paused (muted, interrupt off while speaking, voice test, echo tail),
  `0` normal, `2` barge-in listening with `--barge-ratio`/`--barge-frames` (speakers: 2x the start ratio and
  400 ms of sustained speech; headphones: the normal thresholds, still mode `2` so `barge` cuts the voice
  before the utterance ends). listen.py prints `barge` when an utterance starts in mode `2` and keeps the
  noise floor still there. Muted wins; typed turns are never aborted. Test-first.

## Acceptance criteria
- `claude plugin validate .` passes; type-check passes; `claude plugin test .` passes.
- Helpers run standalone (listen.py prints a WAV path per utterance; speak.sh plays text).
- Loaded with `claude --plugin-dir <repo>`, `/live` starts the loop and the band shows state.

## Delivery strategy
ask-on-risk. Forecast ~600 authored lines.

## Routes
- T1–T4: delegated direct (writer trigger: 2+ non-trivial files).
- T5: inline (one doc file, already understood). T6–T9: delegated direct (module + tests + types/scripts).
  T10: inline (one doc file). T12: delegated direct (writer trigger: listen.py, register.tsx, text.ts, tests).
  T13: delegated direct (writer trigger: register.tsx, text.ts, types, tests).
  T14: delegated direct (writer trigger: register.tsx, text.ts, types, tests).
  T15–T18: delegated direct (one bounded writer; writer trigger: listen.py, speak.sh, register.tsx,
  text.ts, types, tests, docs).
  T19: delegated direct (writer trigger: register.tsx, text.ts, tests, docs).
  T23: delegated direct (writer trigger: register.tsx, text.ts, types, tests, docs).
  T24: delegated direct (writer trigger: register.tsx, text.ts, tests, docs).
  T25: delegated direct (writer trigger: register.tsx, text.ts, tests, docs).
  T26: delegated direct (writer trigger: listen.py, register.tsx, text.ts, types, tests, docs).

## Out of scope (hardening)
Global keybindings, cloud providers (barge-in was out of scope until T26, authorized 2026-10-13).

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

- Native review (RDD on, risk high: process boundary in listen.py, shell in speak.sh) over 0aaf4ca..2db11f0:
  consent granted, 4 lenses, APPROVED with no blocking finding; acknowledgement burned the authority
  (lineage review-d0d472deb46aefce). Non-blocking follow-ups, not scheduled:
  - R3 merged queued live prompts: only the oldest record is claimed; the rest linger (state stays
    `thinking`, later turns may be claimed). `hooks/register.tsx:365`.
  - R3 `claim()` substring match and "any pending submission" fallback can claim a typed turn.
    `hooks/text.ts:53`.
  - R4 hot-reload `recover` runs detached with no catch; a failed mkdir/start leaves the band `listening`
    with no listener. `hooks/register.tsx:262`.
  - R2 suggestions: duplicated test helpers, `forgetChildren` naming, three names for the VAD threshold.

- T11 done (route: inline; one non-trivial file plus docs). RED: `claude plugin test .` -> 38 pass, 1 fail
  (`Expected: "permission:toggleDebug"`, `Received: undefined` on the Mute button). GREEN: 39 pass, 0 fail.
  `claude plugin validate .` passed (expected CLAUDE.md warning); `tsc -p <scratchpad tsconfig>` no errors.
  Not verified: that the user's chord reaches the band in a live terminal (in the smoke test).
- T12 done (route: delegated direct; listen.py + register.tsx + text.ts + types + tests). `listen.py` prints
  `level <0..1>` every 4 frames (120 ms, ~8/s): the window's peak RMS as `log(peak/ref)/log(100)`,
  `ref = max(floor, 50)`, clamped; none while paused or before calibration; `--no-levels` turns them off.
  The mod keeps 8 levels, publishes `status.meter` (sparkline while listening, wave frame while speaking,
  else '') only when the drawn meter changes, at most once per stdout chunk; a `$.clock.every(150)` wave
  timer starts with playback and is cancelled at its end, on Stop, `/live off` and a reload.
  RED: python 15 tests -> 2 fail (levels printed, `--no-levels`); `claude plugin test .` -> load failure on
  the missing helpers, then 43 pass / 2 fail for the band tests (no meter; no wave redraws), also 2 fail
  against the pre-change `register.tsx`, and 2 fail with `stopWave` mutated into a leak.
  GREEN: python 15 OK; `claude plugin test .` 45 pass, 0 fail; `claude plugin validate .` passed (expected
  CLAUDE.md warning); `tsc -p <scratchpad tsconfig>` no output; `bash -n scripts/speak.sh` ok. Standalone:
  a Kokoro speech WAV fed via `--stdin` reads `0.00` over the room and `0.25-0.94` over the voice.
  Commit: cb7e0f6. Not verified: the meter with a real microphone and terminal (smoke test).
- T12 native review: APPROVED, authority burned. Non-blocking follow-ups, not scheduled unless noted:
  - R3-001 the borrowed keybinding actions (`permission:toggleDebug`, `footer:dismiss`) are unverified
    against a live engine (only the test kit accepts them).
  - R3-002 levels arriving while transcribing/thinking leak into the next meter. Fixed in T13.
  - R3-003 the wave timer's `void publish($)` has no catch. Fixed in T13 (the band ticker catches).
  - R4 Stop cancelled the wave while `speakNext` may keep playing newly enqueued sentences. Moot after
    T13: the ticker runs while live voice is on and moves the wave whenever the state is `speaking`.
  - R2 suggestions (naming, helper duplication); not scheduled.
- T13 done (route: delegated direct; register.tsx + text.ts + types + tests + docs). New helpers in
  `hooks/text.ts`: `meterRow(levels, width)`, `waveRow(tick, width)`, `flatRow(width)` (all exactly
  `width` cells), `cellWidth` (emoji 2, joiners/selectors 0), `audioBarWaveWidth(columns, parts)`,
  `METER_CAP = 200`; `sparkline`/`METER_WIDTH` removed. `$.state` `status` now holds `levels: number[]`
  (at most 200, [] unless listening), `wave: number` and `dot: boolean` in place of `meter: string`; the
  band draws at its own width, reading an old state's missing `levels` as []. One `$.clock.every(125)`
  ticker runs while live voice is on (started in `start`, cancelled in `stop`, `/live off`, session end
  and a reload): it moves the wave each tick while speaking and blinks the dot every 4 ticks, publishing
  only when one of them changed and the dot is shown (muted idle: no writes). `hearLevels` drops levels
  unless the state is `listening`.
  RED: `claude plugin test .` -> text.test.ts failed to load (missing helpers) and 4 band tests failed
  (meter not a full-width row, no plain buttons, no capped history); after the first design change
  again a load failure and 4 band fails; mutating `hearLevels` back to the T12 append-then-maybe-publish
  made "levels heard while not listening do not reach the next meter" fail (`▁…███` vs a flat row).
  GREEN: `claude plugin test .` 52 pass, 0 fail; python 15 OK; `claude plugin validate .` passed (one
  expected CLAUDE.md warning); `tsc -p <scratchpad tsconfig>` no output; `bash -n scripts/speak.sh` ok.
  Commit: d70b00a. Not verified: real terminal cell widths of `🎙`/`⏹` (counted 2, margin 2), the
  plain Button's drawn `m: ` prefix width (counted 3; the test kit's text omits it), colors and blink in
  a live terminal (smoke test).

- T14 done (route: delegated direct; register.tsx + text.ts + types + tests + docs). `hooks/text.ts`:
  `COLOR_TARGETS`, `COLORS` (red green yellow blue magenta cyan white gray), `DEFAULT_COLORS`,
  `CONFIG_USAGE`, `liveColors(stored)` (valid fields kept, the rest defaulted), and `parseLiveCommand`
  learns `config`, `config reset`, `config <target> <color>` (case-insensitive; anything else answers
  `CONFIG_USAGE`). A new `$.state` key `colors` (declared in `types/index.d.ts`) holds the colors; they
  are loaded from `$.store` key `colors` on session.start (a failed read keeps the defaults) and written to
  both on every change (a failed store write toasts). `/live config` opens pane `live-voice-colors`
  (`focus`, `closeOnEscape`, 8 rows) with one Select per color, `Restore` and `Close`; a surface with no
  Select (mobile) shows the colors and the usage. The band's wave takes `user`/`agent`/`idle` (idle stays
  dim), the dot and the muted mic take `dot`; the dot is now `●` (an emoji keeps its own color), one cell.
  No manifest change was needed (`$.store` needs no contract).
  RED: `claude plugin test .` -> text.test.ts failed to load (`CONFIG_USAGE` missing), 4 new config
  engine tests and 4 band tests failed (fake store/pane handlers added, `●` dot widths). GREEN: 60 pass,
  0 fail; python 15 OK; `claude plugin validate .` passed (one expected CLAUDE.md warning); `tsc -p
  <scratchpad tsconfig>` no output (after narrowing `Select`, absent on mobile); `bash -n` ok.
  The test kit covers the shortcut, reset, invalid input, colors kept from an earlier session (a seeded
  fake store), the pane's four Selects, a pick persisting, and Restore. Not covered: the pane's placement
  and focus, Escape closing it, pressing Close (only its presence), real persistence across a restart.
  Commit: this commit.

- T15 done (route: delegated direct). Default end-of-speech silence 2000 ms in `listen.py`
  (`END_SILENCE_MS`), the manifest's `vadEndSilenceMs` default, `register.tsx` and the README table; folds in
  the uncommitted 800 -> 1500 edit of an earlier session. Test pauses moved to 2.6 s where two utterances are
  meant. RED (with 1500): python 16 tests -> 1 fail (`test_a_long_pause_inside_speech_does_not_split_by_default`,
  2 != 1; the pause is 1.7 s because a tone edge shares a 30 ms frame, so a 1.5 s pause counted 49 silent
  frames and did not split even at 1500); `claude plugin test .` 59 pass / 1 fail (argv `1500` vs `2000`).
  GREEN: python 16 OK; `claude plugin test .` 60 pass, 0 fail; `claude plugin validate .` passed (expected
  CLAUDE.md warning); tsc no output; `bash -n` ok. Commit: see git log (`feat: wait 2 s of silence ...`).
- T16 done (route: delegated direct). `hooks/text.ts`: `smoothLevel(shown, level)` (attack 0.6, decay 0.2
  per level line) and `bounceRow(frame, level, width)` (two beating sines moving a step per frame, height
  `0.12 + 0.88 * level`: `▁▂` ripple at silence, up to `█` when loud); `meterRow` and `METER_CAP` removed.
  `$.state` `status.levels` (200-level history) replaced by `status.level` (smoothed, 2 decimals, 0 unless
  listening). Listener levels no longer redraw on their own: the one band timer (125 ms) moves the wave and
  publishes while listening or speaking (<= 8 redraws/s), blinks the dot otherwise. Colors and width rules
  unchanged. README and smoke test describe the new wave.
  RED: `claude plugin test .` -> text.test.ts failed to load (`bounceRow`/`smoothLevel` missing) and 2 band
  tests failed (no moving ripple while listening; `status.levels` still in the state). GREEN: 60 pass, 0 fail;
  python 16 OK; `claude plugin validate .` passed (expected CLAUDE.md warning); tsc no output; `bash -n` ok.
  Not verified: how the bouncing wave looks with a real mic in a live terminal (smoke test). Commit: see git
  log (`feat: bounce the listening wave with the microphone level`).
- T17 done (route: delegated direct). Cause of "config does not show": not established. No debug log of
  today's live tests holds a `/live config` run (the T14 snapshot session ran only `/live on` and `off`;
  an earlier one ran a pre-T14 snapshot where `config` was not a command). Per `$.ui.open`'s docs a pane
  opened from a typed command's hook is placed at any width, so the fix makes the command always answer:
  `/live config` opens pane `live-voice-config` as a dialog (`focus`, `closeOnEscape`, `holdToasts`,
  `rows: 12`) and answers its placement (`opened (Esc closes)` or `could not open ... a wider terminal`)
  plus a summary of every setting and `CONFIG_USAGE`; a rejected open counts as not placed.
  Settings: voice (Kokoro `/v1/audio/voices` via curl, 3 s, `sortVoices` name order Spanish first;
  `FALLBACK_VOICES` when it does not answer), the four colors, animation `wave|bars|off` (`barsRow`;
  `off` draws a still dim idle-colored line and the timer stops moving it) and end silence
  1000/1500/2000/2500/3000 ms (a change restarts the listener: old one let go and pkilled first, then
  respawned with `--end-silence-ms`). Kept in `$.store` keys `voice`, `animation`, `silenceMs` (beside
  `colors`), shown through a new `$.state` key `settings`; `/live voice` also keeps the voice now.
  Shortcuts `config voice|animation|silence|<target> <color>|reset`; `reset` restores everything and
  deletes the kept keys. Built-in defaults no longer drift on a hot reload (register reads them from
  constants, not the module's last picks). `/live` description and argumentHint name the config options.
  RED: `claude plugin test .` -> text.test.ts failed to load (`barsRow`, `liveSettings`, `sortVoices`,
  `ANIMATIONS`, `SILENCES` missing) and 9 engine tests failed (new settings.test.tsx + renamed pane).
  GREEN: 72 pass, 0 fail; python 16 OK; `claude plugin validate .` passed (expected CLAUDE.md warning);
  tsc no output; `bash -n` ok. Not verified: the dialog's placement, focus, Esc and Close in a live
  terminal; Kokoro's real voice list in the dialog (the endpoint answers `{"voices": [...]}`, checked
  by curl). Commit: see git log (`feat: configure voice, animation and silence from /live config`).
- T18 done (route: delegated direct). Reproduction: the ~35 ms exit-1 runs are Kokoro restarting, not the
  text. VoiceMode's unit sets `UVICORN_LIMIT_MAX_REQUESTS=25` and `RestartSec=10`: after its 25th request
  Kokoro logs "Maximum request limit of 25 exceeded. Terminating process." and refuses connections until
  it is back (about 30-38 s), so `curl -sf` failed at once (connection refused). The failure bursts in the
  debug logs (21:22:28-50 and 21:39:39-21:40:03 UTC) fall inside the journal's outages (limit at 17:22:26
  and 17:39:38 local, back at 17:22:59 and 17:40:16). The chunker's kinds of sentences (short, `.`,
  markdown leftovers, emoji, long text) all synthesize against the live Kokoro; only `.` gets HTTP 200 with
  an empty body (the chunker never sends it). TMPDIR is not a cause (unset here; a missing one now says so).
  Fix: `speak.sh` retries refused connections for `KOKORO_RETRY_S` (default 40 s, curl `--retry
  --retry-connrefused --retry-delay 2 --retry-max-time`); live check: 30 sentences in a row against the
  real Kokoro (silent fake paplay) crossed its limit, sentence 21 waited 36 s and was spoken, none failed.
  Errors are one specific stderr line: `Kokoro is not answering at <url>: <curl error>`, `Kokoro answered
  HTTP <code>: <body>`, `Kokoro returned no audio`, `cannot create a temporary file in <dir>`, `playback
  failed: <paplay message>`; text with no letter or digit is skipped (exit 0, no request). The mod keeps
  each speak.sh's stderr and toasts `live-voice: speech failed: <first line>` (the old Kokoro hint when
  stderr is empty).
  RED: python 23 tests -> 7 fail (messages, skip, restart wait; fake Kokoro HTTP server on localhost and a
  fake `paplay` on PATH, so no test plays sound); `claude plugin test .` 73 pass / 1 fail (toast without the
  stderr line). GREEN: python 23 OK; engine 74 pass, 0 fail; `claude plugin validate .` passed (expected
  CLAUDE.md warning); tsc no output; `bash -n` ok; SIGTERM mid-playback still exits 143 in 3 ms with no temp
  files left. Not changed (the user's service, outside the repo): the Kokoro unit's request limit; removing
  `UVICORN_LIMIT_MAX_REQUESTS` (or lowering `RestartSec`) would avoid the pauses. Side effect of the
  reproduction: the live Kokoro restarted twice on its own limit. Commit: see git log
  (`fix: wait for Kokoro to restart and say why speech failed`).

- T20 done (route: inline; one file plus a test and docs). RED: `claude plugin test .` -> 74 pass, 1 fail
  ("no implementation for command.run" for `live-config`). First try forwarded with `$.command.run` from the
  hook; the engine refuses it (a command.run hook cannot wait on its own turn), so the `/live` body moved to
  the top-level `answerLive($, args)` used by both hooks. GREEN: 75 pass, 0 fail. `claude plugin validate .`
  passed (expected CLAUDE.md warning); tsc no output. Commit: this commit.

- T21 done (route: delegated direct, one writer for register.tsx, text.ts, tests and docs). RED: `claude plugin
  test .` -> 70 pass, 9 fail (voices.test.ts did not load: `describeVoice` missing; 8 engine tests: grouped option
  order and labels, the described voice in the dialog and summary, `config test`, the Test voice button, busy).
  GREEN: 87 pass, 0 fail. `claude plugin validate .` passed (1 expected CLAUDE.md warning); python 23 OK;
  `bash -n scripts/speak.sh` ok; tsc no output. Decisions: Select has no group headers, so options read
  `Spanish — Dora (female)`; the described voice and `Test voice` (hotkey `t`) sit on the row under the picker;
  the sample's language follows the voice (Spanish `e`, else English); the mic pause file holds `1` while a
  sample plays (live on), so the listener does not take the sample for speech; a live reply that starts during
  a sample stops the sample (no overlap). Not verified: real playback and the dialog in a live terminal.
  Commit: see git log (`feat: group voices by native language and test the selected voice`).

- T22 done (route: delegated direct). RED: `claude plugin test .` -> 87 pass, 4 fail (colors.test.ts did not load:
  `parseColor`, `THEME_COLORS`, `channelBar`, ... missing; the hex/theme shortcut, the usage kinds and the dialog
  editor engine tests). GREEN: 99 pass, 0 fail. `claude plugin validate .` passed (1 expected CLAUDE.md warning);
  python 23 OK; `bash -n scripts/speak.sh` ok; tsc no output. Decisions: the theme keys offered (all verified in
  the d.ts `ThemeKey`): claude, success, suggestion, warning, error, permission, planMode, ide, remember,
  inactive, subtle; parsed in any case, stored as the theme spells them. `LiveVoiceColor` is now theme | named |
  `#${string}`. The editor's target and step live in a new `$.state` key `editor` (a module variable would not
  redraw the pane); each − / + press sets and keeps the color at once. A theme key has no RGB the mod can know,
  so its bars start at mid gray (`#808080`); named colors start at their usual RGB. The four color pickers now
  list theme keys and names (and a target's own hex). Pane rows requested: 22 (was 12). Defaults unchanged.
  Not verified: how a hex and a theme key draw in a live terminal, the hotkeys with the pane focused.
  Commit: see git log (`feat: theme, named and custom RGB colors in /live config`).

- T23 done (route: delegated direct; writer trigger: register.tsx, text.ts, types, tests, docs). RED: `claude
  plugin test .` -> 99 pass, 2 fail: with the real 67 Kokoro ids `$.ui.mount` threw `live-voice: ui.render (Pane)
  refused: Select "voice" options must be 1 to 64 entries; the engine drew its own` (the test kit surfaces a
  refused tree as a mount error). GREEN: 105 pass, 0 fail (`test/picker.test.tsx`: the pane mounts, every Select
  has 1..64 unique options, Spanish first in 9 languages, American English lists its 30 voices and keeps the
  voice, picking `af_heart` sets and keeps it; `voices.test.ts`: `selectOptions` cap, `voiceChoice`,
  `voicePicker`). `claude plugin validate .` passed (1 expected CLAUDE.md warning); python 23 OK; `bash -n
  scripts/speak.sh` ok; tsc no output. Decisions: the d.ts states no numeric Select limit (only "at least one,
  values unique", values up to 10,000 characters); the 64 cap comes from the engine's refusal. The color
  pickers hold 20 options at most and go through the same guard. The language pick does not change the voice;
  the picker follows the voice again after a voice change or when the dialog opens. Pane rows: 23 (was 22).
  Not verified: the dialog in a live terminal with the real Kokoro.
  Commit: see git log (`fix: two-step voice picker within the 64-option Select limit`).

- T24 done (route: delegated direct; writer trigger: register.tsx, text.ts, tests, docs). RED: `claude plugin
  test .` -> 105 pass, 1 fail (`test/layout.test.tsx`: `$.ui.open` had no `columns`; the old tree also drew a
  50+2+13-cell voice row at a 50-column dock). GREEN: 107 pass, 0 fail (mounted docked at 50 and 100 body
  columns: no row Box wider than the body by a cell estimate erring wide, each R/G/B row one Box with its bar
  >= 6 cells and a 3-digit value; at 100 language, voice and Test share a row; `packRows`, `channelBarWidth`,
  `selectWidth` unit tests). `claude plugin validate .` passed (1 expected CLAUDE.md warning); python 23 OK;
  `bash -n scripts/speak.sh` ok; tsc no output. Decisions: the drawable width is the Pane's `bodyColumns`; rows
  pack to it less a 2-cell margin; a Select is estimated as label + space + longest option + 2 marks; inline
  rows request lowered to 16 (the compact layout needs ~11 wide); labels shortened (`fine`, `coarse (16)`,
  `Silence ms`, `Close (Esc)`, R/G/B), keys and hotkeys unchanged. Not verified: how the terminal actually
  paints a Select's width and the dock at 100 columns in a live session.
  Commit: see git log (`fix: wider settings dock whose rows fit its width`).

- T25 done (route: delegated direct; writer trigger: register.tsx, text.ts, tests, docs). RED: `claude plugin
  test .` -> 107 pass, 5 fail (`test/chords.test.ts` did not load: `checkChord`, `applyChords`, ... missing;
  the four `test/keys.test.tsx` engine tests). GREEN: 119 pass, 0 fail (unit: normalize alt/opt/option to
  meta and order ctrl, meta, shift; bare, shifted, unknown, f13, multi-key and reserved chords refused; the
  suggestions pass; defaults meta+m/meta+s; `chordLabel` alt; `liveChords` fallbacks; `applyChords` creates,
  replaces only the two actions in every context, keeps `$schema` and other bindings, refuses invalid JSON,
  a wrong shape and a chord another action holds; `parseLiveCommand` keys/keys apply/mute/stop. Engine with a
  fake fs under HOME: mute rewrite keeps the rest and backs up the old text; invalid JSON is not written, no
  backup, nothing kept; `keys apply` creates the file; mute == stop refused via `/live-config`; the band hint
  follows the chords; the dialog's `chord-mute`/`chord-stop` Selects (<= 64, labels alt+...) write on pick).
  `band.test.tsx` updated for the new default hint (the muted hint now fits at 40 columns, so the narrow
  check moved to 39). `claude plugin validate .` passed (1 expected CLAUDE.md warning); python 23 OK; `bash -n
  scripts/speak.sh` ok; tsc no output. Decisions: chords live in a module variable plus `$.store` (`chords`),
  redrawn with `$.ui.invalidate('ui.render')` (no new `$.state` key: types/ was outside the edit surface);
  ctrl or meta required (shift+key types); ctrl+x refused (prefix of the engine's chords); ctrl+g left out of
  the suggestions (Chat's external editor); a chord bound to another action anywhere is refused rather than
  overwritten; Restore does not touch the chords. Not verified: the file write to the real HOME, Claude
  Code's live reload of it, and which chords the desktop leaves to the terminal.
  Commit: see git log (`feat: configurable mute and stop chords in keybindings.json`).

- T26 done (route: delegated direct; writer trigger: listen.py, register.tsx, text.ts, types, tests, docs).
  Turn abort: `$.turn.abort({ turnId })` (claude-code.d.ts: cancels the running model turn whose id `turn.start`
  handed this plugin; rejects when it is not the running turn, caught). RED: `claude plugin test .` -> 83 pass,
  6 fail (`test/text.test.ts` did not load: `INTERRUPTS` missing; 5 of 8 `test/barge.test.ts` tests: no abort,
  no `--barge-ratio`, no `interrupt` setting; the off/muted/typed ones already held). `python3 -I -m unittest
  discover -s test -p 'test_*.py'` -> 28 run, 4 errors (unknown `--barge-ratio`). GREEN: engine 130 pass,
  0 fail (barge line while speaking -> pkill speak.sh, 0 queued, state `listening`, `turn.abort` t1, pause
  `0` with no echo tail, next WAV submitted; after the turn ended -> nothing aborted; interrupt off -> pause
  `1`, barge ignored; muted -> `1`, ignored; typed turn never aborted; speakers flags `--barge-ratio 6
  --barge-frames 14`, headphones `3`/`3` with a listener restart; dialog `interrupt` Select, summary, store,
  reset). Python 28 OK (mode 2 ignores an ~800 RMS echo the normal mode takes, ignores a 0.3 s loud burst,
  prints `barge` then the path for 1 s of speech; modes 0/1 never print `barge`; non-positive flags exit 2).
  `claude plugin validate .` passed (1 expected CLAUDE.md warning); `bash -n scripts/speak.sh` ok; tsc no
  output. Decisions: headphones use mode `2` with the normal thresholds (so `barge` still cuts the voice
  before the utterance ends); the echo tail and a voice sample keep the mic at `1`; the noise floor does not
  adapt in mode `2`; a barge-in forgets the live turn first so its remaining streamed text is not queued.
  Not verified: real echo levels on speakers, the engine aborting a real turn, `module-echo-cancel`.
  Commit: see git log (`feat: barge-in interrupts the spoken reply by voice`).

## Next step
The human runs `docs/smoke-test.md` with the microphone and reports failed steps. Not verified yet:
the real voice loop, a real hot reload, two concurrent sessions. Known gap: children started before a
`/clear` keep the old session tag, so a later reload misses them.

- T19 done (route: delegated direct). Commit: see the T19 commit (`feat: draw the speaking wave while the
  person talks`). RED: `claude plugin test .` -> 4 fail (silent listening drew a moving ripple, not `^▁{70}$`, in
  three band tests; `SPEECH_GATE` not exported). GREEN: 74 pass, 0 fail (band test asserts: silent -> flat green,
  <= 5 state writes in 2 s; loud -> row is one of `waveRow(0..7, 70)`, green, moving; levels to 0 -> flat;
  speaking -> `waveRow` cyan; talking -> 5..17 writes in 2 s). `claude plugin validate .` passed (1 expected
  CLAUDE.md warning); `python3 -I -m unittest discover -s test -p 'test_*.py'` 23 OK; `bash -n scripts/speak.sh`
  ok; tsc no output. Not verified: live audio look in a real terminal.
