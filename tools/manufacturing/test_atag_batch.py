import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import atag_batch


class BatchTests(unittest.TestCase):
    def test_hex_round_trip_preserves_flash_and_uicr_addresses(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.hex'
            memory = {0: 0x12, 1: 0x34, 0x19000: 0xab, 0x7c000: 0xcd,
                      0x10001200: 21, 0x10001204: 21}
            atag_batch.write_hex(path, memory)
            self.assertEqual(atag_batch.read_hex(path), memory)
            text = path.read_text().replace('AB', 'AC', 1)
            path.write_text(text)
            with self.assertRaises(ValueError): atag_batch.read_hex(path)

    def test_merge_rejects_different_bytes_at_same_address(self):
        memory = {0x19000: 1}
        atag_batch.merge(memory, {0x19000: 1})
        with self.assertRaises(ValueError): atag_batch.merge(memory, {0x19000: 2})

    def test_same_physical_board_cannot_consume_two_units(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {'files': {}, 'units': [
                {'unit': 'unit-01', 'state': 'verified', 'chip_id': '12345678-abcdef01'},
                {'unit': 'unit-02', 'state': 'pending', 'chip_id': None}]}
            (root / 'manifest.json').write_text(json.dumps(manifest))
            args = argparse.Namespace(batch=root, unit=None, retry=False, probe='test', speed=1000)
            with patch.object(atag_batch, 'read_words', side_effect=[
                    [0x52832, 0, 0, 64, 512], [0x12345678, 0xabcdef01]]), \
                 patch.object(atag_batch, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'already assigned'):
                    atag_batch.flash(args)
                run.assert_not_called()
            self.assertEqual(json.loads((root / 'manifest.json').read_text()), manifest)


if __name__ == '__main__': unittest.main()
