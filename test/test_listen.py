"""Synthetic checks for scripts/listen.py: raw PCM in, one WAV path per utterance out."""

import array
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import wave

RATE = 16000
SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "listen.py"


def silence(seconds, noise=40):
    samples = array.array("h")
    for i in range(int(RATE * seconds)):
        samples.append(noise if i % 2 else -noise)
    return samples


def tone(seconds, amplitude=8000, hz=440):
    return array.array(
        "h", (int(amplitude * math.sin(2 * math.pi * hz * i / RATE)) for i in range(int(RATE * seconds)))
    )


def pcm(*parts):
    out = array.array("h")
    for part in parts:
        out.extend(part)
    return out.tobytes()


class ListenTest(unittest.TestCase):
    def run_listener(self, audio, pause=None, extra=()):
        with tempfile.TemporaryDirectory() as tmp:
            args = [sys.executable, "-I", str(SCRIPT), "--stdin", "--dir", tmp, *extra]
            if pause is not None:
                flag = os.path.join(tmp, "paused")
                pathlib.Path(flag).write_text(pause)
                args += ["--pause-file", flag]
            done = subprocess.run(args, input=audio, capture_output=True, timeout=30, check=True)
            lines = done.stdout.decode().splitlines()
            paths = [line for line in lines if not line.startswith("level ")]
            infos = []
            for path in paths:
                with wave.open(path, "rb") as wav:
                    infos.append((wav.getframerate(), wav.getnchannels(), wav.getnframes() / wav.getframerate()))
            return paths, infos

    def test_one_utterance_prints_one_wav_path(self):
        paths, infos = self.run_listener(pcm(silence(1.0), tone(1.0), silence(1.5)))
        self.assertEqual(len(paths), 1)
        self.assertTrue(os.path.isabs(paths[0]))
        rate, channels, seconds = infos[0]
        self.assertEqual((rate, channels), (RATE, 1))
        self.assertGreater(seconds, 0.9)
        self.assertLess(seconds, 2.0)

    def test_two_utterances_print_two_paths(self):
        paths, _ = self.run_listener(pcm(silence(1.0), tone(0.6), silence(2.6), tone(0.6), silence(2.6)))
        self.assertEqual(len(paths), 2)

    def test_short_blip_is_ignored(self):
        paths, _ = self.run_listener(pcm(silence(1.0), tone(0.12), silence(1.5)))
        self.assertEqual(paths, [])

    def test_paused_flag_discards_audio(self):
        paths, _ = self.run_listener(pcm(silence(1.0), tone(1.0), silence(1.5)), pause="1")
        self.assertEqual(paths, [])

    def test_unpaused_flag_keeps_audio(self):
        paths, _ = self.run_listener(pcm(silence(1.0), tone(1.0), silence(1.5)), pause="0")
        self.assertEqual(len(paths), 1)

    def test_session_tag_is_accepted_and_ignored(self):
        paths, _ = self.run_listener(pcm(silence(1.0), tone(1.0), silence(1.5)), extra=("--tag", "live-voice-abc"))
        self.assertEqual(len(paths), 1)


class LevelTest(unittest.TestCase):
    def levels(self, audio, pause=None, extra=()):
        with tempfile.TemporaryDirectory() as tmp:
            args = [sys.executable, "-I", str(SCRIPT), "--stdin", "--dir", tmp, *extra]
            if pause is not None:
                flag = os.path.join(tmp, "paused")
                pathlib.Path(flag).write_text(pause)
                args += ["--pause-file", flag]
            done = subprocess.run(args, input=audio, capture_output=True, timeout=30, check=True)
            return [float(line.split()[1]) for line in done.stdout.decode().splitlines() if line.startswith("level ")]

    def test_levels_are_printed_while_listening(self):
        levels = self.levels(pcm(silence(1.0), tone(1.0), silence(1.0)))
        # About 8 a second after the 0.5 s calibration: 2.5 s of audio -> ~16.
        self.assertGreaterEqual(len(levels), 12)
        self.assertLessEqual(len(levels), 22)
        self.assertTrue(all(0.0 <= level <= 1.0 for level in levels))
        # The quiet room reads low and the voice high.
        self.assertLess(levels[0], 0.2)
        self.assertGreater(max(levels), 0.7)

    def test_no_levels_while_paused(self):
        self.assertEqual(self.levels(pcm(silence(1.0), tone(1.0), silence(1.0)), pause="1"), [])

    def test_no_levels_flag_turns_them_off(self):
        self.assertEqual(self.levels(pcm(silence(1.0), tone(1.0), silence(1.0)), extra=("--no-levels",)), [])


