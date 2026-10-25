"""Compact portfolio preloads preserve display inputs and full export files."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.exportPortfolioStudies import write_snapshot_views
from server.study_schema import normalize_study
from server.tests.test_study_schema import snapshot
from server.fundamentals_view import study_view


class PortfolioStudyViewTests(unittest.TestCase):
    def test_writes_compact_view_without_altering_canonical_export(self):
        document = normalize_study(snapshot())
        document['Metadata'].update(DataStage='complete', StaticSnapshot=True)
        entries = [{'ticker': document['Company']['Ticker'], 'id': document['Study']['StudyID'], 'file': 'studies/TEST.json'}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            full = root / 'public' / 'studies' / 'TEST.json'
            full.parent.mkdir(parents=True)
            full.write_text(json.dumps(document))
            with patch('scripts.exportPortfolioStudies.ROOT', root):
                write_snapshot_views(entries)
            self.assertEqual(json.loads(full.read_text()), document)
            compact = json.loads((root / 'public' / entries[0]['viewFile']).read_text())
            expected = study_view(document)
            expected['Metadata']['StaticSnapshot'] = True
            self.assertEqual(compact, expected)
            self.assertTrue(compact['Metadata']['StaticSnapshot'])
            self.assertEqual(compact['AnnualData'][0]['EPS'], document['AnnualData'][0]['EPS'])
