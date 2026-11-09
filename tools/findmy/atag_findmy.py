#!/usr/bin/env python3
"""Authenticate with Find My and fetch ATAG Offline Finding reports.

This tool deliberately never prints Apple credentials, session tokens, or
accessory private keys.  The saved account state excludes the Apple password;
expired sessions must be renewed with the interactive ``login`` command.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import getpass
import json
import logging
import os
import plistlib
import ssl
import sys
import tempfile
import warnings
from pathlib import Path
from typing import Any

import aiohttp
from findmy import (
    AppleAccount,
    FixedRollingKeyPairAccessory,
    KeyPair,
    KeyPairType,
    LocalAnisetteProvider,
    LocationReport,
    LoginState,
)
from findmy.reports.twofactor import SmsSecondFactorMethod
from findmy.util.http import HttpResponse, HttpSession


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_STATE_DIR = WORKSPACE / ".findmy"
DEFAULT_ACCOUNT = DEFAULT_STATE_DIR / "account.json"
DEFAULT_ANISETTE = DEFAULT_STATE_DIR / "ani_libs.bin"
VOLTAGE_STATUS_MAX_MILLIVOLTS = 4_200
VOLTAGE_STATUS_MIN_MILLIVOLTS = 2_400


class AtagFindMyError(RuntimeError):
    """Expected, user-facing command failure."""


class AppleSessionError(AtagFindMyError):
    """A saved account cannot be used to query reports."""


_GSA = "https://gsa.apple.com/grandslam/GsService2"
_MOBILEME = "https://setup.icloud.com/setup/iosbuddy/loginDelegates"
_LOGIN_STAGES = {
    _GSA: "登录初始化",
    _MOBILEME: "Find My 授权",
    "https://gsa.apple.com/auth": "获取验证方式",
    "https://gsa.apple.com/auth/verify/phone": "发送短信验证码",
    "https://gsa.apple.com/auth/verify/phone/securitycode": "验证短信验证码",
    "https://gsa.apple.com/auth/verify/trusteddevice": "发送受信任设备验证码",
    f"{_GSA}/validate": "验证受信任设备验证码",
}


class _LoginProbeHttp(HttpSession):
    """Verified TLS and bounded, value-free diagnostics for the login probe."""

    def __init__(self) -> None:
        super().__init__()
        self._tls = ssl.create_default_context()
        root = WORKSPACE / "tools/atag-agent/src/anisette/AppleIncRootCertificate.cer"
        self._tls.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(root.read_bytes()))
        self.has_query_token = False

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=self._tls),
                timeout=aiohttp.ClientTimeout(total=40, connect=5),
            )
        return self._session

    async def request(self, method: str, url: str, **kwargs: Any) -> HttpResponse:
        stage = _LOGIN_STAGES.get(url)
        if stage is None:
            raise AtagFindMyError("登录测试收到未知的 Apple 目标地址。")
        if url == _GSA and plistlib.loads(kwargs["data"])["Request"]["o"] == "complete":
            stage = "密码验证"
        kwargs.pop("auto_retry", None)
        auth = kwargs.pop("auth", None)
        if isinstance(auth, tuple):
            auth = aiohttp.BasicAuth(*auth)
        session = await self._get_session()
        try:
            async with session.request(
                method, url, auth=auth, allow_redirects=False, **kwargs
            ) as response:
                status = response.status
                if not 200 <= status < 300:
                    raise AtagFindMyError(f"Apple {stage}失败（HTTP {status}）。")
                raw = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    raw.extend(chunk)
                    if len(raw) > 2 * 1024 * 1024:
                        raise AtagFindMyError(f"Apple {stage}响应过大。")
        except TimeoutError:
            raise AtagFindMyError(f"Apple {stage}超时。") from None
        except aiohttp.ClientError:
            raise AtagFindMyError(f"Apple {stage}未收到可用响应。") from None
        body = bytes(raw)
        if url in {_GSA, _MOBILEME}:
            try:
                value = plistlib.loads(body)
                if url == _GSA:
                    outcome = value["Response"]["Status"]
                    ec = outcome.get("ec")
                    if type(ec) is int and ec != 0:
                        raise AtagFindMyError(f"Apple {stage}失败（错误 {ec}）。")
                    if outcome.get("hsc") == 409 and not outcome.get("au"):
                        outcome["au"] = "trustedDeviceSecondaryAuth"
                        body = plistlib.dumps(value)
                else:
                    delegate = value.get("delegates", {}).get("com.apple.mobileme", {})
                    tokens = delegate.get("service-data", {}).get("tokens", {})
                    token = tokens.get("searchPartyToken")
                    self.has_query_token = isinstance(token, str) and bool(token)
            except (KeyError, AttributeError, ValueError, plistlib.InvalidFileException):
                raise AtagFindMyError(f"Apple {stage}响应格式无效（HTTP {status}）。") from None
        return HttpResponse(status, body)


def decode_voltage_status(status: int) -> int:
    """Decode the current 2.4–4.2 V battery status."""
    if not isinstance(status, int) or not 0 <= status <= 255:
        raise ValueError("Invalid voltage status byte")
    code = ((status >> 2) & 0x30) | (status & 0x0F)
    span = VOLTAGE_STATUS_MAX_MILLIVOLTS - VOLTAGE_STATUS_MIN_MILLIVOLTS
    return VOLTAGE_STATUS_MAX_MILLIVOLTS - (code * span + 31) // 63


def _ensure_private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def _save_private_json(path: Path, value: object) -> None:
    """Atomically save JSON with owner-only permissions."""
    _ensure_private_directory(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_path, path)
        path.chmod(0o600)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        finally:
            raise


def _save_account(account: AppleAccount, path: Path) -> None:
    state = account.to_json()
    _require_query_token(state)
    # FindMy.py includes the plaintext password in its serialised account state.
    # A valid search-party token is sufficient for ordinary fetches, so require
    # an explicit interactive login again if Apple later expires that token.
    state["account"]["password"] = None
    _save_private_json(path, state)


def _require_query_token(state: Any) -> None:
    try:
        token = state["login"]["data"]["mobileme_data"]["tokens"]["searchPartyToken"]
    except (KeyError, TypeError):
        token = None
    if not isinstance(token, str) or not token.strip():
        raise AppleSessionError("Apple 会话缺少 Find My 查询凭据（searchPartyToken）。")


def _new_account(anisette_path: Path) -> AppleAccount:
    _ensure_private_directory(anisette_path.parent)
    provider = LocalAnisetteProvider(libs_path=anisette_path)
    return AppleAccount(provider)


def _close_account(account: AppleAccount) -> None:
    """Close FindMy.py's sync facade on the event loop it owns."""
    # FindMy.py wraps most async methods synchronously, but close()
    # itself is still async.  Its HTTP objects belong to this private loop, so
    # closing them with asyncio.run() on a new loop is not safe.
    loop = account._evt_loop  # noqa: SLF001
    if not loop.is_closed():
        try:
            loop.run_until_complete(account.close())
        finally:
            loop.close()


