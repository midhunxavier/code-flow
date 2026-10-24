"""Offline fixtures and data-contract tests; no Hub access or pretrained downloads."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import recipe


def fixture(destination):
    import torch
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from tokenizers.pre_tokenizers import Whitespace
    from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    vocab = {'[UNK]': 0, '[PAD]': 1, '[EOS]': 2, 'user': 3, 'assistant': 4, 'system': 5, ':': 6, 'answer': 7, **{str(i): i + 8 for i in range(80)}}
    tokens = Tokenizer(WordLevel(vocab, unk_token='[UNK]'))
    tokens.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=tokens, unk_token='[UNK]', pad_token='[PAD]', eos_token='[EOS]', model_max_length=128)
    tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + ' ' }}{% if message['role'] == 'assistant' %}{{ eos_token }}{% endif %}{% endfor %}{% if add_generation_prompt %}{{ 'assistant: ' }}{% endif %}"
    tokenizer.save_pretrained(destination)
    torch.manual_seed(42)
    LlamaForCausalLM(LlamaConfig(vocab_size=len(vocab), hidden_size=32, intermediate_size=64, num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=2, max_position_embeddings=128, bos_token_id=None, eos_token_id=2, pad_token_id=1)).save_pretrained(destination, safe_serialization=True)
    for schema in ['prompt', 'messages']:
        data = [{'prompt': f'user: {i} assistant: ', 'completion': f'answer {i}'} if schema == 'prompt' else {'messages': [{'role': 'user', 'content': str(i)}, {'role': 'assistant', 'content': f'answer {i}'}]} for i in range(60)]
        (destination.parent / (schema + '.jsonl')).write_text(''.join(json.dumps(row) + '\n' for row in data))


class Contracts(unittest.TestCase):
    def test_group_and_prompt_transitive_split(self):
        data = [{'prompt': f'Question {i}', 'completion': f'Answer {i}', 'group': f'g-{i // 2}'} for i in range(60)]
        data += [dict(data[0]), {'prompt': 'QUESTION\n 0', 'completion': 'another answer', 'group': 'g-9'}]
        parts, dropped = recipe.partition(data, 42)
        self.assertEqual(dropped, 1)
        location = {i: n for n, part in enumerate(parts) for i in part}
        self.assertEqual(location[0], location[61])
        self.assertEqual(location[0], location[18])
        for i in range(0, 60, 2):
            self.assertEqual(location[i], location[i + 1])
        self.assertEqual((parts, dropped), recipe.partition(data, 42))
        with self.assertRaisesRegex(ValueError, 'independent'):
            recipe.partition([dict(r, group='same') for r in data], 42)

    def test_jsonl_contract_and_completion_mask(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root / 'base')
            from transformers import AutoTokenizer
            tokenizer = AutoTokenizer.from_pretrained(root / 'base', local_files_only=True)
            from holdout import llm_exclusions, reject_overlap, prompt_keys, validate_encoded
            training = [{'prompt': 'user: 0 assistant: ', 'completion': 'answer 0'}]
            evidence = llm_exclusions(training, [recipe.tokenize(training[0], tokenizer, 64)])
            with self.assertRaisesRegex(ValueError, 'overlaps'):
                reject_overlap([prompt_keys({'prompt': 'USER:  0 ASSISTANT: ', 'completion': 'changed'})], evidence)
            # Distinct raw text can collapse to the same unknown-token prompt.
            aliases = [{'prompt': f'user: {word} assistant: ', 'completion': 'answer 1'} for word in ['unknown-first', 'unknown-second']]
            with self.assertRaisesRegex(ValueError, 'tokenized'):
                validate_encoded([recipe.tokenize(row, tokenizer, 64) for row in aliases], evidence)
            with self.assertRaisesRegex(ValueError, 'overlaps tokenized'):
                validate_encoded([recipe.tokenize(training[0], tokenizer, 64)], evidence)
            validate_encoded([recipe.tokenize({'prompt': 'user: 70 assistant: ', 'completion': 'answer 70'}, tokenizer, 64)], evidence)
            for name in ['prompt', 'messages']:
                data, _ = recipe.rows(root / (name + '.jsonl'))
                encoded = recipe.tokenize(data[0], tokenizer, 64)
                self.assertEqual(encoded['labels'][0], -100)
                self.assertEqual(encoded['labels'][-1], tokenizer.eos_token_id)
                self.assertGreater(sum(i != -100 for i in encoded['labels']), 1)
                with self.assertRaisesRegex(ValueError, 'exceeding'):
                    recipe.tokenize(data[0], tokenizer, 2)
            invalid = root / 'invalid.jsonl'
            invalid.write_text('\n'.join(json.dumps({'messages': [{'role': 'assistant', 'content': 'no'}, {'role': 'user', 'content': 'answer'}]}) for _ in range(30)))
            with self.assertRaisesRegex(ValueError, 'alternate'):
                recipe.rows(invalid)
            invalid.write_text('\n'.join(json.dumps({'prompt': 'x', 'completion': 'y', 'command': 'bad'}) for _ in range(30)))
            with self.assertRaisesRegex(ValueError, 'fields'):
                recipe.rows(invalid)
            job = root / 'job'; job.mkdir()
            recipe.snapshot_model(job, root / 'base', root)
            snapshot = json.loads((job / 'model.json').read_text())
            frozen = root / 'models' / snapshot['hash']
            recipe.verify_model(frozen, snapshot)
            config = frozen / 'config.json'; config.chmod(0o600); config.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'contents changed'):
                recipe.verify_model(frozen, snapshot)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'fixture':
        fixture(sys.argv[2])
    else:
        unittest.main()
