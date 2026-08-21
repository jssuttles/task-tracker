# CLAUDE.md

Guidance for working in this repository. Read this before making changes.

## What this is

**Task Tracker** — an ultra-lightweight Windows system-tray utility that prompts
you every hour during your workday to log what you're doing: add upcoming tasks,
move in-progress ones to done, and jot notes. At work start it shows the day's
list prominently; at work end it asks for the final update and tomorrow's plan.

**The vault is the product.** Everything is stored as plain Markdown, one file
per day, in a folder you can point an AI agent at. The app is a pleasant way to
fill that folder; the folder is what answers "what did I do this year?" and
"what has my report been up to?" in December.

**Stack (deliberate):** Tauri v2 + Vanilla TypeScript + Vite. **No React, no UI
framework** — the app runs all day, so idle memory matters. Do not introduce a
framework.

## The quality bar (definition of done)

A change is **not done** until all of the following are true. Do not report
something as finished or "working" unless you have run these and seen them pass.

1. **`pnpm run check` passes** — format, lint (type-aware), `tsc --noEmit`, and
   the unit tests.
2. **`pnpm run build` passes** — a green lint/test run does **not** prove the app
   bundles. Check both.
3. **New logic has a unit test.** Pure logic lives in `src/lib/*.ts` and must be
   tested in a sibling `*.test.ts`. Bugs get a regression test.
4. **`pnpm run e2e` passes** — the app actually runs. Unit tests prove the logic;
   only this proves the controller finds its elements and that clicks reach the
   model. A blank-window regression passes every other gate. Invoke the
   `verify-app` skill, and **look at `docs/screenshots/`** — a capture once
   silently showed the wrong prompt, which no assertion had caught.
   If _every_ spec fails in ~3ms, that is a missing browser, not your change:
   Playwright wants a version the image doesn't ship. Point it at the one that
   is there — `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-<ver>/chrome-linux/chrome`
   (`ls /opt/pw-browsers` for the version). Never run Playwright's browser
   installer here, under either `pnpm exec` or `npx` — it fails on the network
   after several wasted minutes.
5. **Rust changes pass the Rust gate.** In `src-tauri`: `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo check`, `cargo test`.
   All four run in CI, and all four work in this sandbox once the GTK/WebKit dev
   packages are installed — so run them, don't defer to CI.
6. **Vault format changes round-trip and preserve hand edits.** The day file is
   the only copy of that data. `parseDay(serializeDay(doc))` must equal `doc`,
   and content the app doesn't own must survive a write untouched.
7. **Adversarial self-review before declaring victory.** Re-read your own diff
   hunting for the bug that breaks the _app_, not the lint nit. The CSP/stylesheet
   trap below is a real example that passes every automated gate.
8. **If the change moves something across the MVP line, re-read `README.md`.**
   Nothing fails when it drifts, so it drifts silently and always in the same
   direction — claiming shipped work doesn't exist. It once told readers there
   was no settings UI and to hand-edit `settings.json`, months after the panel
   shipped with e2e coverage. Check the Status section, the feature it describes,
   and the tray-menu list against the menu actually built in `src-tauri/src/lib.rs`.
   Test counts in prose go stale the same way; either update them or don't cite
   them.

### Verify, don't assume

- **Never trust training-cutoff memory for versions or API surfaces.** Check the
  live registry (`npm view <pkg> version`), installed type defs, and release
  pages for GitHub Actions before pinning or calling anything.
- **Newest is not always correct — check peer ranges.** TypeScript is pinned to
  `~6.0.3` even though 7.x is released, because `typescript-eslint` declares
  `typescript: ">=4.8.4 <6.1.0"`. Bumping past that silently disables type-aware
  linting rather than failing loudly. Re-check that peer range before raising it.
- **Distinguish "reviewed-correct" from "verified-running."** Say which one you
  mean. Don't claim a desktop behavior works if you only reasoned about it.

## Architecture