def _load_account(account_path: Path, anisette_path: Path) -> AppleAccount:
    if not account_path.is_file():
        raise AppleSessionError(
            f"未找到认证状态 {account_path}；请先执行 login。"
        )
    if account_path.stat().st_mode & 0o077:
        raise AppleSessionError(
            f"认证状态权限过宽：请执行 chmod 600 {account_path}"
        )
    try:
        state = json.loads(account_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise AppleSessionError("无法读取认证状态；请重新执行 login。") from error
    _require_query_token(state)
    account = AppleAccount.from_json(
        state,
        anisette_libs_path=anisette_path,
    )
    if account.login_state is not LoginState.LOGGED_IN:
        _close_account(account)
        raise AppleSessionError("认证状态无效；请重新执行 login。")
    return account


def _describe_2fa(method: object) -> str:
    if isinstance(method, SmsSecondFactorMethod):
        return f"SMS {method.phone_number}"
    return "受信任的 Apple 设备"


def _read_secret(prompt: str, check_only: bool) -> str:
    if not check_only:
        return getpass.getpass(prompt)
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt)
        except getpass.GetPassWarning:
            raise AtagFindMyError("无法关闭终端回显，已停止读取凭据。") from None


def command_login(args: argparse.Namespace) -> int:
    if args.check_only and not sys.stdin.isatty():
        raise AtagFindMyError("请在本机终端运行登录测试，以便安全输入密码和验证码。")
    account_path = args.account.resolve()
    anisette_path = args.anisette.resolve()
    probe = _LoginProbeHttp() if args.check_only else None
    account = _new_account(anisette_path)
    if probe is not None:
        # Record login stages and verify that Apple issues a query token.
        account._asyncacc._http = probe  # noqa: SLF001
        print("本地 Python / 本地 Anisette 登录测试（不保存会话）", flush=True)
    try:
        username = input("Apple ID: ").strip()
        if not username:
            raise AtagFindMyError("Apple ID 不能为空。")
        password = _read_secret("Apple ID 密码: ", args.check_only)
        if not password:
            raise AtagFindMyError("密码不能为空。")

        state = account.login(username, password)
        if state is LoginState.REQUIRE_2FA:
            methods = list(account.get_2fa_methods())
            if not methods:
                raise AtagFindMyError("Apple 要求 2FA，但没有返回可用的验证方式。")
            print("可用的 2FA 方式：")
            for index, method in enumerate(methods):
                print(f"  {index}: {_describe_2fa(method)}")
            choice_text = input("选择方式 [0]: ").strip() or "0"
            try:
                method = methods[int(choice_text)]
            except (ValueError, IndexError) as error:
                raise AtagFindMyError("无效的 2FA 方式。") from error
            method.request()
            code = _read_secret("6 位验证码: ", args.check_only).strip()
            if not code.isdigit() or len(code) != 6:
                raise AtagFindMyError("验证码必须是 6 位数字。")
            state = method.submit(code)

        if state is not LoginState.LOGGED_IN:
            raise AtagFindMyError(f"登录未完成，当前状态：{state.name}")

        if probe is not None:
            if not probe.has_query_token:
                raise AtagFindMyError("Apple 账号验证已完成，但没有返回 Find My 查询凭据（searchPartyToken）。")
            print("本地 Python 登录成功，已取得 Find My 查询凭据。测试会话未保存。")
            return 0

        _save_account(account, account_path)
        print(f"登录成功；认证会话已安全保存到 {account_path}")
        print("Apple ID 密码未写入会话文件。")
        return 0
    finally:
        _close_account(account)
        if anisette_path.exists():
            anisette_path.chmod(0o600)


