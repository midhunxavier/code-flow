#!/usr/bin/env node
// Local-only extension of the shared fake gh: bounded picker search and argv evidence.
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2), flag = key => args[args.indexOf(key) + 1];
if (process.env.FAKE_GH_ARGV) appendFileSync(process.env.FAKE_GH_ARGV, JSON.stringify(args) + '\n');
const data = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
if (!data.signedOut && !data.failAll && ['issue', 'pr'].includes(args[0]) && args[1] === 'list' && args.includes('--search')) {
  const words = flag('--search').toLowerCase().split(/\s+/).filter(Boolean);
  const all = args[0] === 'issue' ? data.issues : Object.values(data.prs);
  const selected = all.filter(item => (item.state ?? 'OPEN') === 'OPEN' && words.every(word => `${item.title} ${(item.labels ?? []).map(label => typeof label === 'string' ? label : label.name).join(' ')}`.toLowerCase().includes(word)));
  process.stdout.write(JSON.stringify(selected.slice(0, Number(flag('--limit')))) + '\n');
} else if (!data.signedOut && !data.failAll && args[0] === 'issue' && args[1] === 'view' && flag('--json')?.split(',').includes('state')) {
  const issue = data.issues.find(item => item.number === Number(args[2]));
  if (!issue) { process.stderr.write('Issue not found\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: 'OPEN', ...issue }) + '\n');
} else await import('./fake-gh.mjs');
