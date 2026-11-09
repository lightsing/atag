"""Version-one 64-byte ATAG settings format (firmware 0.1.0)."""
import struct
import zlib

FORMAT = struct.Struct('<BBBBIIIHHIHHHHi24sI')
FIELDS = (
    'advertising_interval_ms', 'gatt_interval_ms', 'rotation_minutes',
    'gatt_advertising_seconds', 'connection_seconds', 'battery_idle_seconds',
    'battery_gatt_seconds', 'reset_hold_seconds', 'battery_low_mv',
    'battery_recovery_mv', 'battery_calibration_ppm',
)
DEFAULTS = dict(zip(FIELDS, (2000, 100, 15, 60, 120, 900, 5, 5, 2400, 2900, 0)),
                tx_power_dbm=0, led_enabled=False)
LIMITS = dict(zip(FIELDS, ((100, 10240), (20, 2000), (1, 0xffffffff),
                         (10, 3600), (10, 3600), (10, 86400), (1, 600),
                         (2, 30), (1800, 4200), (1800, 4200), (-100000, 100000))))


def validate(settings):
    if set(settings) != set(DEFAULTS):
        raise ValueError('Settings must contain exactly the documented fields')
    if type(settings['led_enabled']) is not bool:
        raise ValueError('led_enabled must be a boolean')
    if settings['tx_power_dbm'] not in (-40, -20, -16, -12, -8, -4, 0, 3, 4):
        raise ValueError('Unsupported nRF52832 transmit power')
    for field, (minimum, maximum) in LIMITS.items():
        value = settings[field]
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f'{field} must be an integer from {minimum} to {maximum}')
    if settings['battery_low_mv'] >= settings['battery_recovery_mv']:
        raise ValueError('battery_low_mv must be below battery_recovery_mv')


def encode_settings(settings):
    validate(settings)
    wire = FORMAT.pack(1, int(settings['led_enabled']), settings['tx_power_dbm'] & 0xff, 0,
                       *(settings[field] for field in FIELDS), bytes(24), 0)
    return wire[:60] + struct.pack('<I', zlib.crc32(wire[:60]))


def decode_settings(wire):
    if len(wire) != 64:
        raise ValueError('Expected a 64-byte settings packet')
    values = FORMAT.unpack(wire)
    if values[0] != 1 or values[1] & ~1 or values[3] or values[-2] != bytes(24):
        raise ValueError('Unsupported settings version or reserved bits')
    if values[-1] != zlib.crc32(wire[:60]):
        raise ValueError('Invalid settings checksum')
    settings = dict(zip(FIELDS, values[4:-2]),
                    tx_power_dbm=values[2] if values[2] < 128 else values[2] - 256,
                    led_enabled=bool(values[1] & 1))
    validate(settings)
    return settings


def encode_name(text):
    raw = text.encode('utf-8')
    if not 1 <= len(raw) <= 29 or all(byte == 32 for byte in raw):
        raise ValueError('Name must contain 1..29 UTF-8 bytes')
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in text):
        raise ValueError('Name must not contain control characters')
    return raw
