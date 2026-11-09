from __future__ import annotations

import base64
import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from atag_findmy import (
    AppleSessionError, AtagFindMyError, LoginState, _save_account, build_parser,
    command_login, decode_voltage_status, fetch_latest_reports, load_devices,
)


class LoginProbeTests(unittest.TestCase):
    def test_probe_requires_a_query_token_and_preserves_existing_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            account_path = Path(directory) / "account.json"
            account_path.write_text("previous session fixture", encoding="utf-8")
            args = build_parser().parse_args([
                "--account", str(account_path), "--anisette", str(Path(directory) / "libs"),
                "login", "--check-only",
            ])
            for has_query_token in (True, False):
                with self.subTest(has_query_token=has_query_token):
                    account = Mock()
                    account.login.return_value = LoginState.LOGGED_IN
                    probe = SimpleNamespace(has_query_token=has_query_token)
                    output = io.StringIO()
                    with (
                        patch("atag_findmy._new_account", return_value=account),
                        patch("atag_findmy._LoginProbeHttp", return_value=probe),
                        patch("atag_findmy._close_account") as close,
                        patch("atag_findmy.sys.stdin.isatty", return_value=True),
                        patch("builtins.input", return_value="fixture@example.test"),
                        patch("atag_findmy.getpass.getpass", return_value="fixture-password"),
                        contextlib.redirect_stdout(output),
                    ):
                        if has_query_token:
                            self.assertEqual(command_login(args), 0)
                        else:
                            with self.assertRaisesRegex(AtagFindMyError, "searchPartyToken"):
                                command_login(args)
                    close.assert_called_once_with(account)
                    self.assertEqual(account_path.read_text(), "previous session fixture")
                    self.assertNotIn("fixture-password", output.getvalue())

    def test_login_without_query_token_does_not_replace_saved_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "account.json"
            path.write_text("previous session fixture", encoding="utf-8")
            account = Mock()
            account.to_json.return_value = {"login": {"data": {"mobileme_data": {
                "tokens": {"mmeAuthToken": "fixture"},
            }}}}
            with self.assertRaises(AppleSessionError):
                _save_account(account, path)
            self.assertEqual(path.read_text(encoding="utf-8"), "previous session fixture")


class VoltageStatusTests(unittest.TestCase):
    def test_decodes_split_six_bit_code(self) -> None:
        self.assertEqual(decode_voltage_status(0x00), 4_200)
        self.assertEqual(decode_voltage_status(0x01), 4_171)
        self.assertEqual(decode_voltage_status(0x40), 3_743)
        self.assertEqual(decode_voltage_status(0x80), 3_286)
        self.assertEqual(decode_voltage_status(0xC0), 2_829)
        self.assertEqual(decode_voltage_status(0xCF), 2_400)

    def test_ignores_device_type_bits(self) -> None:
        self.assertEqual(decode_voltage_status(0x30), 4_200)

    def test_rejects_invalid_status_bytes(self) -> None:
        for value in [-1, 256, 1.5]:
            with self.assertRaises(ValueError):
                decode_voltage_status(value)


class LoadDevicesTests(unittest.TestCase):
    def _write(self, value: object) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "devices.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_loads_fixed_and_additional_private_keys(self) -> None:
        first = bytes(range(1, 29))
        second = bytes(range(2, 30))
        path = self._write(
            [
                {
                    "id": 7,
                    "name": "rotating",
                    "privateKey": base64.b64encode(second).decode(),
                    "additionalKeys": [base64.b64encode(first).decode()],
                }
            ]
        )

        devices = load_devices(path)

        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0].name, "rotating")
        self.assertEqual(devices[0].identifier, "7")
        self.assertEqual(devices[0].private_keys, [first, second])

    def test_rejects_wrong_key_length(self) -> None:
        path = self._write(
            [
                {
                    "name": "bad",
                    "privateKey": base64.b64encode(b"short").decode(),
                    "additionalKeys": [],
                }
            ]
        )

        with self.assertRaisesRegex(AtagFindMyError, "28 字节"):
            load_devices(path)

    def test_rejects_invalid_base64(self) -> None:
        path = self._write(
            [{"name": "bad", "privateKey": "not-base64", "additionalKeys": []}]
        )

        with self.assertRaisesRegex(AtagFindMyError, "Base64"):
            load_devices(path)


class LatestReportsTests(unittest.TestCase):
    def test_selects_latest_across_rotations_and_retains_unseen_devices(self) -> None:
        now = datetime.now(timezone.utc)
        older = SimpleNamespace(timestamp=now - timedelta(minutes=10))
        newer = SimpleNamespace(timestamp=now)
        devices = [
            SimpleNamespace(name="rotating", private_keys=[value.to_bytes(28, "big") for value in (1, 2)]),
            SimpleNamespace(name="unseen", private_keys=[(3).to_bytes(28, "big")]),
        ]
        account = Mock()
        account.fetch_location.side_effect = lambda keys: {keys[0]: newer, keys[1]: older, keys[2]: None}
        self.assertEqual(fetch_latest_reports(account, devices), [newer, None])


if __name__ == "__main__":
    unittest.main()
