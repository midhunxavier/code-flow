"""Pinned, trusted tabular recipe. No user code, network downloads or agent execution."""
import csv
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tarfile

VERSION = '1.6.1'
RECIPE = 'tabular-autogluon-v1'
MAX_ROWS = 250000
MAX_COLUMNS = 256


# The bundled worker installs this helper beside the recipe; source tests use training/.
if not Path(__file__).with_name('holdout.py').exists():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from holdout import tabular_exclusions


def save(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w') as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_table(path):
    import pandas as pd
    if str(path).endswith('.csv'):
        with open(path, newline='', encoding='utf-8-sig') as stream:
            header = next(csv.reader(stream), [])
        if not header or len(header) != len(set(header)) or any(not c.strip() for c in header):
            raise ValueError('CSV headers must be unique, nonempty column names')
        df = pd.read_csv(path, nrows=MAX_ROWS + 1)
    else:
        import pyarrow.parquet as pq
        metadata = pq.read_metadata(path)
        if metadata.num_rows > MAX_ROWS or metadata.num_columns > MAX_COLUMNS:
            raise ValueError('Dataset exceeds the 250,000 row / 256 column limit')
        df = pd.read_parquet(path)
    if not 30 <= len(df) <= MAX_ROWS or not 2 <= len(df.columns) <= MAX_COLUMNS:
        raise ValueError('Use 30–250,000 rows and 2–256 columns')
    if any(not isinstance(c, str) or not c.strip() or len(c) > 200 for c in df.columns):
        raise ValueError('Column names must be text, at most 200 characters')
    return df


def inspect(path):
    df = load_table(path)
    return {'rows': len(df), 'columns': list(df.columns), 'missing': {c: int(df[c].isna().sum()) for c in df.columns}, 'duplicateRows': int(df.duplicated().sum())}


def prepare(job, snapshot):
    import numpy as np
    import pandas as pd
    from sklearn.model_selection import train_test_split, GroupShuffleSplit
    accepted = json.loads((job / 'intent.json').read_text())
    spec = accepted['spec']
    df = load_table(snapshot)
    original = len(df)
    df = df.drop_duplicates()
    label = spec['label']
    if df[label].isna().any():
        raise ValueError('The target contains missing labels')
    if spec['task'] == 'regression':
        df[label] = pd.to_numeric(df[label], errors='raise')
        if not np.isfinite(df[label]).all():
            raise ValueError('Regression targets must be finite numbers')
    else:
        if not 2 <= df[label].nunique() <= 100 or df[label].value_counts().min() < 5:
            raise ValueError('Classification needs 2–100 classes with at least five distinct examples per class')
    split = spec['split']
    if split['kind'] == 'random':
        stratify = df[label] if spec['task'] == 'classification' else None
        rest, test = train_test_split(df, test_size=0.2, random_state=spec['seed'], stratify=stratify)
        train, tuning = train_test_split(rest, test_size=0.25, random_state=spec['seed'], stratify=rest[label] if stratify is not None else None)
    elif split['kind'] == 'group':
        groups = df[split['column']]
        if groups.isna().any() or groups.nunique() < 5:
            raise ValueError('Group splits need at least five groups and no missing group values')
        a, b = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=spec['seed']).split(df, groups=groups))
        rest, test = df.iloc[a], df.iloc[b]
        a, b = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=spec['seed']).split(rest, groups=rest[split['column']]))
        train, tuning = rest.iloc[a], rest.iloc[b]
    else:
        times = pd.to_datetime(df[split['column']], utc=True, errors='raise')
        if times.isna().any():
            raise ValueError('Time split values cannot be missing')
        unique = sorted(times.unique())
        if len(unique) < 5:
            raise ValueError('Time splits need at least five distinct times')
        cut1, cut2 = unique[int(len(unique) * 0.6)], unique[int(len(unique) * 0.8)]
        train, tuning, test = df[times < cut1], df[(times >= cut1) & (times < cut2)], df[times >= cut2]
    if min(map(len, [train, tuning, test])) < 5:
        raise ValueError('Each training, tuning and test partition needs at least five distinct rows')
    if spec['task'] == 'classification':
        classes = set(train[label])
        if len(classes) < 2 or not set(tuning[label]).issubset(classes) or not set(test[label]).issubset(classes):
            raise ValueError('Every tuning/test class must occur in training; revise the data or split')
    split_manifest = {'kind': split, 'seed': spec['seed'], 'train': list(map(int, train.index)), 'tuning': list(map(int, tuning.index)), 'test': list(map(int, test.index))}
    save(job / 'split.json', split_manifest)
    (job / 'training').mkdir(exist_ok=True)
    (job / 'evaluation').mkdir(exist_ok=True)
    # The group/time key is used to split, never as a model feature in this recipe.
    excluded = [split['column']] if split['kind'] != 'random' else []
    for frame, dest in [(train, job / 'training/train.parquet'), (tuning, job / 'training/tuning.parquet'), (test, job / 'evaluation/test.parquet')]:
        frame.drop(columns=excluded).to_parquet(dest, index=False)
    baseline = train[label].mode().iloc[0] if spec['task'] == 'classification' else float(train[label].mean())
    if hasattr(baseline, 'item'):
        baseline = baseline.item()
    save(job / 'exclusions.json', tabular_exclusions(df, spec, baseline))
    save(job / 'prepared.json', {'trainRows': len(train), 'tuningRows': len(tuning), 'testRows': len(test), 'droppedDuplicates': original - len(df), 'baseline': baseline, 'splitHash': sha(job / 'split.json')})