class TunablesTest(unittest.TestCase):
    run_listener = ListenTest.run_listener

    def test_shorter_end_silence_splits_what_the_default_joins(self):
        audio = pcm(silence(1.0), tone(0.6), silence(0.5), tone(0.6), silence(2.6))
        joined, _ = self.run_listener(audio)
        split, _ = self.run_listener(audio, extra=("--end-silence-ms", "300"))
        self.assertEqual((len(joined), len(split)), (1, 2))

    def test_a_long_pause_inside_speech_does_not_split_by_default(self):
        # A 1.7 s pause to think mid-sentence stays one utterance (default end silence 2 s;
        # the old 1.5 s default cut it in two).
        paths, _ = self.run_listener(pcm(silence(1.0), tone(0.6), silence(1.7), tone(0.6), silence(2.6)))
        self.assertEqual(len(paths), 1)

    def test_more_start_frames_ignore_a_short_burst(self):
        audio = pcm(silence(1.0), tone(0.4), silence(1.5))
        default, _ = self.run_listener(audio)
        strict, _ = self.run_listener(audio, extra=("--start-frames", "20"))
        self.assertEqual((len(default), len(strict)), (1, 0))

    def test_a_higher_threshold_factor_ignores_a_quiet_voice(self):
        audio = pcm(silence(1.0, noise=200), tone(1.0, amplitude=1500), silence(1.5, noise=200))
        default, _ = self.run_listener(audio)
        strict, _ = self.run_listener(audio, extra=("--threshold-factor", "8"))
        self.assertEqual((len(default), len(strict)), (1, 0))

    def test_bad_values_are_refused(self):
        for flag, value in (("--end-silence-ms", "0"), ("--start-frames", "-1"), ("--threshold-factor", "nan")):
            with self.subTest(flag=flag):
                done = subprocess.run(
                    [sys.executable, "-I", str(SCRIPT), "--stdin", flag, value], input=b"", capture_output=True, timeout=30
                )
                self.assertEqual(done.returncode, 2)


