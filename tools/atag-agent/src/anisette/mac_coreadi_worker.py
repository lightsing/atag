"""Private agent pipe worker for the pinned macOS CoreADI emulator."""
from __future__ import annotations

import contextlib
import io
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class MachineError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def run(runtime: Path, action: str) -> dict[str, str]:
    # The agent verifies the executable modules, library and trust root before
    # launch. No caller identity, account data or ambient environment is used.
    os.environ['COREADI_PATH'] = str(runtime / 'CoreADI.x86_64')
    sys.path.insert(0, str(runtime / 'emulator'))
    from gsa import Device, GSA
    from mac_anisette import MacAnisette

    class VerifiedGSA(GSA):
        def __init__(self, device):
            self.device, self.timeout, self.urls = device, 20, {}
            context = ssl.create_default_context()
            root = (runtime / 'apple-root.cer').read_bytes()
            context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(root))
            self.opener = urllib.request.build_opener(
                NoRedirect(), urllib.request.HTTPSHandler(context=context),
            )

        def _open(self, url, body, *, client_time):
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != 'https' or parsed.netloc != 'gsa.apple.com' or not parsed.path.startswith('/grandslam/'):
                raise MachineError('Apple 机器注册地址不受支持。')
            stage = '目录' if body is None else '开始注册' if 'start' in parsed.path.lower() else '完成注册'
            request = urllib.request.Request(url, data=body, headers=self._headers(client_time=client_time))
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    data = response.read(65537)
                    if len(data) > 65536:
                        raise MachineError(f'Apple 机器注册{stage}响应过大。')
                    return data
            except urllib.error.HTTPError as error:
                raise MachineError(f'Apple 机器注册{stage}失败（HTTP {error.code}）。') from None
            except (urllib.error.URLError, TimeoutError):
                raise MachineError(f'Apple 机器注册{stage}未收到可用响应。') from None

    state = runtime / 'machine'
    store = state / 'store'
    for path in (state / 'identity.json', store):
        if path.is_symlink():
            raise MachineError('CoreADI 机器缓存不能使用符号链接。')
    if store.exists() and any(
        path.is_symlink() or not path.is_file() or path.stat().st_size > 65536
        for path in store.iterdir()
    ):
        raise MachineError('CoreADI 机器缓存格式无效。')

    machine = MacAnisette(state)
    if action == 'prepare' and not machine.is_provisioned():
        ident = machine.identity
        machine.provision(VerifiedGSA(Device(
            ident['device_id'], ident['client_info'], ident['local_user_uuid'], ident['serial'],
        )))
    if not machine.is_provisioned():
        raise MachineError('模拟 macOS CoreADI 尚未注册，请运行 atag-agent anisette init。')
    headers = machine.headers()
    headers['X-Mme-Client-Info'] = headers.pop('X-MMe-Client-Info')
    headers['User-Agent'] = 'akd/1.0 CFNetwork/1404.0.5 Darwin/22.2.0'
    return headers


def main() -> int:
    os.umask(0o077)
    if len(sys.argv) != 3 or sys.argv[2] not in ('prepare', 'headers') or sys.stdout.isatty():
        return 2
    try:
        # CoreADI diagnostics never become part of the parent protocol.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            headers = run(Path(sys.argv[1]), sys.argv[2])
        result = {'status': 'ok', 'headers': headers}
    except MachineError as error:
        result = {'status': 'error', 'message': str(error)}
    except ImportError:
        result = {'status': 'error', 'message': 'macOS CoreADI 所用的 Python 缺少 Unicorn 或无法加载它。'}
    except (Exception, SystemExit):
        result = {'status': 'error', 'message': 'macOS CoreADI 模拟失败；请运行 anisette init 检查机器状态。'}
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