```
src/
  main.ts               # CheckInController: scheduler tick, serialized vault writes, settings panel
  styles.css            # Transparent window; top-left slide-in check-in card + settings overlay
  lib/
    dates.ts(.test)      # Local-date/clock helpers, ISO week math
    time.ts              # Millisecond constants
    tasks.ts(.test)      # Task model, status cycle, carry-over
    schedule.ts(.test)   # Slot-based check-in scheduler (the heart of the app)
    settings.ts(.test)   # Settings model, defensive parsing, panel draft + validation
    vault.ts(.test)      # VaultPort seam, day load/save, MemoryVault fake
    errors.ts(.test)     # describeError() for native dialogs
    tauri.ts             # Optional native bridge; degrades gracefully in a browser
    markdown/
      frontmatter.ts(.test)  # Tiny scalar-only YAML frontmatter reader/writer
      day.ts(.test)          # The day file: parse/serialize, preserves hand edits
      mentions.ts(.test)     # @person / #tag extraction
      rollup.ts(.test)       # Standup summary + weekly rollup
      context-doc.ts         # CONTEXT.md — the schema guide for agents
src-tauri/
  src/lib.rs            # Tray, window, top-left positioning, attention request
  src/vault.rs          # Vault file I/O (atomic writes) + settings persistence
  src/main.rs           # Binary entry point
  tauri.conf.json       # Transparent, alwaysOnTop, skipTaskbar, hidden-until-needed
  capabilities/         # Least-privilege permission set
e2e/
  harness.ts            # startApp(): frozen clock + seeded localStorage vault
  checkin.spec.ts       # The check-in loop, driven in a real browser
  settings.spec.ts      # The settings panel: validation, persistence, live effect
  capture.spec.ts       # Screenshots into docs/screenshots/
scripts/
  backfill-provenance.ts(.test)  # One-shot: reconstruct task `added` dates in a
                                 # pre-v2 vault. NOT app code — see below.
docs/
  future-work.md        # Everything planned, with the MVP line
  screenshots/          # Regenerated by `pnpm run e2e -- capture`
.claude/skills/
  verify-app/           # How to run and look at the app
```

### Key design decisions (don't regress these)

- **Slots, not intervals.** `schedule.ts` derives check-in _slots_ from the work
  window and asks "which slot is current, and was it handled?". A
  `setInterval(HOUR)` breaks on sleep/wake — close the lid at 11:55, reopen at
  15:30, and you either get nothing or four stacked prompts. Slots collapse a
  missed stretch to exactly one prompt and make a mid-day launch correct
  immediately. Never replace this with a plain timer.
- **The first check-in of a day is always a `day-start`, whatever the hour.**
  `currentSlot` picks a kind from the clock; `dueCheckIn` upgrades an `hourly`
  slot to `day-start` when nothing has been handled that date yet. Otherwise
  booting at 11:30 — machine off at 09:00, or a late start — serves a routine
  nudge and the user never sees their day or what carried over. The upgrade keeps
  the _current_ slot's key, so finishing it doesn't leave 11:00 outstanding.
- **The working week is a list, not a weekend flag.** `settings.workDays` holds
  `Date.getDay()` numbers, because "the weekend" is Friday/Saturday in much of
  the world and plenty of people work four days or Tuesday-to-Saturday. Parsing
  still understands the superseded `includeWeekends` boolean.
- **The copy has to know about the weekend too, not just the scheduler.** The
  wrap-up asks you to plan `describeNextWorkingDay(…)` — "tomorrow" midweek,
  "Monday" on a Friday. Asked on a Friday to "plan tomorrow" you either plan a
  Saturday you won't work or you ignore the prompt, and the point of the day-end
  check-in is that the next working morning opens with a list already on it.
- **"The end of the week" is the longest gap in `workDays`, not an ISO
  boundary.** `endsWorkingWeek` is what upgrades the headline to "Wrapping up the
  week". Comparing ISO weeks gets a Sunday-to-Thursday week exactly backwards
  (Thursday and the following Sunday share an ISO week, so the label lands on the
  day the week _starts_), and "the next working day isn't tomorrow" fires every
  Tuesday for someone who takes Wednesdays off. The longest gap is right for all
  four shapes.
- **Weekly rollups are derived and self-healing.** They refresh on every check-in
  and, on the first check-in of a new week, rebuild the previous week too. Written
  only at `day-end`, a week whose last working day never got a wrap-up produced no
  rollup at all — and the rollups are what make a year of day files reviewable.