class FakeKokoro:
    """A local HTTP server standing in for Kokoro: answers each POST with (status, body)."""

    def __init__(self, status=200, body=b"RIFF fake wav", port=None):
        import http.server
        import threading

        outer = self
        self.requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                outer.requests.append(self.rfile.read(length))
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port or 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1/audio/speech"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port():
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SpeakTest(unittest.TestCase):
    SPEAK = SCRIPT.parent / "speak.sh"

    def setUp(self):
        # A fake paplay first on PATH: tests never play sound. It fails when the WAV holds "FAIL".
        self.bin = tempfile.TemporaryDirectory()
        self.addCleanup(self.bin.cleanup)
        paplay = pathlib.Path(self.bin.name) / "paplay"
        paplay.write_text(
            "#!/bin/sh\n"
            'if grep -q FAIL "$1"; then echo "Failed to open audio file." >&2; exit 1; fi\n'
            "exit 0\n"
        )
        paplay.chmod(0o755)

    def run_speak(self, *args, text="Hola.", url="http://127.0.0.1:9/unreachable", env=None):
        full = {
            "PATH": f"{self.bin.name}:{os.environ.get('PATH', '')}",
            "KOKORO_URL": url,
            "KOKORO_RETRY_S": "0",
            **(env or {}),
        }
        return subprocess.run(["bash", str(self.SPEAK), *args], input=text.encode(), capture_output=True, env=full, timeout=60)

    def test_session_tag_is_accepted_before_the_voice(self):
        done = self.run_speak("--tag", "live-voice-abc", "ef_dora")
        # Reaches synthesis (exit 1 on the unreachable URL), not a usage error.
        self.assertEqual(done.returncode, 1)
        self.assertIn(b"Kokoro is not answering", done.stderr)

    def test_empty_text_still_fails_with_a_tag(self):
        done = self.run_speak("--tag", "live-voice-abc", "ef_dora", text="  ")
        self.assertEqual(done.returncode, 2)

    def test_speaks_through_kokoro(self):
        kokoro = FakeKokoro()
        self.addCleanup(kokoro.close)
        done = self.run_speak("ef_dora", url=kokoro.url)
        self.assertEqual((done.returncode, done.stderr), (0, b""))
        self.assertEqual(len(kokoro.requests), 1)

    def test_an_http_error_names_the_status_and_the_body(self):
        kokoro = FakeKokoro(status=400, body=b'{"detail": "voice not found"}')
        self.addCleanup(kokoro.close)
        done = self.run_speak("xx_nobody", url=kokoro.url)
        self.assertEqual(done.returncode, 1)
        self.assertIn(b"HTTP 400", done.stderr)
        self.assertIn(b"voice not found", done.stderr)
        self.assertEqual(len(done.stderr.decode().strip().splitlines()), 1)

    def test_no_audio_is_an_error(self):
        kokoro = FakeKokoro(body=b"")
        self.addCleanup(kokoro.close)
        done = self.run_speak("ef_dora", url=kokoro.url)
        self.assertEqual(done.returncode, 1)
        self.assertIn(b"no audio", done.stderr)

    def test_a_playback_failure_says_why(self):
        kokoro = FakeKokoro(body=b"FAIL")
        self.addCleanup(kokoro.close)
        done = self.run_speak("ef_dora", url=kokoro.url)
        self.assertEqual(done.returncode, 1)
        self.assertIn(b"playback failed: Failed to open audio file.", done.stderr)

    def test_a_missing_temporary_directory_is_named(self):
        done = self.run_speak("ef_dora", env={"TMPDIR": "/nonexistent/live-voice"})
        self.assertEqual(done.returncode, 1)
        self.assertIn(b"temporary file", done.stderr)
        self.assertIn(b"/nonexistent/live-voice", done.stderr)

    def test_text_with_nothing_to_say_is_skipped(self):
        kokoro = FakeKokoro(body=b"")
        self.addCleanup(kokoro.close)
        for text in (".", "...", " - ", "**"):
            with self.subTest(text=text):
                done = self.run_speak("ef_dora", url=kokoro.url, text=text)
                self.assertEqual((done.returncode, done.stderr), (0, b""))
        self.assertEqual(kokoro.requests, [])

    def test_waits_for_kokoro_while_it_restarts(self):
        # Kokoro restarts after a number of requests (uvicorn --limit-max-requests):
        # its port refuses connections for a while, then it answers again.
        import threading

        port = free_port()
        servers = []
        starter = threading.Timer(1.5, lambda: servers.append(FakeKokoro(port=port)))
        starter.start()
        self.addCleanup(lambda: [server.close() for server in servers])
        done = self.run_speak("ef_dora", url=f"http://127.0.0.1:{port}/v1/audio/speech", env={"KOKORO_RETRY_S": "10"})
        starter.join()
        self.assertEqual((done.returncode, done.stderr), (0, b""))
        self.assertEqual(len(servers[0].requests), 1)


if __name__ == "__main__":
    unittest.main()
