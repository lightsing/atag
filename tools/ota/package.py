"""ATAG application-only, Ed25519(SHA512(image)) update packages."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

ROOT = Path(__file__).resolve().parents[2]
ACTIVE_START = 0x19000
ACTIVE_SIZE = 0x28000
DFU_START = 0x41000
STATE_START = 0x6a000
BOOT_START = 0x70000
PERSISTENT_START = 0x7c000
TARGET = 'nRF52832-S112-7.3.0'
PUBLIC_KEY = ROOT / 'firmware-nrf52832/ota-public-key.bin'
PRIVATE_KEY = ROOT / '.ota/signing-key.pem'


def write_new(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def init_key(private=PRIVATE_KEY, public=PUBLIC_KEY):
    if private.exists() or public.exists():
        raise ValueError('Signing key already exists; keep the existing key for installed devices')
    key = Ed25519PrivateKey.generate()
    write_new(private, key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    write_new(public, key.public_key().public_bytes_raw())


def validate_image(image: bytes):
    if not 512 <= len(image) <= ACTIVE_SIZE or len(image) % 4:
        raise ValueError('Application must be word-aligned and fit the 160 KiB active slot')
    sp, pc = (int.from_bytes(image[i:i+4], 'little') for i in (0, 4))
    if not (0x20004000 <= sp <= 0x20010000 and sp % 8 == 0
            and pc & 1 and ACTIVE_START <= pc < ACTIVE_START + len(image)):
        raise ValueError('Invalid nRF52832/S112 application vector table')


def sign(image: bytes, version: str, private=PRIVATE_KEY, public=PUBLIC_KEY) -> dict:
    image += b'\xff' * (-len(image) % 4)
    validate_image(image)
    if not re.fullmatch(r'\d\.\d\.\d', version):
        raise ValueError('Version must have the form X.Y.Z with single-digit components')
    key = serialization.load_pem_private_key(private.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey) or key.public_key().public_bytes_raw() != public.read_bytes():
        raise ValueError('Private signing key does not match the compiled public key')
    return {'format': 1, 'target': TARGET, 'layout': 1, 'version': version,
            'length': len(image), 'sha256': hashlib.sha256(image).hexdigest(),
            'public_key': key.public_key().public_bytes_raw().hex(),
            'signature': key.sign(hashlib.sha512(image).digest()).hex(),
            'image': image.hex()}


def load_package(path: Path) -> tuple[dict, bytes]:
    if path.stat().st_size > ACTIVE_SIZE * 2 + 4096:
        raise ValueError('Oversized update package')
    package = json.loads(path.read_text())
    if package.get('format') != 1 or package.get('target') != TARGET or package.get('layout') != 1:
        raise ValueError('Wrong update target/layout')
    image = bytes.fromhex(package['image'])
    validate_image(image)
    if package['length'] != len(image) or package['sha256'] != hashlib.sha256(image).hexdigest():
        raise ValueError('Update length/hash mismatch')
    signature = bytes.fromhex(package['signature'])
    public = bytes.fromhex(package['public_key'])
    if len(signature) != 64 or len(public) != 32:
        raise ValueError('Invalid signature/public-key size')
    Ed25519PublicKey.from_public_bytes(public).verify(signature, hashlib.sha512(image).digest())
    return package, image
