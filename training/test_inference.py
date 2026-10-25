"""Standard-library checks for export handling; no model packages are required."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import inference


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, entries):
        path = self.root / 'model.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, kind, contents in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = len(contents) if kind == tarfile.REGTYPE else 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    item.linkname = '../outside'
                archive.addfile(item, io.BytesIO(contents) if kind == tarfile.REGTYPE else None)
        return path

    def test_regular_files_are_verified_after_extraction(self):
        archive = self.archive([('model/weights', tarfile.REGTYPE, b'trusted model')])
        target = self.root / 'artifacts/model'
        inference.extract(archive, target)
        inventory = json.loads((target / '.integrity.json').read_text())
        inference.verify(target, inventory['files'])
        (target / 'model/weights').write_text('changed model')
        with self.assertRaisesRegex(ValueError, 'changed'):
            inference.verify(target, inventory['files'])

    def test_traversal_links_and_duplicate_members_are_rejected(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE), ('model/../outside', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('link', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE), ('.integrity.json', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                inference.extract(self.archive([(name, kind, b'x')]), self.root / 'artifacts/model')
            self.assertFalse((self.root / 'artifacts/model').exists())
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            inference.extract(self.archive([('weights', tarfile.REGTYPE, b'a'), ('weights', tarfile.REGTYPE, b'b')]), self.root / 'artifacts/model')

    def test_expanded_size_is_bounded_before_materializing_file(self):
        limit = inference.LIMIT
        try:
            inference.LIMIT = 4
            with self.assertRaisesRegex(ValueError, 'Expanded'):
                inference.extract(self.archive([('weights', tarfile.REGTYPE, b'12345')]), self.root / 'artifacts/model')
        finally:
            inference.LIMIT = limit
        self.assertFalse((self.root / 'artifacts/model').exists())

    def test_replaced_base_file_and_parent_symlinks_are_rejected(self):
        folder = self.root / 'base'
        folder.mkdir()
        (folder / 'weights').write_bytes(b'abc')
        entries = [{'path': 'weights', 'bytes': 3, 'hash': inference.sha(folder / 'weights')}]
        (folder / 'weights').unlink()
        (self.root / 'outside').write_bytes(b'abc')
        (folder / 'weights').symlink_to(self.root / 'outside')
        with self.assertRaises(ValueError):
            inference.verify(folder, entries)


if __name__ == '__main__':
    unittest.main()
