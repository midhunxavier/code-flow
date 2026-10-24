"""Real-data split checks; run with the pinned recipe Python environment."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd

spec = importlib.util.spec_from_file_location('recipe', Path(__file__).with_name('recipe.py'))
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class SplitContracts(unittest.TestCase):
    def prepare(self, kind, task='classification', frame=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        job = Path(temp.name)
        if frame is None:
            frame = pd.DataFrame({'feature': range(300), 'group': [i // 10 for i in range(300)], 'time': pd.date_range('2025-01-01', periods=300).astype(str), 'target': [i % 2 for i in range(300)]})
        frame.to_csv(job / 'input.csv', index=False)
        split = {'kind': kind}
        if kind != 'random':
            split['column'] = kind
        (job / 'intent.json').write_text(json.dumps({'spec': {'task': task, 'label': 'target', 'split': split, 'seed': 42}}))
        recipe.prepare(job, job / 'input.csv')
        return job, frame, json.loads((job / 'split.json').read_text())

    def test_random_is_disjoint_and_deduplicated(self):
        frame = pd.DataFrame({'feature': range(300), 'target': [i % 2 for i in range(300)]})
        job, _, split = self.prepare('random', frame=pd.concat([frame, frame.iloc[:20]], ignore_index=True))
        sets = [set(split[name]) for name in ['train', 'tuning', 'test']]
        self.assertEqual([len(s) for s in sets], [180, 60, 60])
        self.assertEqual(len(set.union(*sets)), 300)
        self.assertEqual(json.loads((job / 'prepared.json').read_text())['droppedDuplicates'], 20)
        again, _, repeat = self.prepare('random', frame=frame)
        self.assertEqual(split, repeat)

    def test_group_boundaries_are_preserved(self):
        job, frame, split = self.prepare('group')
        groups = [set(frame.iloc[split[name]]['group']) for name in ['train', 'tuning', 'test']]
        for a, b in [(0, 1), (0, 2), (1, 2)]:
            self.assertFalse(groups[a] & groups[b])
        self.assertNotIn('group', pd.read_parquet(job / 'training/train.parquet').columns)

    def test_time_boundaries_are_ordered_and_excluded(self):
        job, frame, split = self.prepare('time', 'regression')
        self.assertLess(frame.iloc[split['train']]['time'].max(), frame.iloc[split['tuning']]['time'].min())
        self.assertLess(frame.iloc[split['tuning']]['time'].max(), frame.iloc[split['test']]['time'].min())
        self.assertNotIn('time', pd.read_parquet(job / 'training/train.parquet').columns)
        expected = frame.iloc[split['train']]['target'].mean()
        self.assertEqual(json.loads((job / 'prepared.json').read_text())['baseline'], expected)

    def test_missing_labels_and_duplicate_headers_are_rejected(self):
        frame = pd.DataFrame({'feature': range(100), 'target': [None] + [i % 2 for i in range(99)]})
        with self.assertRaisesRegex(ValueError, 'missing labels'):
            self.prepare('random', frame=frame)
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'duplicate.csv'
            file.write_text('target,target\n1,2\n')
            with self.assertRaisesRegex(ValueError, 'unique'):
                recipe.inspect(file)

    def test_common_holdout_excludes_original_test_rows_and_normalized_inputs(self):
        from holdout import tabular_keys, reject_overlap, validate_tabular, tabular_exclusions, exclusion
        job, frame, split = self.prepare('random', frame=pd.DataFrame({'feature': range(100), 'target': [i % 2 for i in range(100)]}))
        evidence = json.loads((job / 'exclusions.json').read_text())
        original_test = frame.iloc[split['test']].copy()
        original_test['target'] = 99
        with self.assertRaisesRegex(ValueError, 'overlaps'):
            reject_overlap(tabular_keys(original_test, ['feature']), evidence)
        # Changing labels, number types or text case/whitespace does not hide leakage.
        other = pd.DataFrame({'feature': ['  SAME  prompt ', 'same\nprompt'], 'target': [1, 0]})
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            reject_overlap(tabular_keys(other, ['feature']), evidence)
        self.assertEqual(tabular_keys(pd.DataFrame({'x': [1]}), ['x']), tabular_keys(pd.DataFrame({'x': [1.0]}), ['x']))
        self.assertEqual(tabular_keys(pd.DataFrame({'x': [-0.0]}), ['x']), tabular_keys(pd.DataFrame({'x': [0.0]}), ['x']))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'retrain'):
                exclusion(Path(temp))
        for kind in ['group', 'time']:
            source = pd.DataFrame({'x': [1, 2], 'target': [0, 1], 'boundary': ['a', 'b'] if kind == 'group' else ['2025-01-01', '2025-01-02']})
            e = tabular_exclusions(source, {'task': 'classification', 'label': 'target', 'split': {'kind': kind, 'column': 'boundary'}}, 0)
            holdout = pd.DataFrame({'x': [3, 4], 'target': [0, 1], 'boundary': ['c', 'd'] if kind == 'group' else ['2025-01-03', '2025-01-04']})
            validate_tabular(holdout, [e, e], [{'features': ['x']}] * 2)
            holdout.loc[0, 'boundary'] = 'A' if kind == 'group' else '2025-01-02'
            with self.assertRaisesRegex(ValueError, 'groups|strictly later'):
                validate_tabular(holdout, [e, e], [{'features': ['x']}] * 2)
        e = tabular_exclusions(pd.DataFrame({'x': [1], 'g': [1], 'target': [0]}), {'task': 'classification', 'label': 'target', 'split': {'kind': 'group', 'column': 'g'}}, 0)
        with self.assertRaisesRegex(ValueError, 'groups'):
            validate_tabular(pd.DataFrame({'x': [2], 'g': [1.0], 'target': [1]}), [e, e], [{'features': ['x']}] * 2)


if __name__ == '__main__':
    unittest.main()
