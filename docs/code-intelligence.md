# Symbol and reference inspection

Settings → Workspace → Code offers text search, simple multi-language declaration search,
and JavaScript/TypeScript symbols backed by TypeScript's language service.
Semantic symbol results include a **Find references** action. Imported aliases
are resolved; ordinary text mentions are not treated as references. Each request
uses saved repository files, so unsaved editor drafts are excluded.

Language-service computation runs in a separate worker with a 10-second deadline and a
192 MiB heap ceiling, and only one inspection runs at once. The in-memory file
host contains at most 500 regular source files and 8 MiB of source. Results stop
at 200 locations and explicitly report truncation. Credential selections,
symbolic links, external libraries, compiler plugins and generated directories
are excluded. Repository compiler configuration is not executed or loaded; the
initial implementation uses a fixed safe compiler configuration and relative
module resolution. Project-specific path aliases may therefore be unresolved.

The API supports `GET /api/v1/workspace/search?repo=...&mode=semantic&q=...`
and `GET /api/v1/workspace/references?repo=...&path=...&line=...&column=...`.
Locations are one-based and columns use UTF-16 code units, matching the language
service. Results include the actual language-service version and scope limits.

Unit fixtures check imported aliases, string-mention exclusions, current-content
refresh, symlink/credential/plugin boundaries and cancellation. Browser acceptance
exercises symbol search and cross-file reference navigation against saved JavaScript.
