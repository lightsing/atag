from __future__ import annotations

import argparse
import getpass
import logging
import sys
import warnings
from pathlib import Path

from findmy import (
    AppleAccount,
    AsyncAppleAccount,
    LocalAnisetteProvider,
    LoginState,
    RemoteAnisetteProvider,
    SmsSecondFactorMethod,
    TrustedDeviceSecondFactorMethod,
)


def _login_sync(account: AppleAccount) -> None:
    email = input("email?  > ").strip()
    password = getpass.getpass("passwd? > ")

    state = account.login(email, password)

    if state == LoginState.REQUIRE_2FA:  # Account requires 2FA
        methods = account.get_2fa_methods()

        # Print the (masked) phone numbers
        for i, method in enumerate(methods):
            if isinstance(method, TrustedDeviceSecondFactorMethod):
                print(f"{i} - Trusted Device")
            elif isinstance(method, SmsSecondFactorMethod):
                print(f"{i} - SMS ({method.phone_number})")

        ind = int(input("Method? > "))

        method = methods[ind]
        method.request()
        code = getpass.getpass("Code? > ").strip()

        # This automatically finishes the post-2FA login flow
        method.submit(code)


async def _login_async(account: AsyncAppleAccount) -> None:
    email = input("email?  > ").strip()
    password = getpass.getpass("passwd? > ")

    state = await account.login(email, password)

    if state == LoginState.REQUIRE_2FA:  # Account requires 2FA
        methods = await account.get_2fa_methods()

        # Print the (masked) phone numbers
        for i, method in enumerate(methods):
            if isinstance(method, TrustedDeviceSecondFactorMethod):
                print(f"{i} - Trusted Device")
            elif isinstance(method, SmsSecondFactorMethod):
                print(f"{i} - SMS ({method.phone_number})")

        ind = int(input("Method? > "))

        method = methods[ind]
        await method.request()
        code = getpass.getpass("Code? > ").strip()

        # This automatically finishes the post-2FA login flow
        await method.submit(code)


def get_account_sync(
    store_path: str,
    anisette_url: str | None,
    libs_path: str | None,
) -> AppleAccount:
    """Tries to restore a saved Apple account, or prompts the user for login otherwise. (sync)"""
    try:
        acc = AppleAccount.from_json(store_path, anisette_libs_path=libs_path)
    except FileNotFoundError:
        ani = (
            LocalAnisetteProvider(libs_path=libs_path)
            if anisette_url is None
            else RemoteAnisetteProvider(anisette_url)
        )
        acc = AppleAccount(ani)
        _login_sync(acc)

        acc.to_json(store_path)

    return acc


async def get_account_async(
    store_path: str,
    anisette_url: str | None,
    libs_path: str | None,
) -> AsyncAppleAccount:
    """Tries to restore a saved Apple account, or prompts the user for login otherwise. (async)"""
    try:
        acc = AsyncAppleAccount.from_json(store_path, anisette_libs_path=libs_path)
    except FileNotFoundError:
        ani = (
            LocalAnisetteProvider(libs_path=libs_path)
            if anisette_url is None
            else RemoteAnisetteProvider(anisette_url)
        )
        acc = AsyncAppleAccount(ani)
        await _login_async(acc)

        acc.to_json(store_path)

    return acc


def main(argv: list[str] | None = None) -> int:
    if __package__:
        from .atag_findmy import (
            DEFAULT_ANISETTE, AtagFindMyError, _LoginProbeHttp, _close_account, _new_account,
        )
    else:
        from atag_findmy import (
            DEFAULT_ANISETTE, AtagFindMyError, _LoginProbeHttp, _close_account, _new_account,
        )

    parser = argparse.ArgumentParser(description="交互式测试 Apple 登录，不保存会话。")
    parser.add_argument("--libs-path", type=Path, default=DEFAULT_ANISETTE, help="本地 Anisette 运行库缓存")
    parser.add_argument("--anisette-url", help="可选的远程 Anisette v1 地址")
    args = parser.parse_args(argv)
    if not sys.stdin.isatty():
        parser.error("请在本机终端运行。")

    account = None
    previous_log_level = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        probe = _LoginProbeHttp()
        account = (
            AppleAccount(RemoteAnisetteProvider(args.anisette_url))
            if args.anisette_url
            else _new_account(args.libs_path.resolve())
        )
        account._asyncacc._http = probe
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            _login_sync(account)
        if account.login_state is not LoginState.LOGGED_IN:
            raise AtagFindMyError("Apple 登录未完成。")
        if not probe.has_query_token:
            raise AtagFindMyError("Apple 已完成账号验证，但未返回 Find My 查询凭据。")
        print("登录成功，已取得 Find My 查询凭据；未保存会话。")
        return 0
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。", file=sys.stderr)
        return 130
    except getpass.GetPassWarning:
        print("无法关闭终端回显，已停止读取凭据。", file=sys.stderr)
        return 1
    except AtagFindMyError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"登录失败：{type(error).__name__}", file=sys.stderr)
        return 1
    finally:
        try:
            if account is not None:
                _close_account(account)
        finally:
            logging.disable(previous_log_level)


if __name__ == "__main__":
    raise SystemExit(main())
