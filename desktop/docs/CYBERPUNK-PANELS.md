# Cyberpunk panels refinement

Baseline: `1039b386ea90d5e04f52352925779c40c43fa11f`, verified against the remote branch before editing.

This second presentation pass adds visual hierarchy to the existing scout workbench and common panels. Production changes are CSS only:

- Task cards have distinct hover, keyboard focus and selected treatments. Existing status labels retain their text and gain consistent queued/running/completed/error/interrupted/cancelling colors.
- Scout creation, detail, usage, output and tool activity have separate surface levels. No invented progress bars, new controls or task operations are introduced.
- Context metrics, threshold marker, configuration cards and history use cyan/magenta accents. MCP connected/auth/error states and code-review selected controls follow the same palette.
- Disabled controls, wrapping, scroll containers and reduced-motion behavior are preserved; forced-colors selected outlines are included.

## Validation status

Cloud: TypeScript/Vite build passed, JavaScript tests passed 24/24, browser script syntax check and git diff check passed. The existing Vite large-chunk warning remains. The cloud Chromium socket restriction remains. Independent Windows validation subsequently passed: JavaScript 24/24, Rust 29/29, native WebView2 UI 29 checks, browser fixture at both viewport sizes, and visual review including workbench scrolling.

The browser fixture now covers six scout task states, keyboard selection, completed filtering, tool disclosure and quoting into the composer, plus context history and MCP cards, at 1440×960 and 1050×760. These are deterministic test data, not a native bridge test. Run `tests/theme-ui.mjs` against Vite on port 5178 as in CYBERPUNK-THEME.md, then inspect the additional `agents`, `agents-failed`, `context` and `mcp` screenshots.

Windows validation included nested scrolling in the scout workbench at 1050×760, selected/keyboard focus, error text, and unchanged IME/completion handling. One concurrent test run timed out waiting for focus; the serialized rerun passed. Run native and browser UI suites serially to avoid competing for focus. The passing serialized run does not establish concurrency safety.

The three validated source files were independently matched between Windows and cloud with SHA-256:

- `src/cyberpunk.css`: `10de3ed7efe75608379c9ef10dc67dcae64476ecf10460b8106ff3a5bba735f5`
- `tests/theme-ui.mjs`: `a1ff7219cb81b70d6de2d13ec36096b0edfaf91093e331d03643328a7dcce91c`
- `tests/theme.test.mjs`: `792e85c16c2641a4e0d86cf661a0f02917cd7d8abe9d95963dcd1cbf0a379a8d`
