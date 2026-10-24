"""Fixed, offline, single-device LoRA recipe. Inputs never authorize Python code."""
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import sys
import tarfile
import time
import unicodedata

RECIPE = 'llm-sft-lora-v1'
MAX_MODEL_BYTES = 16 * 1024 ** 3
SUPPORTED = {'llama', 'qwen2', 'qwen3', 'gpt2'}
MODEL_FILES = {'config.json', 'generation_config.json', 'model.safetensors.index.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'tokenizer.model', 'chat_template.jinja', 'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'README.md'}


# The bundled worker installs this helper beside the recipe; source tests use training/.
if not Path(__file__).with_name('holdout.py').exists():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from holdout import llm_exclusions


def save(path, value):
    path = Path(path)
    temp = path.with_suffix('.tmp')
    with temp.open('w') as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Model inputs must be regular files, not symlinks: ' + path.name)
    return path.stat()


def read_json(path):
    if regular(path).st_size > 2 * 1024 * 1024:
        raise ValueError('Model metadata is too large: ' + path.name)
    return json.loads(path.read_text())


def probe():
    if sys.version_info[:2] != (3, 12):
        raise ValueError('This recipe requires Python 3.12')
    from packaging.requirements import Requirement
    lock = Path(__file__).with_name('llm_requirements.txt')
    if not lock.exists():
        lock = Path(__file__).with_name('requirements.txt')
    for line in lock.read_text().splitlines():
        if line and line[0].isalnum() and '==' in line:
            requirement = Requirement(line.rstrip(' \\'))
            if requirement.marker is None or requirement.marker.evaluate():
                if importlib.metadata.version(requirement.name) not in requirement.specifier:
                    raise ValueError('Installed dependency differs from the recipe lock: ' + requirement.name)
    import torch
    from trl import SFTTrainer, SFTConfig
    from peft import LoraConfig
    devices = ['cpu']
    if torch.backends.mps.is_available():
        devices.append('mps')
    if torch.cuda.is_available():
        devices.append('cuda')
    return {'ready': True, 'devices': devices}