- **Scheduler state is persisted in the day file, not in memory.** The handled
  slot is written as `last_check_in` in frontmatter and restored on launch. The
  app must survive reboots, Windows updates and its own crashes mid-workday;
  without this it relaunches believing nothing was handled and re-prompts for a
  check-in the user already completed. A snooze is deliberately _not_ restored.
- **The clipboard briefing carries its own schema; `CONTEXT.md` does not travel.**
  `agentWeekBriefing` prepends the notation key to the weekly rollup because it
  is pasted into a chat with an agent that will never see the vault. That is also
  why it returns `null` for an empty week rather than a body of "Nothing" bullets
  — those read as authoritative and say nothing. Don't collapse it into
  `weeklyRollup`, whose output lands _in_ the folder next to the guide.
- **The Markdown is the source of truth.** Not a cache, not an export. If a
  SQLite index is ever added it must be _derived_ and rebuildable — never written
  before the Markdown. See `docs/future-work.md`.
- **Hand edits survive.** `parseDay`/`serializeDay` preserve unowned sections and
  frontmatter keys verbatim. You or an agent may edit a day file directly, and
  the next app write must not eat it.
- **A task keeps the date it first appeared; the suffix is written only when it
  outlives that day.** `_(added YYYY-MM-DD)_` on a day-file task means "this
  predates this file", so its presence _is_ the carried-over marker and a day of
  fresh work stays unannotated. The file's own date is when an `[x]` finished, so
  one line yields start, finish and duration — the one fact about a task that was
  otherwise unrecoverable except by diffing consecutive files and matching on
  title. `carriedOver` used to be a flag set at carry-over time and was silently
  lost on every restart; it is now derived by `isCarriedOver`. Don't reintroduce
  a stored flag, and don't switch to the team file's unlabelled `_(date)_` — the
  two files share a folder, and there the bare date means _completed_.
- **`format` is stamped when the app _creates_ a day file, never when it edits
  one.** The absence of `_(added …)_` is a positive claim ("started here") in a
  v2 file and means nothing in a v1 one, and that difference is invisible without
  the version. Upgrading a legacy file in place would manufacture provenance for
  tasks that predate the field — so `createDay` sets `DAY_FORMAT_VERSION` and
  `parseDay`/`serializeDay` preserve whatever was already there, including a
  version newer than this build understands. Version 1 is the _absence_ of the
  key; never write `format: 1`. Bump the constant when the meaning of existing
  syntax changes, not when something is merely added.
- **A vault migration is a script, not a startup path.** `scripts/` is outside
  the app for a reason: the app touches one file at a time and has no evidence
  about what preceded it, whereas a migration reads the whole vault, derives
  each value from the file it can actually be observed in, backs everything up
  and shows a diff a human approves. Don't move that work into launch. The
  backfill also groups task titles with its own `normalize`, which must stay in
  step with `sameTask` — two spellings of one task would otherwise be dated as
  two separate runs.
- **A review surface for a destructive operation is load-bearing code — test it
  against a known-good case.** The backfill's first diff renderer aligned by line
  index, so inserting one frontmatter key reported every following line as
  changed and made a _preserved_ note look deleted. It nearly got reported as
  data loss in the tool's own output. A human approving a rewrite of the only
  copy of their notes can only be as careful as the diff lets them be, so a
  renderer that cries wolf is worse than none — it trains them to click through.
  It uses an LCS diff now, under a plain-language summary of what each task's
  derived span actually is.
