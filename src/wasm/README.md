# src/wasm — reserved

This directory is reserved for **generated** WebAssembly deployables: the compiled `.wasm`
plus its wasm-bindgen JS glue, produced from the future hand-written crate at `src/rust/`
(e.g. `wasm-pack build --out-dir ../wasm`). Nothing here is ever hand-edited. App code must
not import these files directly — access goes through a hand-written seam module in
`src/js/` with a JS fallback. Artifacts are committed so the app runs from plain files with
no toolchain; `src/rust/target/` must be gitignored when the crate is created.
