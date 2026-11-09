import unittest
from settings_codec import DEFAULTS, decode_settings, encode_name, encode_settings


class SettingsTests(unittest.TestCase):
    def test_default_round_trip_matches_firmware_layout(self):
        wire = encode_settings(DEFAULTS)
        self.assertEqual(len(wire), 64)
        self.assertEqual(wire[16:20], b'\x3c\x00\x78\x00')
        self.assertEqual(decode_settings(wire), DEFAULTS)

    def test_corruption_and_invalid_relationships_are_rejected(self):
        wire = bytearray(encode_settings(DEFAULTS))
        wire[12] ^= 1
        with self.assertRaises(ValueError): decode_settings(wire)
        with self.assertRaises(ValueError): encode_settings(dict(DEFAULTS, battery_low_mv=3000))
        with self.assertRaises(ValueError): encode_settings(dict(DEFAULTS, unknown_option=1))
        with self.assertRaises(ValueError): encode_settings(dict(DEFAULTS, connection_seconds=0))

    def test_signed_power_and_calibration_survive_round_trip(self):
        settings = dict(DEFAULTS, tx_power_dbm=-20, battery_calibration_ppm=-12345)
        self.assertEqual(decode_settings(encode_settings(settings)), settings)

    def test_led_flag_is_boolean_and_uses_existing_flag_bit(self):
        settings = dict(DEFAULTS, led_enabled=True)
        self.assertEqual(encode_settings(settings)[1],1)
        self.assertEqual(decode_settings(encode_settings(settings)),settings)
        with self.assertRaises(ValueError): encode_settings(dict(DEFAULTS,led_enabled=1))

    def test_name_limits_count_utf8_bytes(self):
        self.assertEqual(encode_name('我的标签'), '我的标签'.encode())
        for name in ('', ' ', 'x'*30, '\n标签', '\0'):
            with self.subTest(name=name), self.assertRaises(ValueError): encode_name(name)


if __name__ == '__main__': unittest.main()
