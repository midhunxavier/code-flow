"""Common holdout evaluation and export-bound exclusion evidence. Never trains a model."""
import gc
import hashlib
import json
import math
from pathlib import Path
import sys
import unicodedata


class HoldoutError(ValueError):
    """Messages that contain only fixed, non-sensitive evaluation diagnostics."""


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value)).casefold().split())


def cell(value):
    import pandas as pd
    if pd.isna(value):
        return None
    if hasattr(value, 'item'):
        value = value.item()
    if isinstance(value, bool):
        return ['bool', value]
    if isinstance(value, (float, int)):
        if not math.isfinite(value):
            raise HoldoutError('Holdout comparison requires finite feature values')
        return ['number', format(float(value) if value else 0.0, '.17g')]
    return ['text', normalize(value)]


def tabular_keys(frame, columns):
    return [fingerprint([cell(v) for v in row]) for row in frame[columns].itertuples(index=False, name=None)]


def prompt_keys(row):
    prompt = [{'role': m['role'], 'content': normalize(m['content'])} for m in row['messages'][:-1]] if 'messages' in row else normalize(row['prompt'])
    return fingerprint(prompt)


def tabular_exclusions(frame, spec, baseline):
    split = spec['split']
    columns = sorted(c for c in frame.columns if c != spec['label'] and (split['kind'] == 'random' or c != split['column']))
    result = {'version': 1, 'kind': 'tabular', 'columns': columns, 'label': spec['label'], 'task': spec['task'], 'split': split, 'baseline': baseline, 'inputs': sorted(set(tabular_keys(frame, columns)))}
    if split['kind'] == 'group':
        result['groups'] = sorted({fingerprint(cell(v)) for v in frame[split['column']]})
    if split['kind'] == 'time':
        import pandas as pd
        result['lastTime'] = pd.to_datetime(frame[split['column']], utc=True, errors='raise').max().isoformat()
    return result


def encoded_prompt(item):
    return fingerprint([token for token, label in zip(item["input_ids"], item["labels"]) if label == -100])


def llm_exclusions(data, encoded):
    return {'version': 1, 'kind': 'llm', 'encodedInputs': sorted({encoded_prompt(item) for item in encoded}), 'inputs': sorted({prompt_keys(row) for row in data}), 'groups': sorted({fingerprint(normalize(row['group'])) for row in data if 'group' in row})}


def exclusion(folder):
    path = folder / 'exclusions.json'
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 48 * 1024 ** 2:
        raise HoldoutError('Export lacks common-holdout exclusion evidence; retrain with the current worker recipe')
    value = json.loads(path.read_text())
    if value.get('version') != 1 or not isinstance(value.get('inputs'), list) or not value['inputs']:
        raise HoldoutError('Invalid training exclusion evidence')
    return value


def reject_overlap(keys, evidence):
    if len(keys) != len(set(keys)):
        raise HoldoutError('Common holdout contains duplicate inputs; use independent examples')
    if set(keys).intersection(evidence['inputs']):
        raise HoldoutError('Common holdout overlaps model training, tuning or original test inputs')


def validate_tabular(data, exclusions, releases):
    import pandas as pd
    contract = exclusions[0]
    for e, r in zip(exclusions, releases):
        if e['kind'] != 'tabular' or e['columns'] != r['features'] or any(e[k] != contract[k] for k in ['columns', 'label', 'task', 'split']):
            raise HoldoutError('Holdout input, label or split contracts differ')
        expected = set(e['columns']) | {e['label']} | ({e['split']['column']} if e['split']['kind'] != 'random' else set())
        if set(data.columns) != expected or data[e['label']].isna().any():
            raise HoldoutError('Holdout schema or labels differ from the model contract')
        reject_overlap(tabular_keys(data, e['columns']), e)
        if e['split']['kind'] == 'group' and (data[e['split']['column']].isna().any() or {fingerprint(cell(v)) for v in data[e['split']['column']]}.intersection(e['groups'])):
            raise HoldoutError('Common holdout overlaps training groups or has missing groups')
        if e['split']['kind'] == 'time':
            times = pd.to_datetime(data[e['split']['column']], utc=True, errors='raise')
            if times.isna().any() or times.min() <= pd.Timestamp(e['lastTime']):
                raise HoldoutError('Time holdout must be strictly later than both original datasets')
    return contract


def validate_encoded(encoded, evidence):
    keys = [encoded_prompt(item) for item in encoded]
    if not evidence.get("encodedInputs"):
        raise HoldoutError("Export lacks tokenized training exclusion evidence")
    if len(keys) != len(set(keys)) or set(keys).intersection(evidence["encodedInputs"]):
        raise HoldoutError("Common holdout has duplicate tokenized prompts or overlaps tokenized training inputs")


