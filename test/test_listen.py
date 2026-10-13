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
    def run_listener(self, audio, pause=None):
        with tempfile.TemporaryDirectory() as tmp:
            args = [sys.executable, "-I", str(SCRIPT), "--stdin", "--dir", tmp]
            if pause is not None:
                flag = os.path.join(tmp, "paused")
                pathlib.Path(flag).write_text(pause)
                args += ["--pause-file", flag]
            done = subprocess.run(args, input=audio, capture_output=True, timeout=30, check=True)
            paths = done.stdout.decode().split()
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
        paths, _ = self.run_listener(pcm(silence(1.0), tone(0.6), silence(1.2), tone(0.6), silence(1.2)))
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


if __name__ == "__main__":
    unittest.main()
