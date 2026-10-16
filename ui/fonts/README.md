# Fonts

The UI's typefaces, latin subsets as variable WOFF2. `scripts/build-ui.mjs` inlines them into
`public/index.html`, so code-flow never fetches fonts from the network.

- `manrope-latin.woff2` — Manrope (weights 200–800), copyright The Manrope Project Authors
  (https://github.com/sharanda/manrope), under the SIL Open Font License 1.1 (`OFL-1.1.txt`).
- `roboto-mono-latin.woff2` — Roboto Mono (weights 100–700), copyright Google LLC, under the
  Apache License 2.0 (`Apache-2.0.txt`).
