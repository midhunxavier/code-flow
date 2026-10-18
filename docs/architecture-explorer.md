# Architecture exploration

Workspace → Dependencies inspects saved tracked source without executing repository code, build hooks, compilers or package managers. It resolves JavaScript/TypeScript syntax with TypeScript's parser, including literal dynamic imports and CommonJS requires. Conservative static scans also cover Python imports, Go import groups and local module packages, Rust modules and basic use declarations, and Java class imports.

The view includes file relationships, directory coupling, dependency cycles, declared npm/Python/Go/Rust/Maven packages, unresolved imports and computed runtime targets. Export the same evidence as JSON. An unresolved import may be an external or standard library package; it is not evidence that a dependency is missing. Runtime loaders, path aliases, Rust macros, Java wildcards, generated source and conditional builds still need manual inspection. No package installation or dependency-tree network lookup occurs.

The scan considers at most 600 tracked files and 8 MiB of readable source, with 4,000 relationships, 1,000 manifest dependencies, 500 unresolved imports and 200 computed targets. Truncation is visible. Existing symlink and regular-text file checks apply, and credential paths and dependency/build directories are excluded. Untracked and unsaved editor drafts are excluded. Cancellation stops the scan.

The import rules follow the [Python import system](https://docs.python.org/3/reference/import.html), [Go import declarations](https://go.dev/ref/spec#Import_declarations), and [Rust use declarations](https://doc.rust-lang.org/reference/items/use-declarations.html); these static scans do not reproduce every language's runtime resolution.
