# ATAG Find My report retrieval

This optional host CLI uses FindMy.py’s local Anisette provider and current v2
report endpoint. It reads fixed or pre-generated rolling `*_devices.json`
files produced by `atagctl`.

```sh
.venv/bin/python tools/findmy/atag_findmy.py login --check-only
.venv/bin/python tools/findmy/atag_findmy.py login
.venv/bin/python tools/findmy/atag_findmy.py fetch path/to/mytag_devices.json
```

`login --check-only` tests the installed Python client and its local Anisette
provider directly against Apple, independent of the browser and Rust agent.
It uses verified TLS, checks for `searchPartyToken`, and leaves account files
untouched. Only status and error codes are displayed.

Login reads the password and verification code without terminal echo. The
private `.findmy/account.json` stores the query session, excluding the password.
Expired sessions require login again. Account files and device key files contain
sensitive material and are restricted to the current user.

Reports decode battery status using the current 2.4–4.2 V six-bit encoding.
An empty response means no report is available; it does not trigger another
endpoint. The CLI is separate from the browser-owned workspace and its backups.

```sh
.venv/bin/python -m unittest discover -s tools/findmy -v
```
