# live-voice

A Claude Code mod (plugin with a hooks module) for hands-free live voice
conversation in the terminal, a clone of pi-live-codex for Claude. Zero extra
cost: both speech services are local, no OpenAI key.

Pipeline: `arecord` -> `scripts/listen.py` (stdlib RMS VAD, one WAV per
utterance, path on stdout) -> local Whisper `http://127.0.0.1:2022` (language
`es`) -> `$.prompt.submit({ text, asUser: true })` -> the reply streamed through
`turn.step`, split into sentences -> local Kokoro `http://127.0.0.1:8880`
(voice `ef_dora`) via `scripts/speak.sh` -> `paplay`. Half-duplex: the mic is
paused while speaking. Controls: `/live on|off|mute|status|voice <name>`, an
AbovePrompt band (`m` mute, `s` stop), `Esc` aborts the turn and playback.

Out of scope: barge-in, global keybindings, cloud providers, non-Linux audio.

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest, `userConfig` options, `types` contract. |
| `.claude-plugin/marketplace.json` | Marketplace entry for `/plugin install`. |
| `hooks/hooks.json` | Names the hooks module. |
| `hooks/register.tsx` | The mod: `/live`, the loop, playback queue, band. |
| `hooks/text.ts` | Pure helpers: command parsing, transcript filter, markdown stripping, sentence chunker. |
| `types/index.d.ts` | `$.state` contract (`live-voice.status`). |
| `scripts/listen.py` | VAD recorder (stdlib only). `--stdin` reads raw PCM for tests. |
| `scripts/speak.sh` | Text on stdin -> Kokoro WAV -> `paplay`. Cleans up on SIGTERM. |
| `test/*.test.ts(x)` | Engine tests (`claude plugin test`). |
| `test/test_*.py` | Python tests for `listen.py`. |
| `odd/tasks/live-voice-mode.md` | Feature document: tasks, routes, evidence. |

## Checks (run all before a commit)

```
claude plugin validate .            # one expected warning: CLAUDE.md at the root (dev docs, not plugin context)
tsc -p <tsconfig>                     # see below
claude plugin test .
python3 -I -m unittest discover -s test -p 'test_*.py'
bash -n scripts/speak.sh
```

Type-check: once the engine has loaded the mod (`claude --plugin-dir .`), it
writes `.claude-plugin/types/` (gitignored) with a `tsconfig.json`; a local
`tsconfig.json` extending it (also gitignored) lets `tsc -p .` work. Before
that, use the tsconfig from the header of the `claude-code.d.ts` the
`plugin-authoring` skill prints, kept OUTSIDE the repo, with `files` naming that
`.d.ts` and `include` naming this repo's `hooks`, `types` and `test`.

## Dev run

```
claude --plugin-dir .
```

then `/live`. Needs Whisper and Kokoro running (VoiceMode installs both). The
interactive smoke test is in `docs/smoke-test.md`.

## Mod API gotchas (Claude Code 2.1.296)

- `$.http` and `$.fs.write` are text-only: all binary audio goes through child
  processes (`curl`, `arecord`, `paplay`) via `$.process.run` / `$.process.spawn`.
- `$.audio.play` is silent on Linux; play with `paplay`.
- `$.fs` has no delete: the pause flag is a file holding `1` or `0`, and WAVs
  are removed with `rm -f` through `$.process.run`.
- The validator rejects passing `$` to functions that are not declared at the
  top level of the module: keep every `$`-taking helper at module scope.
- Long work must be detached from hooks (hook time budget): start it with
  `$.clock.after(0, ...)` and return; never await the listener loop in a hook.
- A Button's `action` must name an existing engine keybinding action; a mod
  cannot define its own. The band borrows inert ones (`permission:toggleDebug`,
  `footer:dismiss`) that the person binds to chords in `keybindings.json`.
- A command name allows only letters, digits, `_` and `-` (no `:`). A
  `command.run` hook cannot call `$.command.run` (it would wait on its own
  turn): share a top-level function instead (`answerLive`).
- A hot reload runs `register` and `session.start` again: module variables
  start over, `$.state` stays.
- A plugin's `$.prompt.submit` runs once the session is idle. Other plugins'
  `prompt.submit` hooks see `origin: { kind: 'plugin', name, asUser }`, but the
  plugin's OWN `prompt.submit` hook does not run for its own submission (observed
  in the test kit). Live turns are correlated with the submit result instead.
- Tests: hooks answering `$` calls return `{ value }`; the test `$` has no
  `$.state` (check state through `/live status`); a hot reload is simulated with
  a second `session.start`. Shared fakes live in `test/fake.ts`.

## Never change the audio setup

Do not change the user's audio configuration (default sink or source,
volumes, mutes, modules) while debugging. Read-only queries (`pactl info`,
`pactl list`, `pactl get-*`) are fine; `pactl set-*`, `wpctl set-*`,
`pacmd set-*` and `amixer set` are denied in `.claude/settings.json`. If audio
seems wrong, report what the queries show and let the person fix it. The mod
itself plays with plain `paplay` and records with plain `arecord`: no device
is chosen or changed.

## Conventions

English for code, comments and docs. Conventional Commits, one per ODD task, no
AI attribution lines. Track substantial work in `odd/tasks/`.