def _decode_private_key(encoded: object, field: str) -> bytes:
    if not isinstance(encoded, str):
        raise AtagFindMyError(f"{field} 必须是 Base64 字符串。")
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise AtagFindMyError(f"{field} 不是有效的 Base64。") from error
    if len(key) != 28:
        raise AtagFindMyError(f"{field} 解码后应为 28 字节，实际为 {len(key)}。")
    value = int.from_bytes(key, "big")
    if value == 0:
        raise AtagFindMyError(f"{field} 不是有效的 P-224 私钥。")
    return key


def load_devices(path: Path) -> list[FixedRollingKeyPairAccessory]:
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise AtagFindMyError(f"未找到设备密钥文件：{path}") from error
    except json.JSONDecodeError as error:
        raise AtagFindMyError(f"设备密钥 JSON 无效：{error}") from error

    if not isinstance(raw, list) or not raw:
        raise AtagFindMyError("设备密钥 JSON 必须是非空数组。")

    devices: list[FixedRollingKeyPairAccessory] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise AtagFindMyError(f"设备 #{index} 必须是对象。")
        name = item.get("name")
        if not isinstance(name, str) or not name:
            name = f"ATAG-{index}"
        additional = item.get("additionalKeys", [])
        if not isinstance(additional, list):
            raise AtagFindMyError(f"设备 {name} 的 additionalKeys 必须是数组。")
        private_keys = [
            _decode_private_key(value, f"{name}.additionalKeys[{key_index}]")
            for key_index, value in enumerate(additional)
        ]
        private_keys.append(_decode_private_key(item.get("privateKey"), f"{name}.privateKey"))
        identifier = str(item["id"]) if "id" in item else None
        devices.append(
            FixedRollingKeyPairAccessory(
                private_keys=private_keys,
                name=name,
                identifier=identifier,
            )
        )
    return devices


