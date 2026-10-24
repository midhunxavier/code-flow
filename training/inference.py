"""Bounded, offline inference. Input arrives on stdin and is never written to disk."""
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile

class InputError(ValueError):
    pass


LIMIT = 512 * 1024 * 1024


def sha(path):
    digest = hashlib.sha256()
    if path.is_symlink() or not path.is_file():
        raise ValueError('Serving files must be regular files')
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Invalid serving manifest')
    return json.loads(path.read_text())


def safe_name(name):
    p = PurePosixPath(name)
    if p.is_absolute() or not name or '..' in p.parts or str(p) != name or '\\' in name or '\x00' in name or name.startswith('.'):
        raise ValueError('Unsafe export member')
    return p


def extract(archive, destination):
    """Regular-file-only extraction; never execute Python from an export."""
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError('Invalid serving artifact directory')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='unpack-', dir=destination.parent) as work:
        temporary = Path(work) / 'artifact'
        temporary.mkdir(mode=0o700)
        inventory, names, total = [], set(), 0
        with tarfile.open(archive, 'r:gz') as tar:
            for item in tar:
                path = safe_name(item.name)
                if not item.isfile() or item.name in names or len(names) >= 20000:
                    raise ValueError('Export has unsupported or duplicate members')
                total += item.size
                if item.size < 0 or total > LIMIT:
                    raise ValueError('Expanded model exceeds 512 MiB')
                names.add(item.name)
                output = temporary / path
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with output.open('xb') as target, tar.extractfile(item) as source:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                    target.flush()
                    os.fsync(target.fileno())
                inventory.append({'path': item.name, 'bytes': item.size, 'hash': sha(output)})
        retained = sum(read(p)['bytes'] for p in destination.parent.glob('*/.integrity.json'))
        if retained + total > 4 * 1024 ** 3:
            raise ValueError('Expanded serving exports reached the 4 GiB retention limit')
        (temporary / '.integrity.json').write_text(json.dumps({'bytes': total, 'files': inventory}))
        with (temporary / '.integrity.json').open('rb') as stream:
            os.fsync(stream.fileno())
        temporary.rename(destination)
        fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def verify(folder, entries):
    for e in entries:
        name = safe_name(e['path'])
        path = folder / name
        if any((folder / Path(*name.parts[:i])).is_symlink() for i in range(1, len(name.parts) + 1)) or path.stat().st_size != e['bytes'] or sha(path) != e['hash']:
            raise ValueError('Model or base weights changed; restore the exact registered export or base snapshot')


def environment(lock):
    if sys.version_info[:2] != (3, 12):
        raise ValueError('Serving requires Python 3.12')
    from packaging.requirements import Requirement
    for line in lock.read_text().splitlines():
        if line and line[0].isalnum() and '==' in line:
            requirement = Requirement(line.rstrip(' \\'))
            if requirement.marker is None or requirement.marker.evaluate():
                if importlib.metadata.version(requirement.name) not in requirement.specifier:
                    raise ValueError('Serving dependencies differ from the pinned recipe; install its environment')


