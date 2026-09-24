from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codes.app import audio, storage


class AudioProcessingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "inputs"
        self.previews = self.root / "previews"
        self.inputs.mkdir()
        self.previews.mkdir()
        self.input_patch = patch.object(audio, "INPUT_ROOT", self.inputs)
        self.preview_patch = patch.object(audio, "PREVIEW_ROOT", self.previews)
        self.input_patch.start()
        self.preview_patch.start()

    def tearDown(self):
        self.preview_patch.stop()
        self.input_patch.stop()
        self.temporary.cleanup()

    def test_estimates_interleaved_pcm_duration(self):
        result = audio.upload("speech.pcm", bytes(48000 * 2 * 2))
        duration = audio.estimate(result["file"]["id"], {"sample_format": "s16le", "sample_rate": 48000, "channels": 2, "mode": "all"})
        self.assertEqual(1.0, duration["duration_seconds"])

    def test_rejects_invalid_channel(self):
        result = audio.upload("speech.raw", b"1234")
        with self.assertRaisesRegex(ValueError, "通道必须为 1-4"):
            audio.estimate(result["file"]["id"], {"sample_format": "s16le", "sample_rate": 48000, "channels": 4, "mode": "channel", "channel": 5})

    def test_preview_extracts_requested_channel_without_shell(self):
        result = audio.upload("multi.pcm", bytes(128))
        body = {"id": result["file"]["id"], "sample_format": "s16le", "sample_rate": 48000, "channels": 8, "mode": "channel", "channel": 3}

        def run(command, **kwargs):
            Path(command[-1]).write_bytes(b"RIFF")
            return type("Result", (), {"returncode": 0, "stderr": ""})()

        with patch.object(audio, "ffmpeg_executable", return_value="/usr/bin/ffmpeg"), patch.object(audio.subprocess, "run", side_effect=run) as runner, patch.object(storage, "update"):
            preview = audio.preview({}, body)
        command = runner.call_args.args[0]
        self.assertIn("pan=mono|c0=c2", command)
        self.assertNotIn("shell", runner.call_args.kwargs)
        self.assertTrue(preview["url"].startswith("/api/audio/preview?id="))

    def test_multichannel_preview_downmixes_to_stereo(self):
        result = audio.upload("multi.pcm", bytes(128))
        body = {"id": result["file"]["id"], "sample_format": "s16le", "sample_rate": 48000, "channels": 6, "mode": "all"}

        def run(command, **kwargs):
            Path(command[-1]).write_bytes(b"RIFF")
            return type("Result", (), {"returncode": 0, "stderr": ""})()

        with patch.object(audio, "ffmpeg_executable", return_value="ffmpeg"), patch.object(audio.subprocess, "run", side_effect=run) as runner, patch.object(storage, "update"):
            audio.preview({}, body)
        command = runner.call_args.args[0]
        self.assertEqual(["-ac", "2"], command[command.index("-i") + 2:command.index("-i") + 4])

    def test_upload_rejects_non_pcm_extension(self):
        with self.assertRaisesRegex(ValueError, "仅支持"):
            audio.upload("audio.mp3", b"data")

    def test_file_id_cannot_escape_managed_directory(self):
        with self.assertRaisesRegex(ValueError, "文件 ID 无效"):
            audio.resolve_preview("../outside.wav")

    def test_custom_ffmpeg_path_must_be_absolute(self):
        with self.assertRaisesRegex(ValueError, "绝对路径"):
            audio.save_ffmpeg_path("ffmpeg")


if __name__ == "__main__":
    unittest.main()