def run(job, root):
    from inference import LoadedModel, sha, extract, read, verify
    accepted = json.loads((job / 'intent.json').read_text())
    pair, snapshot = accepted['holdout'], accepted['dataset']
    path = root / 'datasets' / (snapshot['hash'] + '.' + snapshot['format'])
    if sha(path) != snapshot['hash']:
        raise HoldoutError('Frozen holdout checksum changed')
    releases = [pair['incumbent'], pair['candidate']]
    folders, exclusions = [], []
    # Verify both artifacts and overlap evidence before loading either predictor.
    for r in releases:
        archive = root / 'serving/uploads' / (r['artifact']['hash'] + '.tar.gz')
        if archive.stat().st_size != r['artifact']['bytes'] or sha(archive) != r['artifact']['hash']:
            raise HoldoutError('Holdout export checksum changed')
        folder = root / 'serving/artifacts' / r['artifact']['hash']
        extract(archive, folder)
        verify(folder, read(folder / '.integrity.json')['files'])
        folders.append(folder)
        exclusions.append(exclusion(folder))
    llm = releases[0]['recipe'] == 'llm-sft-lora-v1'
    if llm:
        from llm_recipe import rows, tokenize, score_model
        data, schema = rows(path)
        keys = [prompt_keys(row) for row in data]
        groups = {fingerprint(normalize(row['group'])) for row in data if 'group' in row}
        for e in exclusions:
            if e['kind'] != 'llm':
                raise HoldoutError('Holdout exclusion contract differs')
            reject_overlap(keys, e)
            if groups.intersection(e['groups']):
                raise HoldoutError('Common holdout overlaps training conversation groups')
    else:
        from recipe import load_table
        import pandas as pd
        from sklearn.metrics import accuracy_score, root_mean_squared_error
        data = load_table(path)
        contract = validate_tabular(data, exclusions, releases)
        keys = tabular_keys(data, contract['columns'])
    if len(data) != snapshot['rows'] or not 30 <= len(data) <= 10000:
        raise HoldoutError('Holdout population differs from the approved snapshot')
    result = {'version': 1, 'datasetHash': snapshot['hash'], 'candidateHash': releases[1]['artifact']['hash'], 'incumbentHash': releases[0]['artifact']['hash'], 'evaluator': accepted['bundle'], 'rows': len(data)}
    population = None
    for index, r in enumerate(releases):
        model = LoadedModel({'root': str(root), 'release': r, 'mode': 'prepare'})
        if llm:
            encoded = [tokenize(row, model.tokenizer, pair['maxLength']) for row in data]
            validate_encoded(encoded, exclusions[index])
            current = fingerprint(encoded)
            if population is not None and current != population:
                raise HoldoutError('Models tokenize the common holdout differently')
            population = current
            pad = model.tokenizer.pad_token_id if model.tokenizer.pad_token_id is not None else model.tokenizer.eos_token_id
            score = score_model(model.model, encoded, r['config']['device'], pad)
            if index == 0:
                with model.model.disable_adapter():
                    baseline = score_model(model.model, encoded, r['config']['device'], pad)
                if baseline['tokens'] != score['tokens']:
                    raise HoldoutError('Base and adapter populations differ')
                result.update(metric='completion_nll', direction='lower', baseline=baseline['loss'], tokens=score['tokens'])
            elif result['tokens'] != score['tokens']:
                raise HoldoutError('Common holdout token counts differ')
            value = score['loss']
        else:
            classification = contract['task'] == 'classification'
            scoring = accuracy_score if classification else root_mean_squared_error
            predictions = model.predictor.predict(data[contract['columns']])
            value = float(scoring(data[contract['label']], predictions))
            if index == 0:
                # Incumbent's training-derived constant, never fitted on holdout labels.
                baseline = float(scoring(data[contract['label']], [contract['baseline']] * len(data)))
                result.update(metric='accuracy' if classification else 'rmse', direction='higher' if classification else 'lower', baseline=baseline)
            population = fingerprint(keys)
        result['incumbent' if index == 0 else 'candidate'] = value
        del model
        gc.collect()
        if llm:
            import torch
            if r['config']['device'] == 'cuda':
                torch.cuda.empty_cache()
            elif r['config']['device'] == 'mps':
                torch.mps.empty_cache()
    result['populationHash'] = population
    if any(not math.isfinite(result[k]) or result[k] < 0 for k in ['baseline', 'incumbent', 'candidate']):
        raise HoldoutError('Common holdout returned invalid scores')
    (job / 'holdout.json').write_text(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    try:
        run(Path(sys.argv[1]), Path(sys.argv[2]))
        print('Common holdout evaluation completed')
    except Exception as error:
        # Do not include private inputs or labels in controller-visible errors.
        message = str(error) if isinstance(error, HoldoutError) else 'Common holdout failed; check the model environment, data schema and memory limit.'
        (Path(sys.argv[1]) / 'holdout-error.json').write_text(json.dumps({'error': message}))
        print(message, file=sys.stderr)
        sys.exit(1)
