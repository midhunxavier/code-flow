# Fonts

The UI's typeface, latin subsets as WOFF. `scripts/build-ui.mjs` inlines them into
`public/index.html`, so code-flow never fetches fonts from the network. Page headings use Georgia
and code uses the system monospace, so neither needs a file here.

- `inter-latin-400.woff`, `inter-latin-500.woff`, `inter-latin-600.woff` — Inter 4.0 (Regular,
  Medium, SemiBold), copyright The Inter Project Authors (https://github.com/rsms/inter), under the
  SIL Open Font License 1.1 (`OFL-1.1.txt`). Subset to latin with fontTools:

  ```bash
  pyftsubset Inter-Regular.otf --flavor=woff --no-hinting --layout-features+=tnum,case,zero \
    --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+21B5,U+2212,U+2215,U+2318,U+2713,U+2715,U+2717,U+25B8,U+25BE,U+25CF,U+FEFF,U+FFFD" \
    --output-file=inter-latin-400.woff
  ```