def fetch_latest_reports(
    account: AppleAccount, devices: list[FixedRollingKeyPairAccessory],
) -> list[LocationReport | None]:
    device_keys = [
        [
            KeyPair(private_key, KeyPairType.PRIMARY, name=device.name)
            for private_key in device.private_keys
        ]
        for device in devices
    ]
    # Pre-generated Offline Finding keys are primary advertisement IDs.
    results = account.fetch_location(list(dict.fromkeys(key for keys in device_keys for key in keys)))
    if not isinstance(results, dict):
        raise AtagFindMyError("FindMy.py 返回了意外的结果格式。")
    return [
        max(
            (report for key in keys if (report := results.get(key)) is not None),
            key=lambda report: report.timestamp,
            default=None,
        )
        for keys in device_keys
    ]


def command_fetch(args: argparse.Namespace) -> int:
    devices = load_devices(args.devices.resolve())
    key_count = sum(len(device.private_keys) for device in devices)
    account = _load_account(args.account.resolve(), args.anisette.resolve())
    try:
        print(
            f"正在查询 {len(devices)} 个设备的 {key_count} 个广播密钥；"
            "Apple 报告可能延迟数分钟。"
        )
        found = 0
        for device, report in zip(devices, fetch_latest_reports(account, devices), strict=True):
            if report is None:
                print(f"{device.name}: 暂无坐标报告")
                continue
            found += 1
            print(f"{device.name}:")
            print(f"  时间: {report.timestamp.isoformat()}")
            print(f"  坐标: {report.latitude:.7f}, {report.longitude:.7f}")
            print(f"  水平精度: {report.horizontal_accuracy} m")
            print(f"  置信度: {report.confidence}")
            print(f"  状态字节: 0x{report.status:02x}")
            millivolts = decode_voltage_status(report.status)
            print(f"  电池电压: {millivolts / 1000:.3f} V（6-bit）")
        return 0 if found else 2
    finally:
        _close_account(account)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="登录 Apple Find My 并回收 ATAG 固定/轮换密钥坐标。"
    )
    parser.add_argument(
        "--account",
        type=Path,
        default=DEFAULT_ACCOUNT,
        help=f"认证状态文件（默认：{DEFAULT_ACCOUNT}）",
    )
    parser.add_argument(
        "--anisette",
        type=Path,
        default=DEFAULT_ANISETTE,
        help=f"本地 Anisette 库/状态文件（默认：{DEFAULT_ANISETTE}）",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    login = subparsers.add_parser("login", help="交互式 Apple ID + 2FA 登录")
    login.add_argument("--check-only", action="store_true", help="仅验证登录与查询凭据，不保存会话")
    login.set_defaults(handler=command_login)

    fetch = subparsers.add_parser("fetch", help="下载并解密最新坐标")
    fetch.add_argument(
        "devices",
        type=Path,
        help="atagctl 生成的 *_devices.json",
    )
    fetch.set_defaults(handler=command_fetch)

    return parser


def main(argv: list[str] | None = None) -> int:
    # Any files created by FindMy.py or its Anisette dependency are private at
    # creation time, not only after a later chmod.
    os.umask(0o077)
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "check_only", False):
        logging.disable(logging.CRITICAL)
    try:
        return int(args.handler(args))
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        return 130
    except AtagFindMyError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    except Exception as error:  # Keep secrets out of broad library tracebacks.
        detail = type(error).__name__ if getattr(args, "check_only", False) else f"{type(error).__name__}: {error}"
        print(f"Find My 操作失败：{detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