def train(job):
    import pandas as pd
    from autogluon.tabular import TabularPredictor
    accepted = json.loads((job / 'intent.json').read_text())
    spec = accepted['spec']
    import random
    import numpy as np
    random.seed(spec['seed'])
    np.random.seed(spec['seed'])
    data = pd.read_parquet(job / 'training/train.parquet')
    tuning = pd.read_parquet(job / 'training/tuning.parquet')
    problem = 'regression' if spec['task'] == 'regression' else 'binary' if data[spec['label']].nunique() == 2 else 'multiclass'
    metric = 'root_mean_squared_error' if problem == 'regression' else 'accuracy'
    predictor = TabularPredictor(label=spec['label'], problem_type=problem, eval_metric=metric, path=str(job / 'model'), verbosity=2)
    predictor.fit(data, tuning_data=tuning, time_limit=spec['trainSeconds'] * (0.85 if accepted.get('search') else 1), hyperparameters={'RF': {'n_estimators': spec.get('forest', {}).get('trees', 64), 'max_depth': spec.get('forest', {}).get('depth', 16), 'random_state': spec['seed']}, 'XT': {'n_estimators': spec.get('forest', {}).get('trees', 64), 'max_depth': spec.get('forest', {}).get('depth', 16), 'random_state': spec['seed']}}, num_cpus=spec['cpus'], num_gpus=0, fit_weighted_ensemble=False, calibrate_decision_threshold=False, fit_strategy='sequential')
    predictor.save_space()


def model_files(job):
    files = []
    for path in sorted((job / 'model').rglob('*')):
        if path.is_symlink():
            raise ValueError('Unexpected symlink in model artifact')
        if path.is_file():
            files.append({'path': str(path.relative_to(job)), 'hash': sha(path), 'bytes': path.stat().st_size})
    if not files or len(files) > 10000:
        raise ValueError('Invalid model artifact')
    return files


