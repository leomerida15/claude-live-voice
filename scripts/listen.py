#!/usr/bin/env python3
"""Record the microphone and cut it into utterances with an energy-based VAD.

Reads 16 kHz mono S16_LE PCM from `arecord` (or stdin with --stdin), and for
each utterance writes one WAV file into --dir and prints its absolute path on
its own line. While the --pause-file holds "1", audio is discarded (half-duplex
while the reply is spoken, or muted). Standard library only.
"""

import argparse
import array
import collections
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
import wave

RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2

CALIBRATION_MS = 500
START_FRAMES = 3  # consecutive loud frames that start an utterance
PRE_ROLL_MS = 300
END_SILENCE_MS = 800
KEEP_SILENCE_MS = 200
MIN_SPEECH_MS = 300
MAX_UTTERANCE_MS = 30000
START_RATIO = 3.0
END_RATIO = 0.6
MIN_START_RMS = 300.0
PAUSE_CHECK_S = 0.1


def frames_for(ms):
    return max(1, ms // FRAME_MS)


def rms(frame):
    samples = array.array("h")
    samples.frombytes(frame)
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class PauseFlag:
    """Reads the pause file at most every PAUSE_CHECK_S seconds; "1" means paused."""

    def __init__(self, path):
        self.path = path
        self.checked = 0.0
        self.paused = False

    def is_paused(self):
        if not self.path:
            return False
        now = time.monotonic()
        if now - self.checked >= PAUSE_CHECK_S:
            self.checked = now
            try:
                with open(self.path, encoding="utf-8") as flag:
                    self.paused = flag.read().strip() == "1"
            except OSError:
                self.paused = False
        return self.paused


class Detector:
    def __init__(self, on_utterance):
        self.on_utterance = on_utterance
        self.floor = None
        self.calibration = []
        self.pre_roll = collections.deque(maxlen=frames_for(PRE_ROLL_MS))
        self.reset()

    def reset(self):
        self.loud_run = 0
        self.speaking = False
        self.frames = []
        self.speech_frames = 0
        self.silent_run = 0
        self.pre_roll.clear()

    def threshold(self):
        return max((self.floor or 0.0) * START_RATIO, MIN_START_RMS)

    def feed(self, frame):
        level = rms(frame)
        if self.floor is None:
            self.calibration.append(level)
            if len(self.calibration) >= frames_for(CALIBRATION_MS):
                ordered = sorted(self.calibration)
                self.floor = ordered[len(ordered) // 2]
            return
        start = self.threshold()
        if not self.speaking:
            self.pre_roll.append(frame)
            if level > start:
                self.loud_run += 1
                if self.loud_run >= START_FRAMES:
                    self.speaking = True
                    self.frames = list(self.pre_roll)
                    self.speech_frames = self.loud_run
                    self.silent_run = 0
                    self.pre_roll.clear()
            else:
                self.loud_run = 0
                self.floor = 0.95 * self.floor + 0.05 * level
            return
        self.frames.append(frame)
        if level > start * END_RATIO:
            self.speech_frames += 1
            self.silent_run = 0
        else:
            self.silent_run += 1
        if self.silent_run >= frames_for(END_SILENCE_MS) or len(self.frames) >= frames_for(MAX_UTTERANCE_MS):
            self.finish()

    def finish(self):
        if self.speaking and self.speech_frames >= frames_for(MIN_SPEECH_MS):
            trailing = max(0, self.silent_run - frames_for(KEEP_SILENCE_MS))
            kept = self.frames[: len(self.frames) - trailing]
            self.on_utterance(b"".join(kept))
        self.reset()


def writer(directory):
    count = 0

    def write(audio):
        nonlocal count
        count += 1
        name = "utt-%d-%d-%d.wav" % (os.getpid(), int(time.time() * 1000), count)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".part")
        os.close(fd)
        with wave.open(tmp, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(audio)
        path = os.path.abspath(os.path.join(directory, name))
        os.replace(tmp, path)
        sys.stdout.write(path + "\n")
        sys.stdout.flush()

    return write


def default_dir():
    base = os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    return os.path.join(base, "live-voice")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=default_dir(), help="where utterance WAV files are written")
    parser.add_argument("--pause-file", default=None, help='file whose content "1" pauses listening')
    parser.add_argument("--stdin", action="store_true", help="read raw PCM from stdin instead of arecord")
    parser.add_argument("--device", default=None, help="arecord capture device (-D)")
    parser.add_argument("--tag", default=None, help="session tag; ignored, it lets the caller find this process")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    os.makedirs(args.dir, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    recorder = None
    if args.stdin:
        source = sys.stdin.buffer
    else:
        command = ["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"]
        if args.device:
            command += ["-D", args.device]
        recorder = subprocess.Popen(command, stdout=subprocess.PIPE)
        source = recorder.stdout

    detector = Detector(writer(args.dir))
    pause = PauseFlag(args.pause_file)
    try:
        while True:
            frame = source.read(FRAME_BYTES)
            if not frame or len(frame) < FRAME_BYTES:
                break
            if pause.is_paused():
                detector.reset()
                continue
            detector.feed(frame)
        detector.finish()
    except KeyboardInterrupt:
        pass
    finally:
        if recorder is not None:
            recorder.terminate()
            try:
                recorder.wait(timeout=2)
            except subprocess.TimeoutExpired:
                recorder.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
