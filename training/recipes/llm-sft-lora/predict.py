"""Offline inference from a Code Flow adapter export and its exact base model."""
import argparse
import hashlib
import json
import os
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verify(folder, files):
    for entry in files:
        name = entry['path']
        path = folder / name
        if '..' in Path(name).parts or Path(name).is_absolute() or path.is_symlink() or not path.is_file() or sha(path) != entry['hash']:
            raise ValueError('Export/base model checksum mismatch: ' + name)


def load(base, device='cpu'):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / 'manifest.json').read_text())
    verify(Path(base), manifest['base']['files'])
    verify(root, manifest['adapterFiles'])
    verify(root, manifest['tokenizerFiles'])
    if device == 'mps' and not torch.backends.mps.is_available() or device == 'cuda' and not torch.cuda.is_available():
        raise ValueError('Requested GPU is unavailable')
    dtype = torch.bfloat16 if device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=dtype, attn_implementation='eager').to(device)
    model = PeftModel.from_pretrained(model, root / 'adapter', local_files_only=True).eval()
    tokenizer = AutoTokenizer.from_pretrained(root / 'tokenizer', local_files_only=True, trust_remote_code=False)
    return model, tokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-model', required=True)
    parser.add_argument('--device', choices=['cpu', 'mps', 'cuda'], default='cpu')
    prompt = parser.add_mutually_exclusive_group(required=True)
    prompt.add_argument('--prompt')
    prompt.add_argument('--messages', help='JSON file containing the system/user/assistant prompt messages')
    parser.add_argument('--max-new-tokens', type=int, default=64)
    args = parser.parse_args()
    if not 1 <= args.max_new_tokens <= 512:
        parser.error('max-new-tokens must be between 1 and 512')
    import torch
    model, tokenizer = load(args.base_model, args.device)
    if args.messages:
        encoded = tokenizer.apply_chat_template(json.loads(Path(args.messages).read_text()), tokenize=True, return_dict=False, add_generation_prompt=True, enable_thinking=False)
    else:
        encoded = tokenizer.encode(args.prompt, add_special_tokens=True)
    ids = torch.tensor([encoded], dtype=torch.long, device=args.device)
    with torch.inference_mode():
        result = model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=args.max_new_tokens, do_sample=False, pad_token_id=tokenizer.eos_token_id)
    print(tokenizer.decode(result[0, len(encoded):], skip_special_tokens=True))


if __name__ == '__main__':
    main()