def evaluate(job):
    import numpy as np
    import pandas as pd
    from sklearn.metrics import accuracy_score, root_mean_squared_error
    from autogluon.tabular import TabularPredictor
    intent = json.loads((job / 'intent.json').read_text())
    spec = intent['spec']
    prepared = json.loads((job / 'prepared.json').read_text())
    partition = intent.get('search', {}).get('partition', 'test')
    data = pd.read_parquet(job / ('training/tuning.parquet' if partition == 'validation' else 'evaluation/test.parquet'))
    predictor = TabularPredictor.load(str(job / 'model'))
    predictions = predictor.predict(data.drop(columns=[spec['label']]))
    baseline_predictions = [prepared['baseline']] * len(data)
    scoring = root_mean_squared_error if spec['task'] == 'regression' else accuracy_score
    score = float(scoring(data[spec['label']], predictions))
    baseline = float(scoring(data[spec['label']], baseline_predictions))
    if not math.isfinite(score) or not math.isfinite(baseline):
        raise ValueError('Evaluation returned nonfinite metrics')
    files = model_files(job)
    model_hash = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    result = {k: prepared[k] for k in ['trainRows', 'tuningRows', 'testRows', 'droppedDuplicates', 'splitHash']}
    result.update({'partition': partition, 'metric': 'rmse' if spec['task'] == 'regression' else 'accuracy', 'direction': 'lower' if spec['task'] == 'regression' else 'higher', 'candidate': score, 'baseline': baseline, 'improved': score < baseline if spec['task'] == 'regression' else score > baseline, 'datasetHash': intent['dataset']['hash'], 'modelHash': model_hash, 'recipe': RECIPE, 'seed': spec['seed']})
    save(job / 'evaluation.json', result)
    save(job / 'manifest.json', {'version': 1, 'recipe': RECIPE, 'bundle': intent['bundle'], 'datasetHash': intent['dataset']['hash'], 'source': intent['source'], 'files': files, 'modelHash': model_hash, 'python': sys.version.split()[0], 'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions() if d.metadata.get('Name')}})


def package(job):
    intent = json.loads((job / 'intent.json').read_text())
    save(job / 'training.json', intent['spec'])
    shutil.copyfile(Path(__file__).with_name('requirements.txt'), job / 'requirements.txt')
    shutil.copyfile(Path(__file__).with_name('predict.py'), job / 'predict.py')
    (job / 'README.md').write_text('# Code Flow prediction model\n\nCreate a Python 3.12 virtual environment and run `pip install --require-hashes -r requirements.txt`.\n\nRun `python predict.py inputs.csv predictions.csv`. The target column is optional in inputs.\n\nThis artifact contains trusted Python model serialization: load only exports you trust.\nEvaluation is a single held-out comparison, not a guarantee of future accuracy.\n')
    files = [p for p in (job / 'model').rglob('*') if p.is_file()]
    files += [job / p for p in ['exclusions.json', 'evaluation.json', 'manifest.json', 'training.json', 'requirements.txt', 'predict.py', 'README.md']]
    if sum(p.stat().st_size for p in files) > 512 * 1024 * 1024:
        raise ValueError('Model exceeds the 512 MiB export limit')
    temporary = job / 'model.tar.gz.tmp'
    with tarfile.open(temporary, 'w:gz') as archive:
        for path in sorted(files):
            if path.is_symlink():
                raise ValueError('Artifact symlinks are unsupported')
            archive.add(path, arcname=str(path.relative_to(job)), recursive=False)
    temporary.replace(job / 'model.tar.gz')
    save(job / 'artifact.json', {'hash': sha(job / 'model.tar.gz'), 'bytes': (job / 'model.tar.gz').stat().st_size, 'filename': 'model.tar.gz'})


def main():
    action = sys.argv[1]
    if action == 'probe':
        actual = importlib.metadata.version('autogluon.tabular')
        import pandas, sklearn, pyarrow
        from packaging.requirements import Requirement
        for line in Path(__file__).with_name('requirements.txt').read_text().splitlines():
            if line and line[0].isalnum() and '==' in line:
                requirement = Requirement(line.rstrip(' \\'))
                if requirement.marker is None or requirement.marker.evaluate():
                    if importlib.metadata.version(requirement.name) not in requirement.specifier:
                        raise ValueError('Installed dependency differs from the recipe lock: ' + requirement.name)
        from autogluon.tabular import TabularPredictor
        if actual != VERSION or sys.version_info[:2] != (3, 12):
            raise ValueError('This recipe requires Python 3.12 and AutoGluon ' + VERSION)
        print(json.dumps({'ready': True, 'version': actual}))
    elif action == 'inspect':
        print(json.dumps(inspect(sys.argv[2]), allow_nan=False))
    else:
        job = Path(sys.argv[2]).resolve()
        if action == 'prepare':
            prepare(job, sys.argv[3])
        elif action == 'train':
            train(job)
        elif action == 'evaluate':
            evaluate(job)
        elif action == 'package':
            package(job)
        else:
            raise ValueError('Unsupported recipe operation')
        print(json.dumps({'completed': action}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
