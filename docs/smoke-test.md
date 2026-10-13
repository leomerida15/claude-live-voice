# Interactive smoke test

A checklist for a person at the microphone. Automated checks cannot cover the
real loop: audio devices, timing, echo and the terminal band. Run it after any
change to `hooks/register.tsx`, `scripts/listen.py` or `scripts/speak.sh`.

Mark each step pass or fail and note what you heard or saw on a failure.

## 0. Preconditions

- [ ] Whisper answers:
  `curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2022/health` (or
  post a WAV to `/v1/audio/transcriptions`).
- [ ] Kokoro answers: `echo "Hola, prueba de voz." | bash scripts/speak.sh ef_dora` is audible.
- [ ] `arecord -l` lists your microphone; the desktop mic mute is off.
- [ ] No leftovers from earlier runs: `pgrep -af 'listen.py|speak.sh'` prints nothing.
- [ ] Headphones off for steps 1–6 (speakers test the echo guard); quiet room.

## 1. Start

- [ ] `claude --plugin-dir .` from the repo root, then `/live`.
- [ ] The answer is "Live voice on. Speak; voice ef_dora."
- [ ] The band's audio bar reads `●🎙  m: 🔇 Mute  s: ⏹ Stop  │` and a flat line, the dot blinking;
  the text bar below reads `listening · ef_dora` with `alt+space mute · alt+s stop` on the right.
- [ ] `pgrep -af listen.py` shows exactly one listener, carrying this session's tag.

## 2. One spoken turn

- [ ] Say a short question, for example "¿Qué hora es en Madrid?".
- [ ] The band goes `transcribing` -> `thinking` -> `speaking`, then back to `listening`.
- [ ] While `listening`, the audio bar's wave is green and keeps moving: a low ripple in silence that
  jumps tall as you talk and settles back when you stop (no scrolling history); while `speaking` it is a moving cyan wave that stops when the reply ends; otherwise a flat dim
  line. The wave fills the band's width without wrapping, and the controls stay before it.
- [ ] The prompt shown in the transcript is what you said.
- [ ] The reply is spoken sentence by sentence, starting before Claude finishes writing.
- [ ] The text bar shows `N queued` while sentences wait.
- [ ] Narrow the terminal: the chord hint disappears first, then the wave shrinks; Mute and Stop stay whole.

## 3. Echo guard (speakers on)

- [ ] During and right after the spoken reply, no new prompt appears from the
  speaker's own audio.
- [ ] Ask for a long answer (several sentences). Still no self-triggered prompt.
- [ ] If a false prompt appears, note it and try `echoTailMs` 600 and
  `vadThresholdFactor` higher in `/config`, then repeat this step.

## 4. Code is not read

- [ ] Ask "Escribe una función en Python que sume dos números".
- [ ] The prose is spoken; the code block is replaced by "código omitido", said once.

## 5. Typed prompts stay silent

- [ ] Type a prompt (do not speak). The reply is NOT read aloud.
- [ ] Type a prompt with exactly the same words you spoke in step 2. It is still NOT read aloud.

## 6. Controls

- [ ] `/live mute`: the text bar shows `muted`, the audio bar a steady red `🔇` with no dot; speaking produces no prompt. `/live mute` again unmutes.
- [ ] With the chords from the README bound, `Alt+Space` in the prompt toggles mute and `Alt+S`
  stops speech, without focusing the band. Typing in the prompt is not affected.
- [ ] `ctrl+x tab` focuses the band; `m` toggles mute; `s` stops speech mid-sentence.
- [ ] `Esc` during a spoken reply aborts the turn, stops playback at once and drops the queue.
- [ ] `/live voice em_alex`, ask something: the new voice is used. `/live status` reports it.
- [ ] `/live status` reports state, voice and queue.
- [ ] `/live config agent magenta`: the answer is "agent color set to magenta." and the next spoken
  reply's wave is magenta. `/live config` opens the colors dialog; picking a color changes the band at
  once; `Restore` brings back green/cyan/red/gray; `Esc` or `Close` closes it. After restarting Claude
  Code the chosen colors are still there. `/live config user pink` answers the usage.

## 7. Two sessions (process scoping)

- [ ] Open a second terminal: `claude --plugin-dir .`, `/live on` there too.
- [ ] `/live off` in the second session. The first session keeps listening and,
  if it is speaking, keeps speaking.
- [ ] `pgrep -af 'listen.py|speak.sh'` shows only the first session's processes.

## 8. Hot reload

- [ ] With live on, touch `hooks/register.tsx` (save it unchanged) so the mod reloads.
- [ ] The band comes back as `listening` without running `/live` again.
- [ ] `pgrep -af listen.py` shows exactly one listener for this session (no orphan).

## 9. Stop and failure paths

- [ ] `/live off`: the band disappears; `pgrep -af 'listen.py|speak.sh'` prints nothing for this session.
- [ ] Stop Whisper, `/live on`, speak: a toast says Whisper is not answering; the loop keeps listening.
- [ ] Stop Kokoro, ask by voice: a toast says speech failed; the band returns to `listening`.
- [ ] Quit Claude Code with live on: no `listen.py`, `arecord` or `paplay` is left running.

## Report

Note the Claude Code version, the distro and audio stack (PipeWire or
PulseAudio), the microphone, and each failed step with what happened.