def snapshot_model(job, source, root):
    from safetensors import safe_open
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Choose a regular model directory on this training computer')
    paths = sorted(p for p in source.iterdir() if p.name in MODEL_FILES or re.fullmatch(r'model(?:-\d+-of-\d+)?\.safetensors', p.name))
    if not 2 <= len(paths) <= 128 or not any(p.suffix == '.safetensors' for p in paths):
        raise ValueError('Choose a Hugging Face model folder containing config, tokenizer and safetensors weights')
    before = {p.name: regular(p) for p in paths}
    total = sum(s.st_size for s in before.values())
    if total > MAX_MODEL_BYTES:
        raise ValueError('The model exceeds the 16 GiB snapshot limit')
    if shutil.disk_usage(root).free < total + 1024 ** 3:
        raise ValueError('Not enough free disk for an immutable model snapshot and working files')
    config = read_json(source / 'config.json')
    if config.get('model_type') not in SUPPORTED or config.get('auto_map') or config.get('quantization_config'):
        raise ValueError('Use an unquantized built-in Llama, Qwen2, Qwen3 or GPT-2 model; custom model code and quantized weights are unsupported')
    if (source / 'tokenizer_config.json').exists() and read_json(source / 'tokenizer_config.json').get('auto_map'):
        raise ValueError('Custom tokenizer code is unsupported')
    context = int(config.get('max_position_embeddings', config.get('n_positions', 0)))
    if context < 32 or context > 10000000:
        raise ValueError('Unsupported model context length')
    index = read_json(source / 'model.safetensors.index.json') if (source / 'model.safetensors.index.json').exists() else None
    if index and (not isinstance(index.get('weight_map'), dict) or not set(index['weight_map'].values()).issubset(before)):
        raise ValueError('Weight index references missing or external shards')
    parameters, keys = 0, set()
    for p in paths:
        if p.suffix == '.safetensors':
            with safe_open(p, framework='pt', device='cpu') as weights:
                for key in weights.keys():
                    if key in keys:
                        raise ValueError('Duplicate weight across shards')
                    keys.add(key)
                    parameters += math.prod(weights.get_slice(key).get_shape())
    if not 1 <= parameters <= 8000000000:
        raise ValueError('This preview supports up to eight billion model parameters')
    models = root / 'models'
    models.mkdir(exist_ok=True)
    temporary = models / (job.name + '.partial')
    temporary.mkdir(mode=0o700)
    try:
        files = []
        for p in paths:
            out = temporary / p.name
            digest = hashlib.sha256()
            with p.open('rb') as src, out.open('xb') as dst:
                for block in iter(lambda: src.read(1024 * 1024), b''):
                    digest.update(block)
                    dst.write(block)
                dst.flush()
                os.fsync(dst.fileno())
            out.chmod(0o400)
            files.append({'path': p.name, 'bytes': out.stat().st_size, 'hash': digest.hexdigest()})
        for p in paths:
            a, b = before[p.name], regular(p)
            if (a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns) != (b.st_ino, b.st_size, b.st_mtime_ns, b.st_ctime_ns):
                raise ValueError('Model changed during preparation; prepare it again')
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(temporary, local_files_only=True, trust_remote_code=False)
        if tokenizer.eos_token_id is None:
            raise ValueError('The base tokenizer must define an end-of-sequence token')
        summary = {'hash': fingerprint(files), 'bytes': total, 'parameters': parameters, 'architecture': config['model_type'], 'contextLength': context, 'files': len(files)}
        save(temporary / '_snapshot.json', {'summary': summary, 'files': files})
        destination = models / summary['hash']
        if destination.exists():
            verify_model(destination, summary)
        else:
            temporary.rename(destination)
            fd = os.open(models, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        save(job / 'model.json', summary)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def verify_model(folder, expected):
    manifest = read_json(folder / '_snapshot.json')
    if manifest['summary'] != expected or fingerprint(manifest['files']) != expected['hash']:
        raise ValueError('Model snapshot identity changed')
    for item in manifest['files']:
        name = item['path']
        if Path(name).name != name or name in {'.', '..'}:
            raise ValueError('Invalid model manifest path')
        path = folder / name
        if regular(path).st_size != item['bytes'] or sha(path) != item['hash']:
            raise ValueError('Model snapshot contents changed: ' + name)
    return manifest


def rows(path):
    if Path(path).stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Fine-tuning data is limited to 32 MiB')
    result, schema = [], None
    with open(path, encoding='utf-8') as stream:
        for number, line in enumerate(stream, 1):
            if len(line.encode()) > 128 * 1024:
                raise ValueError(f'JSONL line {number} exceeds 128 KiB')
            if not line.strip():
                raise ValueError(f'JSONL line {number} is empty')
            row = json.loads(line)
            if not isinstance(row, dict) or not set(row).issubset({'prompt', 'completion', 'messages', 'group'}):
                raise ValueError(f'Invalid fields on JSONL line {number}')
            kind = 'messages' if 'messages' in row else 'prompt-completion'
            if schema is not None and schema != kind:
                raise ValueError('Use the same example format throughout the JSONL file')
            schema = kind
            if 'group' in row and (not isinstance(row['group'], str) or not row['group'].strip() or len(row['group']) > 200):
                raise ValueError('Optional group values must be nonempty strings up to 200 characters')
            if kind == 'messages':
                if 'prompt' in row or 'completion' in row or not isinstance(row['messages'], list) or not 2 <= len(row['messages']) <= 64:
                    raise ValueError('Messages examples need 2–64 role/content messages')
                messages = row['messages']
                for i, m in enumerate(messages):
                    if not isinstance(m, dict) or set(m) != {'role', 'content'} or m['role'] not in {'system', 'user', 'assistant'} or not isinstance(m['content'], str) or not m['content'].strip():
                        raise ValueError('Messages need a supported role and nonempty text content')
                    if m['role'] == 'system' and i != 0:
                        raise ValueError('Only the first message may have the system role')
                dialogue = messages[1:] if messages[0]['role'] == 'system' else messages
                if any(m['role'] != ('user' if i % 2 == 0 else 'assistant') for i, m in enumerate(dialogue)) or dialogue[-1]['role'] != 'assistant':
                    raise ValueError('Conversations must alternate user/assistant and end with an assistant answer')
            elif any(not isinstance(row.get(k), str) or not row[k].strip() for k in ['prompt', 'completion']):
                raise ValueError('Every example needs nonempty prompt and completion strings')
            result.append(row)
            if len(result) > 10000:
                raise ValueError('Use at most 10,000 examples in this preview')
    if len(result) < 30:
        raise ValueError('Use at least 30 examples for separate training, tuning and test partitions')
    return result, schema


def content(row):
    return {k: v for k, v in row.items() if k != 'group'}


def inspect(path):
    data, schema = rows(path)
    columns = ['messages'] if schema == 'messages' else ['prompt', 'completion']
    return {'rows': len(data), 'columns': columns, 'missing': {c: 0 for c in columns}, 'duplicateRows': len(data) - len({fingerprint(content(r)) for r in data}), 'schema': schema}


def partition(data, seed):
    # Union both explicit groups and normalized prompts before deduplication. An
    # identical prompt cannot leak across partitions even under different group IDs.
    parent = list(range(len(data)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen, unique = {}, {}
    for i, row in enumerate(data):
        def normalize(text):
            return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())
        normalized = json.dumps([{'role': m['role'], 'content': normalize(m['content'])} for m in row['messages'][:-1]], sort_keys=True, ensure_ascii=False) if 'messages' in row else normalize(row['prompt'])
        keys = ['prompt:' + normalized] + (['group:' + row['group']] if 'group' in row else [])
        for key in keys:
            if key in seen:
                parent[find(i)] = find(seen[key])
            seen[key] = i
        unique.setdefault(fingerprint(content(row)), i)
    groups = {}
    for i in unique.values():
        groups.setdefault(find(i), []).append(i)
    buckets = list(groups.values())
    if len(buckets) < 5:
        raise ValueError('Use at least five independent prompt/group sets for held-out evaluation')
    random.Random(seed).shuffle(buckets)
    a, b = int(len(buckets) * .6), int(len(buckets) * .8)
    parts = [[i for group in chunk for i in group] for chunk in [buckets[:a], buckets[a:b], buckets[b:]]]
    if min(map(len, parts)) < 5:
        raise ValueError('Each split needs at least five unique examples; revise the groups')
    return parts, len(data) - len(unique)


def tokenize(row, tokenizer, limit):
    if 'messages' in row:
        if not tokenizer.chat_template:
            raise ValueError('Messages data requires a chat template supplied with the model')
        prompt = tokenizer.apply_chat_template(row['messages'][:-1], tokenize=True, return_dict=False, add_generation_prompt=True, enable_thinking=False)
        full = tokenizer.apply_chat_template(row['messages'], tokenize=True, return_dict=False, add_generation_prompt=False, enable_thinking=False)
        if full[:len(prompt)] != prompt:
            raise ValueError('This chat template cannot produce a verified completion boundary')
    else:
        prompt = tokenizer.encode(row['prompt'], add_special_tokens=True)
        full = prompt + tokenizer.encode(row['completion'], add_special_tokens=False)
    if not prompt or len(full) <= len(prompt):
        raise ValueError('Example has no prompt or supervised answer tokens')
    if full[-1] != tokenizer.eos_token_id:
        full.append(tokenizer.eos_token_id)
    if len(full) > limit:
        raise ValueError(f'An example has {len(full)} tokens, exceeding sequence length {limit}; shorten it or explicitly increase the limit')
    return {'input_ids': full, 'labels': [-100] * len(prompt) + full[len(prompt):]}


def runtime(spec, expected):
    import torch
    import psutil
    device = spec['device']
    if device == 'cuda' and (not torch.cuda.is_available() or torch.cuda.device_count() != 1):
        raise ValueError('The selected NVIDIA GPU is unavailable to PyTorch; check its driver and runtime')
    if device == 'mps' and not torch.backends.mps.is_available():
        raise ValueError('Apple GPU training is unavailable to this PyTorch environment')
    if device == 'cpu' and expected['parameters'] > 150000000:
        raise ValueError('CPU fine-tuning is limited to 150 million parameters; choose an available GPU for larger models')
    dtype = torch.bfloat16 if device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float32
    weight_bytes = 2 if dtype == torch.bfloat16 else 4
    estimated = int(expected['parameters'] * weight_bytes * 1.8 + spec['maxLength'] ** 2 * 2048 + 1024 ** 3)
    available = torch.cuda.mem_get_info()[0] if device == 'cuda' else psutil.virtual_memory().available
    if estimated > available:
        raise ValueError(f'Estimated training memory ({estimated // 1024 ** 2} MiB) exceeds currently available memory ({available // 1024 ** 2} MiB); choose a smaller model or shorter sequence')
    torch.set_num_threads(spec['cpus'])
    return device, dtype


def base_model(folder, device, dtype):
    from transformers import AutoModelForCausalLM
    return AutoModelForCausalLM.from_pretrained(folder, local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=dtype, attn_implementation='eager').to(device)


def lora_model(folder, device, dtype, spec):
    from peft import LoraConfig, get_peft_model
    model = base_model(folder, device, dtype)
    model.config.use_cache = False
    result = get_peft_model(model, LoraConfig(task_type='CAUSAL_LM', r=spec['rank'], lora_alpha=spec['rank'] * 2, lora_dropout=0.0, target_modules='all-linear', bias='none'))
    result.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    result.enable_input_require_grads()
    return result


def collate(items, pad):
    import torch
    size = max(len(i['input_ids']) for i in items)
    return {name: torch.tensor([item[name] + [fill] * (size - len(item[name])) for item in items], dtype=torch.long) for name, fill in [('input_ids', pad), ('labels', -100)]} | {'attention_mask': torch.tensor([[1] * len(item['input_ids']) + [0] * (size - len(item['input_ids'])) for item in items], dtype=torch.long)}


def inputs(job, root):
    accepted = json.loads((job / 'intent.json').read_text())
    folder = root / 'models' / accepted['model']['hash']
    verify_model(folder, accepted['model'])
    spec = accepted['spec']
    device, dtype = runtime(spec, accepted['model'])
    from transformers import set_seed, AutoTokenizer
    set_seed(spec['seed'])
    tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True, trust_remote_code=False)
    if tokenizer.eos_token_id is None:
        raise ValueError('The model tokenizer must define an end-of-sequence token')
    tokenizer.pad_token = tokenizer.pad_token or tokenizer.eos_token
    tokenizer.padding_side = 'right'
    return accepted, folder, spec, device, dtype, tokenizer


def prepare(job, snapshot, root):
    accepted, folder, spec, device, dtype, tokenizer = inputs(job, root)
    if spec['maxLength'] > accepted['model']['contextLength']:
        raise ValueError('Sequence length exceeds the base model context')
    data, schema = rows(snapshot)
    parts, dropped = partition(data, spec['seed'])
    tokenized = [[tokenize(data[i], tokenizer, spec['maxLength']) for i in part] for part in parts]
    if sum(len(row['input_ids']) for part in tokenized for row in part) > 10000000:
        raise ValueError('Tokenized dataset exceeds the ten-million-token preview limit')
    for name, part in zip(['train', 'tuning', 'test'], tokenized):
        save(job / (name + '.json'), part)
    save(job / 'split.json', dict(zip(['train', 'tuning', 'test'], parts)) | {'seed': spec['seed'], 'strategy': 'prompt-and-group-v1'})
    smoke_loss = None
    if not accepted.get('search', {}).get('fromJob'):
        # A real forward/backward check on the selected accelerator precedes fitting.
        model = lora_model(folder, device, dtype, spec)
        example = max(tokenized[0], key=lambda r: len(r['input_ids']))
        batch = {k: v.to(device) for k, v in collate([example], tokenizer.pad_token_id).items()}
        loss = model(**batch).loss
        if not math.isfinite(loss.item()):
            raise ValueError('Forward smoke check produced nonfinite loss')
        loss.backward()
        gradients = [p.grad for p in model.parameters() if p.requires_grad and p.grad is not None]
        if not gradients or not all(g.isfinite().all().item() for g in gradients):
            raise ValueError('Backward smoke check produced no finite adapter gradients')
        smoke_loss = loss.item()
    save(job / 'exclusions.json', llm_exclusions(data, [row for part in tokenized for row in part]))
    save(job / 'prepared.json', {'trainRows': len(parts[0]), 'tuningRows': len(parts[1]), 'testRows': len(parts[2]), 'droppedDuplicates': dropped, 'splitHash': sha(job / 'split.json'), 'schema': schema, 'device': device, 'dtype': str(dtype), 'smokeLoss': smoke_loss})


def train(job, root):
    accepted, folder, spec, device, dtype, tokenizer = inputs(job, root)
    import torch
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTTrainer, SFTConfig
    model = lora_model(folder, device, dtype, spec)
    started = time.monotonic()
    class Progress(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):
            save(job / 'progress.json', {'step': state.global_step, 'totalSteps': spec['maxSteps']})
            if time.monotonic() - started >= spec['trainSeconds'] * (0.8 if accepted.get('search') else 1):
                control.should_training_stop = True
        def on_log(self, args, state, control, logs=None, **kwargs):
            loss = (logs or {}).get('loss')
            if loss is not None and not math.isfinite(loss):
                raise ValueError('Training produced nonfinite loss')
            save(job / 'progress.json', {'step': state.global_step, 'totalSteps': spec['maxSteps'], **({'loss': loss} if loss is not None else {})})
    args = SFTConfig(output_dir=str(job / 'trainer'), max_steps=spec['maxSteps'], per_device_train_batch_size=1, per_device_eval_batch_size=1, gradient_accumulation_steps=spec['accumulation'], learning_rate=spec['learningRate'], max_length=spec['maxLength'], dataset_kwargs={'skip_prepare_dataset': True}, remove_unused_columns=False, packing=False, bf16=dtype == torch.bfloat16, fp16=False, use_cpu=device == 'cpu', optim='adamw_torch', report_to='none', push_to_hub=False, save_strategy='no', eval_strategy='no', logging_steps=1, logging_first_step=True, logging_nan_inf_filter=False, seed=spec['seed'], data_seed=spec['seed'], dataloader_num_workers=0, dataloader_pin_memory=False, gradient_checkpointing=True, gradient_checkpointing_kwargs={'use_reentrant': False}, disable_tqdm=True)
    trainer = SFTTrainer(model=model, args=args, processing_class=tokenizer, train_dataset=Dataset.from_list(json.loads((job / 'train.json').read_text())), eval_dataset=Dataset.from_list(json.loads((job / 'tuning.json').read_text())), data_collator=lambda items: collate(items, tokenizer.pad_token_id), callbacks=[Progress()])
    if trainer.accelerator.device.type != device:
        raise ValueError('Trainer selected a different device; no automatic compute fallback is allowed')
    trainer.train()
    if trainer.state.global_step < 1:
        raise ValueError('No training steps completed')
    model.save_pretrained(job / 'adapter', safe_serialization=True)
    # The export identifies its base by hashes, never by the worker's private path.
    config = json.loads((job / 'adapter/adapter_config.json').read_text())
    config['base_model_name_or_path'] = ''
    save(job / 'adapter/adapter_config.json', config)
    tokenizer.save_pretrained(job / 'tokenizer')
    save(job / 'training-result.json', {'steps': trainer.state.global_step, 'elapsedSeconds': time.monotonic() - started})


def score_model(model, data, device, pad):
    import torch
    total, count = 0.0, 0
    model.eval()
    with torch.inference_mode():
        for item in data:
            batch = {k: v.to(device) for k, v in collate([item], pad).items()}
            logits = model(input_ids=batch['input_ids'], attention_mask=batch['attention_mask']).logits[:, :-1].float()
            labels = batch['labels'][:, 1:]
            tokens = int((labels != -100).sum().item())
            loss = torch.nn.functional.cross_entropy(logits.reshape(-1, logits.size(-1)), labels.reshape(-1), ignore_index=-100, reduction='sum')
            total += float(loss.item())
            count += tokens
    if not count or not math.isfinite(total):
        raise ValueError('Evaluation needs finite loss on supervised completion tokens')
    return {'loss': total / count, 'tokens': count}


def evaluate(job, root, baseline=False):
    accepted, folder, spec, device, dtype, tokenizer = inputs(job, root)
    model = base_model(folder, device, dtype)
    if not baseline:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, job / 'adapter', local_files_only=True, is_trainable=False)
    partition = accepted.get('search', {}).get('partition', 'test')
    scored = score_model(model, json.loads((job / ('tuning.json' if partition == 'validation' else 'test.json')).read_text()), device, tokenizer.pad_token_id)
    if baseline:
        save(job / 'baseline.json', scored)
        return
    base = json.loads((job / 'baseline.json').read_text())
    if base['tokens'] != scored['tokens']:
        raise ValueError('Baseline and adapter evaluation token counts differ')
    prepared = json.loads((job / 'prepared.json').read_text())
    files = [{'path': str(p.relative_to(job)), 'bytes': regular(p).st_size, 'hash': sha(p)} for p in sorted((job / 'adapter').iterdir())]
    result = {k: prepared[k] for k in ['trainRows', 'tuningRows', 'testRows', 'droppedDuplicates', 'splitHash']}
    result.update({'partition': partition, 'metric': 'completion_nll', 'direction': 'lower', 'baseline': base['loss'], 'candidate': scored['loss'], 'improved': scored['loss'] < base['loss'], 'evaluatedTokens': scored['tokens'], 'datasetHash': accepted['dataset']['hash'], 'baseModelHash': accepted['model']['hash'], 'modelHash': fingerprint(files), 'recipe': RECIPE, 'seed': spec['seed']})
    save(job / 'evaluation.json', result)
    save(job / 'manifest.json', {'version': 1, 'recipe': RECIPE, 'bundle': accepted['bundle'], 'source': accepted['source'], 'base': read_json(folder / '_snapshot.json'), 'adapterFiles': files, 'tokenizerFiles': [{'path': str(p.relative_to(job)), 'bytes': regular(p).st_size, 'hash': sha(p)} for p in sorted((job / 'tokenizer').iterdir())], 'datasetHash': accepted['dataset']['hash'], 'splitHash': prepared['splitHash'], 'format': prepared['schema'], 'device': device, 'dtype': str(dtype), 'python': sys.version.split()[0], 'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions() if d.metadata.get('Name')}})


def package(job):
    accepted = json.loads((job / 'intent.json').read_text())
    save(job / 'training.json', accepted['spec'])
    shutil.copyfile(Path(__file__).with_name('llm_requirements.txt'), job / 'requirements.txt')
    shutil.copyfile(Path(__file__).with_name('llm_predict.py'), job / 'predict.py')
    (job / 'README.md').write_text('# Code Flow LoRA adapter\n\nInstall requirements.txt with Python 3.12 and pip --require-hashes.\nUse the exact original safetensors base-model folder: weights are not duplicated in this export.\nRun `python predict.py --base-model /path/to/base --prompt "Your prompt"`.\nFor conversations, use --messages messages.json instead of --prompt.\nAdd --device mps or --device cuda to select an available GPU.\nThe loader verifies base and adapter hashes. No model download or cloud account is required.\nHeld-out completion loss measures likelihood of reference answers, not broad quality or safety.\nNo training examples or tokenized partitions are included.\n')
    files = list((job / 'adapter').iterdir()) + list((job / 'tokenizer').iterdir())
    files += [job / name for name in ['exclusions.json', 'requirements.txt', 'predict.py', 'README.md', 'training.json', 'training-result.json', 'evaluation.json', 'manifest.json']]
    if sum(regular(p).st_size for p in files) > 512 * 1024 ** 2:
        raise ValueError('Adapter export exceeds 512 MiB')
    with tarfile.open(job / 'model.tar.gz.tmp', 'w:gz') as archive:
        for p in sorted(files):
            archive.add(p, arcname=str(p.relative_to(job)), recursive=False)
    (job / 'model.tar.gz.tmp').replace(job / 'model.tar.gz')
    save(job / 'artifact.json', {'hash': sha(job / 'model.tar.gz'), 'bytes': (job / 'model.tar.gz').stat().st_size, 'filename': 'model.tar.gz'})


def main():
    action = sys.argv[1]
    if action == 'probe':
        print(json.dumps(probe()))
    elif action == 'inspect':
        print(json.dumps(inspect(sys.argv[2])))
    else:
        job = Path(sys.argv[2])
        if action == 'snapshot-model':
            snapshot_model(job, sys.argv[3], Path(sys.argv[4]))
        elif action == 'prepare':
            prepare(job, sys.argv[3], Path(sys.argv[4]))
        elif action == 'train':
            train(job, Path(sys.argv[3]))
        elif action in {'evaluate', 'baseline'}:
            evaluate(job, Path(sys.argv[3]), baseline=action == 'baseline')
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
