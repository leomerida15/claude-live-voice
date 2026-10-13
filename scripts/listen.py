#!/usr/bin/env python3
"""Record the microphone and cut it into utterances with an energy-based VAD.

Reads 16 kHz mono S16_LE PCM from `arecord` (or stdin with --stdin), and for
each utterance writes one WAV file into --dir and prints its absolute path on
its own line. While listening it also prints `level <0..1>` lines, about 8 a
second, for a live meter (--no-levels turns them off). While the --pause-file holds "1", audio is discarded (half-duplex
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
LEVEL_FRAMES = 4  # one level line per 4 frames (120 ms): about 8 a second
LEVEL_FLOOR_MIN = 50.0  # RMS below which the room counts as silent
LEVEL_SPAN = 100.0  # how far over the floor (40 dB) a full meter is


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
    def __init__(self, on_utterance, end_silence_ms=END_SILENCE_MS, start_frames=START_FRAMES, start_ratio=START_RATIO):
        self.on_utterance = on_utterance
        self.end_silence_ms = end_silence_ms
        self.start_frames = start_frames
        self.start_ratio = start_ratio
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
        return max((self.floor or 0.0) * self.start_ratio, MIN_START_RMS)

    def feed(self, frame):
        """Takes one frame; returns its RMS."""
        level = rms(frame)
        if self.floor is None:
            self.calibration.append(level)
            if len(self.calibration) >= frames_for(CALIBRATION_MS):
                ordered = sorted(self.calibration)
                self.floor = ordered[len(ordered) // 2]
            return level
        start = self.threshold()
        if not self.speaking:
            self.pre_roll.append(frame)
            if level > start:
                self.loud_run += 1
                if self.loud_run >= self.start_frames:
                    self.speaking = True
                    self.frames = list(self.pre_roll)
                    self.speech_frames = self.loud_run
                    self.silent_run = 0
                    self.pre_roll.clear()
            else:
                self.loud_run = 0
                self.floor = 0.95 * self.floor + 0.05 * level
            return level
        self.frames.append(frame)
        if level > start * END_RATIO:
            self.speech_frames += 1
            self.silent_run = 0
        else:
            self.silent_run += 1
        if self.silent_run >= frames_for(self.end_silence_ms) or len(self.frames) >= frames_for(MAX_UTTERANCE_MS):
            self.finish()
        return level

    def finish(self):
        if self.speaking and self.speech_frames >= frames_for(MIN_SPEECH_MS):
            trailing = max(0, self.silent_run - frames_for(KEEP_SILENCE_MS))
            kept = self.frames[: len(self.frames) - trailing]
            self.on_utterance(b"".join(kept))
        self.reset()


class Meter:
    """Prints `level <0..1>` every LEVEL_FRAMES frames: the loudest frame of the
    window on a log scale over the calibrated noise floor,

        level = clamp(log(peak / ref) / log(LEVEL_SPAN), 0, 1),  ref = max(floor, LEVEL_FLOOR_MIN)

    so the quiet room reads about 0, speech at the default start threshold
    (3x the floor) about 0.24, and normal speech (30-100x the floor) 0.7-1.
    Nothing is printed before the floor is calibrated."""

    def __init__(self, enabled=True):
        self.enabled = enabled
        self.reset()

    def reset(self):
        self.count = 0
        self.peak = 0.0

    def feed(self, level, floor):
        if not self.enabled or floor is None:
            return
        self.count += 1
        self.peak = max(self.peak, level)
        if self.count < LEVEL_FRAMES:
            return
        ref = max(floor, LEVEL_FLOOR_MIN)
        value = math.log(max(self.peak, ref) / ref) / math.log(LEVEL_SPAN)
        sys.stdout.write("level %.2f\n" % min(1.0, value))
        sys.stdout.flush()
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


def positive(kind):
    def parse(text):
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError("not a number: %r" % text)
        if not math.isfinite(value) or value <= 0:
            raise argparse.ArgumentTypeError("must be greater than 0: %r" % text)
        return value

    return parse


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=default_dir(), help="where utterance WAV files are written")
    parser.add_argument("--pause-file", default=None, help='file whose content "1" pauses listening')
    parser.add_argument("--stdin", action="store_true", help="read raw PCM from stdin instead of arecord")
    parser.add_argument("--device", default=None, help="arecord capture device (-D)")
    parser.add_argument(
        "--end-silence-ms", type=positive(int), default=END_SILENCE_MS, help="silence that ends an utterance"
    )
    parser.add_argument(
        "--start-frames", type=positive(int), default=START_FRAMES, help="loud %d ms frames that start one" % FRAME_MS
    )
    parser.add_argument(
        "--threshold-factor",
        type=positive(float),
        default=START_RATIO,
        help="how far over the calibrated noise floor speech must be",
    )
    parser.add_argument("--no-levels", action="store_true", help="do not print `level` lines for a meter")
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

    detector = Detector(
        writer(args.dir),
        end_silence_ms=args.end_silence_ms,
        start_frames=args.start_frames,
        start_ratio=args.threshold_factor,
    )
    pause = PauseFlag(args.pause_file)
    meter = Meter(enabled=not args.no_levels)
    try:
        while True:
            frame = source.read(FRAME_BYTES)
            if not frame or len(frame) < FRAME_BYTES:
                break
            if pause.is_paused():
                detector.reset()
                meter.reset()
                continue
            meter.feed(detector.feed(frame), detector.floor)
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