- **Writes are atomic and serialized.** Rust writes to a temp file and renames
  (a day file is the only copy of that day's notes); `main.ts` chains every save
  through `this.writes` so concurrent edits can't interleave.
- **The check-in window takes focus.** Unlike the sibling calendar overlay, this
  one is typed into — so it is _not_ click-through, and it deliberately occupies
  the **top-left** corner, because bottom-right belongs to
  noticeable-calendar-alert. Two utilities in one corner means ignoring both.
- **Settings are an overlay in the one window, not a second window.** A second
  Tauri window would need its own capability set and its own positioning, and
  would surface in the taskbar this app skips. The panel is a sibling of the
  card, so it can paint alone when opened from the tray with nothing due — and
  it marks the card `inert` while open, because `aria-modal` doesn't stop Tab
  from reaching an input hidden behind the overlay.
- **The scheduler does not prompt over the settings panel.** `tick()` returns
  early while it is open. Slots coalesce, so the check-in is served as soon as
  the panel closes rather than being lost.
- **The form validates; the file falls back.** `parseSettings` silently repairs
  a corrupt `settings.json` so the app always starts. `validateDraft` does the
  opposite — it reports, because a settings panel that silently reverts what you
  typed teaches you nothing. Don't collapse the two.
- **`settings.json` is written before the in-memory settings change**, so a
  failed write leaves the running app on the values actually on disk. Launch-at-
  login is OS state applied after, and its failure doesn't undo the save.
- **The frontend must run framework-free in a plain browser too.** Every native
  call in `tauri.ts` is guarded by `isTauri()` and degrades to a no-op or a
  browser equivalent (the vault falls back to `localStorage`). This keeps
  `pnpm run dev` a fast iteration loop with no Rust build.
- **Link the stylesheet from `index.html`; never `import './styles.css'`.** A JS
  CSS import injects a `<style>` tag in dev, which the app's `style-src 'self'`
  CSP blocks. That breaks only in the desktop webview — never in lint, tests, or
  a browser `pnpm run dev`.
- **The settings panel reserves its scrollbar gutter on both edges.** A scrollbar
  drawn inside the panel's right-hand padding steals it from the content, so the
  fields sit ~11px closer to the left edge than the right and the panel reads as
  misaligned. `scrollbar-gutter: stable both-edges` keeps it symmetric whether or
  not it scrolls — which matters because whether it scrolls depends on how tall
  the platform paints `type="time"`, and Chromium is not the platform that ships.
- **Giving an element a `display` also overrides `[hidden]`.** `.settings` is a
  flex column, so it needs an explicit `.settings[hidden] { display: none }` —
  without it the panel is on screen permanently, covering the card, and the app
  looks dead on launch. Any new `hidden` element with a `display` rule needs the
  same line.
- **Filenames are validated in Rust.** `is_safe_name` in `src-tauri/src/vault.rs`
  is the security boundary; the TypeScript `isSafeVaultName` is an early-failure
  convenience. Keep both in sync, and never widen the Rust one to a general path.
- **Security: vault content is untrusted.** Task titles and notes round-trip
  through files other tools can write, so they are rendered with `textContent`,
  never `innerHTML`.
- **Tauri permissions need a _scope_, not just the permission.** A bare
  capability string enables the command but leaves its allowlist empty, so every
  call is denied at runtime — and only on a real desktop run, never in
  lint/tests/`pnpm run dev`. Plugins that take a scope (opener, fs, http) must
  list their allowed targets in `capabilities/default.json`. This app avoids the
  problem by doing file and opener work in app-defined Rust commands, which
  don't pass through the capability system in v2.
- **Surface native-side failures in a dialog, not `console.error`.** Check-ins
  fire from a timer while the window is hidden, so console logs and a webview
  `alert()` are invisible. Route user-facing errors through `showError()`.
- **Motion is GPU-only.** Animate `transform`/`opacity` exclusively; never
  animate layout properties. Respect `prefers-reduced-motion`.

### Borrowed scars

`noticeable-calendar-alert` is the sibling project and paid for these already.
Each one is applied here; don't undo them.

- **Two icon masters.** Downscaling detailed art to 32px produces a smudge in the
  tray. `icon-small.svg` exists for ≤32px. Also: `.ico`/`.icns` must be listed in
  `bundle.icon` or Windows/macOS bundling fails, and `tauri icon` overwrites the
  hand-tuned sizes every time it runs. See `src-tauri/icons/README.md`.
- **A status line refreshed only on events is a stale snapshot.** The tray text
  re-renders on the scheduler tick and pushes only when it changed.
- **A flag set after an `await` is not a guard.** `presenting` is raised
  synchronously before the vault read, because `visible` is set after it — the
  sibling shipped a double-present race of exactly this shape.
- **Size the window to its content.** Theirs was 420×600 with content in the
  bottom 250px; ours is 420×470 for the same reason.
- **Don't assume an input is sorted.** Their `selectNextEvent` relied on
  ascending order that no signature promised. Ours re-derive order themselves.

## Commands

**The package manager is pnpm**, pinned by `packageManager` in `package.json`.
On a fresh container it may not be on PATH; `corepack enable && corepack prepare
pnpm@<pinned> --activate` installs exactly the pinned version. Don't reintroduce
`npm install` — it would write a `package-lock.json` alongside `pnpm-lock.yaml`
and the two would drift silently. (`npm view` is fine; that's a registry query,
not a project command.)

Build scripts are blocked by default from pnpm 10 on, and every skipped one is
reported at the end of an install. `pnpm-workspace.yaml` records the decision
per package under `allowBuilds` so the expected skips are silent and a genuinely
new one stands out. `pnpm approve-builds <pkg>` / `'!<pkg>'` writes that file for
you, which beats guessing the key by hand.

| Command                 | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `pnpm install`          | Install deps + git hooks (`prepare` → lefthook) |
| `pnpm run dev`          | Browser-only preview of the card (no Rust)      |
| `pnpm run tauri dev`    | Full desktop app (needs Rust + Tauri prereqs)   |
| `pnpm run check`        | format + lint + typecheck + test (the web gate) |
| `pnpm run build`        | `tsc --noEmit` + `vite build`                   |
| `pnpm run test:watch`   | Vitest in watch mode                            |
| `pnpm run tauri icon X` | Regenerate the platform icon set from `X.png`   |

Run a one-shot script with Node's own type stripping — there is no bundler step
for `scripts/`, and no `tsx` dependency:

```bash
node --experimental-strip-types scripts/backfill-provenance.ts <vault-dir>
```

`scripts/` is inside `tsconfig`, eslint and vitest, so a script and its tests
are held to the same bar as `src/` and `pnpm run check` covers them.

Git hooks (Lefthook) auto-run eslint `--fix`, prettier, and project `tsc` on
staged files at commit time.

## TypeScript conventions

- `verbatimModuleSyntax` is on → use `import type { … }` for type-only imports.
- Imports use explicit `.ts` extensions (`./lib/vault.ts`); Vite resolves them.
- `@typescript-eslint/no-floating-promises` is an error → `void` deliberate
  fire-and-forget promises.
- Unused args/vars must be `_`-prefixed.
- The config is strict (`strict`, `noUnusedLocals/Parameters`,
  `noImplicitReturns`, `noImplicitOverride`). Don't loosen it to dodge an error.
- `restrict-template-expressions` is on: wrap numbers in `String(…)` inside
  template literals rather than relying on implicit coercion.

## What CANNOT be verified in the agent sandbox

The Rust **does** compile here: `cargo check`, `cargo test`, `cargo clippy
--all-targets -- -D warnings` and `cargo fmt --check` all pass, and `Cargo.lock`
is committed (CI runs `--locked`). Run them before pushing Rust changes rather
than waiting for CI.

**A fresh container does not have the system libraries yet**, and the failure
does not say so — `cargo check` reports `The system library gdk-3.0 required by
crate gdk-sys was not found`, which reads like the crate is broken. Two
commands, in this order:

```bash
apt-get update    # REQUIRED FIRST — a stale index 404s on every package below,
                  # which looks like they don't exist rather than like a cache miss
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev pkg-config
```

Then all four gates run (~90s for the first `cargo check`; seconds after that).
Verified in this sandbox. Don't conclude from the first error that Rust can only
be checked in CI, and don't report the Rust gate as passing without running it.

What this environment lacks is a **desktop webview and a Windows machine**, so
the following are _reviewed for correctness but never executed_. Verify each on
real hardware before trusting it. The full list lives in `docs/future-work.md`
under "Known unknowns"; the headlines:

- **Windows foreground activation.** `SetForegroundWindow` is refused for a
  process that hasn't received recent user input — exactly a timer firing at
  14:00. `show()` + `set_focus()` + `request_user_attention()` is the mitigation,
  but whether the card lands _focused and ready to type_ is the most important
  thing to test on-device.
- **The transparent, always-on-top, `skipTaskbar` window** behaving as configured
  on Windows 11, including top-left placement on a multi-monitor, mixed-DPI setup.
- **Tray icon + menu** rendering, and each item's event reaching the webview.
- **The autostart plugin** registering at login, and clipboard writes from a
  hidden window.

When you touch any of the above, say explicitly in your summary that it is
reviewed-but-unrun, and list what the user must check on-device.
