import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from cryptography.exceptions import InvalidSignature
import package


class OtaTests(unittest.TestCase):
    def test_package_signature_integrity_target_and_size(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);private=root/'key.pem';public=root/'public.bin'
            package.init_key(private,public)
            image=(0x20010000).to_bytes(4,'little')+(0x19201).to_bytes(4,'little')+b'\x42'*1016
            data=package.sign(image,'0.1.0',private,public)
            path=root/'firmware.atag-ota';path.write_text(json.dumps(data))
            self.assertEqual(package.load_package(path)[1],image)
            data['image']=image[:-1].hex()+'43'
            data['sha256']=hashlib.sha256(bytes.fromhex(data['image'])).hexdigest()
            path.write_text(json.dumps(data))
            with self.assertRaises(InvalidSignature): package.load_package(path)
            data['target']='other-device';path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'target'):package.load_package(path)
            with self.assertRaises(FileExistsError):package.write_new(path,b'overwrite')
            with self.assertRaises(ValueError):package.init_key(private,public)
            with self.assertRaises(ValueError):package.sign(image+b'\0'*package.ACTIVE_SIZE,'0.1.0',private,public)


if __name__=='__main__':unittest.main()