class LoadedModel:
    """One verified model retained in memory for serial, bounded requests."""
    def __init__(self, request):
        r, root = request['release'], Path(request['root'])
        self.release = r
        archive = root / 'serving' / 'uploads' / (r['artifact']['hash'] + '.tar.gz')
        if archive.stat().st_size != r['artifact']['bytes'] or sha(archive) != r['artifact']['hash']:
            raise ValueError('Serving archive checksum changed')
        folder = root / 'serving' / 'artifacts' / r['artifact']['hash']
        if request['mode'] == 'prepare':
            extract(archive, folder)
        inventory = read(folder / '.integrity.json')
        verify(folder, inventory['files'])
        manifest, score = read(folder / 'manifest.json'), read(folder / 'evaluation.json')
        self.llm = r['recipe'] == 'llm-sft-lora-v1'
        if manifest.get('bundle') != r['trainingBundle'] or manifest.get('recipe') != r['recipe'] or score.get('modelHash') != r['modelHash'] or score.get('partition', 'test') != 'test':
            raise ValueError('Export provenance differs from the registered release')
        lock = Path(__file__).with_name('llm_requirements.txt' if self.llm else 'requirements.txt')
        if (folder / 'requirements.txt').read_bytes() != lock.read_bytes():
            raise ValueError('Export dependency lock differs from this serving worker')
        environment(lock)
        if not self.llm:
            if fingerprint(manifest['files']) != r['modelHash']:
                raise ValueError('Predictor manifest differs from registered model')
            verify(folder, manifest['files'])
            from autogluon.tabular import TabularPredictor
            self.predictor = TabularPredictor.load(str(folder / 'model'), verbosity=0)
            if not set(self.predictor.feature_metadata_in.get_features()).issubset(r['features']):
                raise ValueError('Predictor feature schema differs from registry')
            return
        if fingerprint(manifest['adapterFiles']) != r['modelHash'] or manifest['base']['summary'] != r['base'] or fingerprint(manifest['base']['files']) != r['base']['hash']:
            raise ValueError('Adapter or base model identity differs from the registry')
        base = root / 'models' / r['base']['hash']
        frozen = read(base / '_snapshot.json')
        if frozen != manifest['base']:
            raise ValueError('Prepare the exact frozen base model on this computer')
        verify(base, frozen['files'])
        verify(folder, manifest['adapterFiles'])
        verify(folder, manifest['tokenizerFiles'])
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import PeftModel
        cfg, device = r['config'], r['config']['device']
        torch.set_num_threads(cfg['cpus'])
        if device == 'mps' and not torch.backends.mps.is_available() or device == 'cuda' and not torch.cuda.is_available():
            raise ValueError('Requested inference device is unavailable')
        self.tokenizer = AutoTokenizer.from_pretrained(folder / 'tokenizer', local_files_only=True, trust_remote_code=False)
        dtype = torch.bfloat16 if device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float32
        import psutil
        available = torch.cuda.mem_get_info()[0] if device == 'cuda' else psutil.virtual_memory().available
        budget = cfg.get('memoryMiB', available / 1024 ** 2) * 1024 ** 2
        estimated = r['base']['parameters'] * (2 if dtype == torch.bfloat16 else 4) * 1.3 + 256 * 1024 ** 2
        if estimated > min(available, budget):
            raise ValueError('These base weights exceed available memory or the deployment memory limit')
        if cfg.get('mode') == 'persistent':
            if device == 'cuda':
                torch.cuda.set_per_process_memory_fraction(min(1.0, budget / torch.cuda.get_device_properties(0).total_memory))
            elif device == 'mps':
                torch.mps.set_per_process_memory_fraction(min(1.0, budget / torch.mps.recommended_max_memory()))
        self.model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=dtype, attn_implementation='eager').to(device)
        self.model = PeftModel.from_pretrained(self.model, folder / 'adapter', local_files_only=True).eval()
        with torch.inference_mode():
            ids = torch.tensor([[self.tokenizer.eos_token_id]], dtype=torch.long, device=device)
            self.model(input_ids=ids, attention_mask=torch.ones_like(ids))

    def predict(self, data, delta=None):
        r, cfg = self.release, self.release['config']
        if not self.llm:
            import pandas as pd
            if not isinstance(data.get('rows'), list) or not 1 <= len(data['rows']) <= cfg['maxRows'] or any(sorted(row) != sorted(r['features']) for row in data['rows']):
                raise InputError('Invalid prediction rows or feature schema')
            predictions = self.predictor.predict(pd.DataFrame(data['rows'], columns=r['features']))
            return {'predictions': json.loads(predictions.to_json(orient='values'))}
        import torch
        tokenizer = self.tokenizer
        encoded = tokenizer.encode(data['prompt'], add_special_tokens=True) if 'prompt' in data else tokenizer.apply_chat_template(data['messages'], tokenize=True, return_dict=False, add_generation_prompt=True, enable_thinking=False)
        if not encoded or len(encoded) > cfg['maxInputTokens'] or not 1 <= data['maxNewTokens'] <= cfg['maxNewTokens'] or len(encoded) + data['maxNewTokens'] > r['base']['contextLength']:
            raise InputError('Prompt or generation exceeds the deployment token limits')
        streamer = None
        if delta:
            from transformers import TextStreamer
            class Stream(TextStreamer):
                def on_finalized_text(self, text, stream_end=False):
                    if text:
                        delta(text)
            streamer = Stream(tokenizer, skip_prompt=True, skip_special_tokens=True)
        ids = torch.tensor([encoded], dtype=torch.long, device=cfg['device'])
        with torch.inference_mode():
            result = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=data['maxNewTokens'], do_sample=False, pad_token_id=tokenizer.eos_token_id, streamer=streamer)
        generated = result[0, len(encoded):]
        return {'text': tokenizer.decode(generated, skip_special_tokens=True), 'inputTokens': len(encoded), 'outputTokens': len(generated)}


def run(request):
    model = LoadedModel(request)
    return {'ready': True} if request.get('input') is None else model.predict(request['input'])


def serve():
    wire = sys.stdout
    def emit(value):
        wire.write(json.dumps(value, allow_nan=False) + '\n')
        wire.flush()
    def failure(error):
        return str(error)[:1000] if isinstance(error, ValueError) else 'Model inference failed; check the input, pinned environment and memory limit.'
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model = LoadedModel(json.loads(sys.stdin.readline(1024 * 1024)))
        emit({'type': 'ready'})
        for line in sys.stdin:
            try:
                if len(line.encode()) > 66000:
                    raise InputError('Inference request exceeds its size limit')
                value = json.loads(line)
                with contextlib.redirect_stdout(sys.stderr):
                    result = model.predict(value['input'], (lambda text: emit({'type': 'delta', 'text': text})) if value.get('stream') else None)
                emit({'type': 'done', 'result': result})
            except Exception as error:
                emit({'type': 'error', 'error': failure(error), 'kind': 'input' if isinstance(error, InputError) else 'runtime'})
    except Exception as error:
        emit({'type': 'error', 'error': failure(error), 'kind': 'input' if isinstance(error, InputError) else 'runtime'})


def probe(recipe):
    folder = Path(__file__).parent
    if recipe == 'tabular-autogluon-v1':
        environment(folder / 'requirements.txt')
        from autogluon.tabular import TabularPredictor
        return {'ready': True, 'devices': ['cpu']}
    if recipe != 'llm-sft-lora-v1':
        raise ValueError('Unsupported inference recipe')
    environment(folder / 'llm_requirements.txt')
    # Training-only imports (notably TRL's trainer) are unnecessary for serving.
    # Preparation loads the actual Transformers/PEFT model before enabling it.
    import torch
    devices = ['cpu']
    if torch.backends.mps.is_available():
        devices.append('mps')
    if torch.cuda.is_available():
        devices.append('cuda')
    return {'ready': True, 'devices': devices}


def main():
    request = json.loads(sys.stdin.read(1024 * 1024))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({'ok': True, 'result': result}, allow_nan=False))
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error)[:1000], 'kind': 'input' if isinstance(error, InputError) else 'runtime'}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'Model inference failed. Check the prepared base, input schema, available memory and pinned environment.'}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'probe':
        with contextlib.redirect_stdout(sys.stderr):
            result = probe(sys.argv[2])
        print(json.dumps(result))
    elif len(sys.argv) == 2 and sys.argv[1] == 'serve':
        serve()
    else:
        main()
