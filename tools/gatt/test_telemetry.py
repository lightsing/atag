import unittest

from atag_gatt import decode_information


# The same wire packet is consumed by the browser protocol tests.
TELEMETRY = bytes.fromhex(
    '0102031ef00fe40c40e201007856341284030000040000000102030405060708000076006009540b'
)


class TelemetryTests(unittest.TestCase):
    def test_version_one_layout_matches_browser_vector(self):
        info = decode_information(TELEMETRY)
        self.assertEqual(info['version'], 1)
        self.assertEqual((info['mode'], info['phase']), (2, 3))
        self.assertEqual((info['battery_mv'], info['supply_mv']), (4080, 3300))
        self.assertEqual(info['uptime_seconds'], 123456)
        self.assertEqual(info['rotation'], 0x12345678)
        self.assertEqual(info['device_id'], '0102030405060708')
        self.assertEqual(info['connection_seconds_left'], 118)
        self.assertEqual((info['overdischarge_mv'], info['recovery_mv']), (2400, 2900))
        self.assertTrue(info['encrypted'])

    def test_other_versions_and_lengths_are_rejected(self):
        for version in (0, 2, 3, 255):
            with self.subTest(version=version), self.assertRaises(ValueError):
                decode_information(bytes([version]) + TELEMETRY[1:])
        for wire in (b'', TELEMETRY[:-1], TELEMETRY + b'\0'):
            with self.subTest(length=len(wire)), self.assertRaises(ValueError):
                decode_information(wire)


if __name__ == '__main__':
    unittest.main()
