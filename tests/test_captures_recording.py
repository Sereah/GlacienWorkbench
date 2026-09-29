from __future__ import annotations

import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from codes.app import captures


SETTINGS = {"_selected_adb_serial": "device-123"}


class CaptureRecordingModeTest(unittest.TestCase):
    @staticmethod
    def _box(box_type: bytes, payload: bytes) -> bytes:
        return (len(payload) + 8).to_bytes(4, "big") + box_type + payload

    def test_android_mode_uses_physical_display_and_bugreport(self):
        options = captures._recording_options({
            "recording_mode": "android",
            "time_limit": 60,
            "bit_rate": 8_000_000,
            "size": "1920x1200",
            "physical_display_id": "4619827551948147201",
            "logical_display_id": "2",
            "bugreport": True,
        })

        with patch.object(captures.android, "tool", return_value="/sdk/adb"):
            command = captures._android_record_args(SETTINGS, options, "/data/local/tmp/record.mp4")

        script = command[-1]
        self.assertIn("--display-id 4619827551948147201", script)
        self.assertIn("--bugreport", script)
        self.assertNotIn("--display-id 2 ", script)

    def test_scrcpy_camcorder_mode_uses_logical_display_and_audio_guards(self):
        options = captures._recording_options({
            "recording_mode": "scrcpy_mic_camcorder",
            "time_limit": 120,
            "bit_rate": 8_000_000,
            "size": "1920x1200",
            "physical_display_id": "4619827551948147201",
            "logical_display_id": "2",
        })

        with patch.object(captures, "_scrcpy_path", return_value=(Path("/usr/bin/scrcpy"), "auto")):
            command = captures._scrcpy_record_args(SETTINGS, options, Path("/managed/record.mp4"))

        self.assertEqual("mic-camcorder", command[command.index("--audio-source") + 1])
        self.assertEqual("2", command[command.index("--display-id") + 1])
        self.assertEqual("1920", command[command.index("--max-size") + 1])
        self.assertEqual("aac", command[command.index("--audio-codec") + 1])
        self.assertIn("--require-audio", command)
        self.assertIn("--no-playback", command)
        self.assertNotIn("4619827551948147201", command)

    def test_scrcpy_voice_performance_mode_selects_mixed_source(self):
        options = captures._recording_options({"recording_mode": "scrcpy_voice_performance"})

        with patch.object(captures, "_scrcpy_path", return_value=(Path("/usr/bin/scrcpy"), "auto")):
            command = captures._scrcpy_record_args(SETTINGS, options, Path("/managed/record.mp4"))

        self.assertEqual("voice-performance", command[command.index("--audio-source") + 1])

    def test_scrcpy_mode_rejects_bugreport_overlay(self):
        with self.assertRaisesRegex(ValueError, "不支持 bugreport"):
            captures._recording_options({
                "recording_mode": "scrcpy_mic_camcorder",
                "bugreport": True,
            })

    def test_scrcpy_stop_sends_interrupt_before_terminate(self):
        process = Mock()
        process.poll.return_value = None
        session = {"mode": "scrcpy_mic_camcorder", "process": process}

        with patch.object(captures.platform, "system", return_value="Darwin"):
            captures._stop_recording_process(session)

        process.send_signal.assert_called_once_with(signal.SIGINT)
        process.wait.assert_called_once_with(timeout=10)
        process.terminate.assert_not_called()

    def test_scrcpy_local_recording_does_not_pull_from_device(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "record.mp4"
            output.write_bytes(b"recording")
            session = {
                "mode": "scrcpy_voice_performance",
                "output": output,
                "process": Mock(),
                "launch_log": None,
            }
            with patch.object(captures, "RECORDING_ROOT", Path(directory)), patch.object(
                captures.android, "device_adb"
            ) as adb_call:
                result = captures._local_recording_file(session)

            self.assertEqual(output, result)
            adb_call.assert_not_called()

    def test_mp4_audio_track_detection_reads_sound_handler(self):
        video_handler = self._box(b"hdlr", bytes(8) + b"vide")
        audio_handler = self._box(b"hdlr", bytes(8) + b"soun")
        video_track = self._box(b"trak", self._box(b"mdia", video_handler))
        audio_track = self._box(b"trak", self._box(b"mdia", audio_handler))

        with tempfile.TemporaryDirectory() as directory:
            video_only = Path(directory) / "video.mp4"
            with_audio = Path(directory) / "audio.mp4"
            video_only.write_bytes(self._box(b"moov", video_track))
            with_audio.write_bytes(self._box(b"moov", video_track + audio_track))

            self.assertFalse(captures._mp4_has_audio_track(video_only))
            self.assertTrue(captures._mp4_has_audio_track(with_audio))

    def test_scrcpy_completion_rejects_video_without_audio_track(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "record.mp4"
            output.write_bytes(b"video-only")
            process = Mock()
            process.poll.return_value = 0
            session = {
                "id": "session", "serial": "device-123", "settings": SETTINGS,
                "mode": "scrcpy_mic_camcorder", "process": process, "launch_log": None,
                "started_at": 1.0, "time_limit": 30, "output": output,
                "pending_cover": None, "cover_error": "", "state": "recording",
                "file": None, "error": "",
            }
            previous = captures._recording
            captures._recording = session
            try:
                with patch.object(captures, "RECORDING_ROOT", Path(directory)), patch.object(
                    captures, "_mp4_duration", return_value=1.0
                ), patch.object(captures, "_mp4_has_audio_track", return_value=False):
                    with self.assertRaisesRegex(ValueError, "未包含音轨"):
                        captures._finish_recording(False)
            finally:
                captures._recording = previous

            self.assertTrue(output.exists())
            self.assertEqual("failed", session["state"])


if __name__ == "__main__":
    unittest.main()
