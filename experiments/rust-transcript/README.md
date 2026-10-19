# Rust transcript reader experiment

This Unix-only, dependency-free Rust helper tests one possible native boundary:
reverse scanning the authoritative JSONL log. Node retains authorization, file
validation, JSON parsing, preview limits, paging and cursor construction. It passes
an already-open read-only descriptor to Rust. Rust emits original byte records and
offsets over a pipe. The measurement includes spawning, IPC and termination.

Production continues to use the TypeScript reader. The comparative benchmark makes
an isolated source copy and injects this reader there; no environment flag changes
the installed application. Rust is not required to build, install or run Code Flow.

```sh
npm run test:rust
npm run benchmark:compare -- --baseline <commit-before-optimizations> --trials 7
```

Requires Cargo/Rust, Chrome, Node and the normal project dependencies. Build uses
`--release --locked`. The parity test covers multiple pages, step filters, Unicode,
large previews, malformed records, reconnect sequences and empty lines. This is an
experiment, not a supported native extension: it does not implement Windows handle
passing or a persistent helper pool. Its IPC adapter accumulates incomplete frames
and is not optimized for unusually large individual records.

Compare the **optimized TypeScript** and **Rust** columns to isolate the language
boundary. Comparing Rust only against the old full-replay application would wrongly
attribute the paging and UI architecture improvements to Rust. Results apply to
this integration and workload, not to Rust in general or a hypothetical full rewrite.
