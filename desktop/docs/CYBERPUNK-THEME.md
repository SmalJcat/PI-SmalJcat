# Cyberpunk presentation pass

Baseline: `31bb23d9580f9435f90d9de8bbbec5a80dee1dd6` on `fix/composer-keyboard-completions`.

The existing conversation, sidebars, completion menu, settings, review and workspace panels now share a dark graphite/blue palette. Cyan marks selection and focus; magenta is restrained to secondary accents. Translucent surfaces use solid dark fallbacks. Native window transparency is not enabled. No background image, network asset, new feature, RPC operation or input handler is introduced.

Existing CSS uses shared semantic text/surface tokens. `src/cyberpunk.css` supplies the palette and visual treatments. Layout widths, scroll containers, keyboard handlers, IME guards and Tauri hit targets remain unchanged. Reduced-motion behavior is retained; reduced-transparency and forced-colors treatments are supplied.

## Validation

Cloud checks: `npm run build` passed (TypeScript and Vite); `npm test` passed 23 tests, including text-token WCAG AA contrast checks. Vite retains its existing >500 kB JavaScript chunk warning. Independent Windows validation passed: 29 Rust tests, 29 real WebView2 UI checks, and 23 JavaScript tests. Native packaging is a separate publication step.

Browser test added: `tests/theme-ui.mjs` uses a deterministic Pi bridge fixture and real application rendering. It checks two viewport sizes, command/file candidates, IME Enter, Shift+Enter, Escape, repeated sidebar toggles, settings close and conversation rendering. The cloud Chromium runtime cannot start due to `socket() failed: Operation not permitted`; the browser fixture was subsequently run successfully on Windows at 1440px and 1050px, including IME and completion interactions. The test script SHA-256 was independently matched between Windows and cloud: `9092cfc953f8bfba6ccc8277e8573a29b6eff04c63df56a62f95b26f433b819e`.

## Windows validation and publication workflow

1. Verify the local branch is still at the baseline above and preserve any uncommitted work.
2. Apply the supplied patch only after `git apply --check` succeeds.
3. Run `npm run build` and `npm test` in `desktop`.
4. Start `npm run dev:web -- --host 127.0.0.1 --port 5178 --strictPort` in another terminal. Run `node tests/theme-ui.mjs`. The test discovers installed Edge/Chrome on Windows; `CHROMIUM_PATH` can explicitly select an installed browser. `PI_THEME_URL` can change the local test URL.
5. Inspect `artifacts/theme/*.png`, especially completion menus and settings at 1050px. They are fixture screenshots, not evidence of native bridge behavior.
6. Run `npm run test:ui` using the existing native Windows harness. Inspect actual WebView2 rendering and ensure scrolling, focus rings, command/file completion, Chinese IME, dialogs and sidebar controls remain usable.
7. Only after validation, build/stage the native package through `npm run package`, verify the resulting executable hash and publish/sync under the user's standing workflow.

The Linux cloud bundle is source and web assets, not a Windows executable.
