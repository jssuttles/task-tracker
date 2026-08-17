# Future work

Everything we want built, in one place. The **MVP line** divides what has to
work before this is worth using daily from what can come later.

Items above the line are the definition of "v0.1 is done". Items below are
ordered roughly by value, not by sequence — pull from them as they become the
thing standing between you and using the app.

Status keys: **done** · **partial** · **todo**

---

## Above the MVP line

These ship in v0.1. The app is not usable without them.

### The check-in loop

| Status | Item                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | Slot-based scheduler: day-start, hourly, day-end; coalesces missed slots after sleep.                                                                     |
| done   | Prompt repeats until dismissed or submitted; Snooze defers by a configurable interval.                                                                    |
| done   | Work start / end times, configurable working days (`workDays`), hourly nudges toggleable.                                                                 |
| done   | Card slides in from the **top-left** (bottom-right belongs to the calendar alert).                                                                        |
| done   | Keyboard-first: type a task, Enter to add; Esc snoozes.                                                                                                   |
| done   | Survives a restart: the handled slot is recorded in the day file and restored on launch, so a reboot doesn't re-prompt for a completed check-in.          |
| done   | The first check-in of a day is always the day-start prompt, whatever the hour — a late start or a machine that was off at 09:00 still gets shown the day. |
| todo   | **Verify the window actually takes focus on Windows.** See "Known unknowns" below.                                                                        |

### The vault

| Status | Item                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| done   | One Markdown file per day, frontmatter + `## Tasks` + `## Notes`.                                                                      |
| done   | Hand edits survive: unowned sections and frontmatter keys are preserved verbatim.                                                      |
| done   | Atomic writes (temp file + rename) so a crash can't truncate a day's notes.                                                            |
| done   | Open tasks carry over to the next day, bounded by a 4-day horizon.                                                                     |
| done   | `CONTEXT.md` regenerated on launch so an agent can read the schema.                                                                    |
| done   | Inline `@person` and `#tag` parsing, with `#kudos` indexed for review season.                                                          |
| done   | Filename allowlist enforced in Rust — nothing escapes the vault directory.                                                             |
| done   | Task provenance: a carried task keeps the date it first appeared, so one line answers "how long was this open?" without diffing files. |

### Output

| Status | Item                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | Clipboard standup summary (yesterday done / today open / blockers).                                                                                              |
| done   | Weekly rollup `YYYY-Www.md`, refreshed on every check-in and self-healed on the first check-in of a new week, so a skipped Friday wrap-up doesn't lose the week. |

### Shell

| Status | Item                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | Tray icon and menu: status line, check in now, copy standup, open vault, settings, quit.                                                           |
| done   | Least-privilege capabilities — only the plugin commands JS invokes.                                                                                |
| done   | End-to-end suite driving the real card in a browser, plus screenshot capture and a `verify-app` skill.                                             |
| done   | Launch at login, toggled from the settings panel.                                                                                                  |
| done   | **A settings panel** — work window, working days, hourly nudges, snooze, launch at login, and the vault path (read-only). Tray item and card gear. |
| done   | App icons generated from the SVG master and committed (`generate_context!` embeds them at compile time).                                           |

---

# ═══════════ MVP LINE ═══════════

Everything below is post-v0.1.

## What this half is for

The vault is read by an agent, and the reports come out of the agent. That is
not a nice-to-have workflow on top of the app — it is the assumption everything
below is now sorted against, and it splits the old backlog cleanly in two.

**A feature whose job is to _read_ the vault is not worth building.** Search,
indexes, history browsers, charts, per-person quarterly summaries, a "draft my
review" button — an agent pointed at the folder does all of it, on demand, in
shapes we would never have anticipated, and it does not need us to have guessed
the question in advance. Building our own is a worse version of something the
user already has, that we then have to maintain. These are listed under **Ruled
out** below, with the reasoning, so they don't get re-proposed every six months.

**A feature whose job is to get true, complete, legible data _into_ the vault is
the entire product.** The agent's ceiling is the folder. It cannot report what
was never captured, and — worse — it cannot tell the difference between a quiet
week and an unlogged one. Silence reads as absence, confidently. So coverage and
fidelity are the whole roadmap now:

- **Coverage** — is there an entry for every working day, and is a gap a real
  gap? Missed wrap-ups, idle time, and PTO all manufacture false silence.
- **Fidelity** — does an entry carry enough to reconstruct what happened? A
  title with no dates and no note is a row in a table, not an account of a day.

---

## Fidelity: what the file can prove

- **Task provenance.** _(done — see above the line.)_ A task carries the day it
  first appeared once it outlives that day, so a single line yields start,
  finish and duration. This was the one fact in the vault that could not be
  recovered by reading it — only by diffing consecutive files and matching on
  title, which is exactly the reconstruction an agent does confidently and
  wrong.
- **Keep derived files out of the source path.** `YYYY-Www.md` and
  `YYYY-Www-team.md` are rebuilt from the day files on every check-in, but they
  sit in the same folder, so an agent aggregating a quarter reads both and
  double-counts every completed task. `CONTEXT.md` now labels them derived and
  says not to; a `rollups/` subfolder would make it structural instead of
  advisory. Deferred only because it moves files in vaults that already exist.
- **Prompt for substance, not just status.** The day-end step asks what
  happened; the hourly one mostly collects checkbox flips. A week of
  `[x] Fix the thing` lines is technically complete and produces a worthless
  report. Worth testing whether one well-placed "why did that take the
  afternoon?" earns its friction — this is the highest-leverage unknown left,
  and it is a copy question, not an engineering one.
- **Distinguish abandoned from finished.** Cycling a task past `completed`
  returns it to `upcoming`, and dropping it removes the line entirely. Neither
  records that it was dropped, so an agent sees work that evaporated. A fourth
  state, or a note on removal, would say so.

## Coverage: making silence mean something

- **Offer a missed day-end wrap-up the next morning.** Today a skipped Friday
  carries its open tasks forward and nothing else; the day never gets its
  account, and the weekly rollup heals _around_ the hole rather than filling it.
  The scheduler already upgrades a slot when nothing has been handled — the same
  seam can notice yesterday never closed.
- **Idle detection.** Don't count an hour spent away from the machine, and don't
  prompt into an empty room. Slots already collapse a missed stretch to one
  prompt; idle is what lets that stretch be recorded as _away_ rather than left
  ambiguous.
- **A holiday / PTO list.** `workDays` covers the recurring weekly pattern; a
  week of leave still reads as a week of missed logging, which is the exact
  false negative that makes an agent's summary wrong rather than incomplete.
- **Escalating presence when a check-in is ignored**, rather than one flash and
  silence.
- **Meeting awareness** — read the calendar and skip a nudge that would land
  mid-call. (The sibling `noticeable-calendar-alert` has a tested Google
  Calendar layer to borrow.) Knowing about the meeting is also capture: an hour
  in a call is an account of that hour.
- **Do-not-disturb / focus-mode respect.**

## Ruled out

Not "later" — **not ours**. Each of these is a read-side feature that an agent
with the folder already does better. Re-proposing one needs a reason that isn't
"it would be nice to see in the app".

| Item                                   | Why not                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Full-text search in the app            | The agent greps. A year is ~250 small files.                                                                                            |
| SQLite as a derived index              | Solves a query-latency problem we don't have, and adds a rebuild path, a schema version and a two-stores failure mode we'd have to own. |
| History browser, week-at-a-glance      | Both are "show me a period", which is a question, not a screen.                                                                         |
| Charts (completion rate, carry-over)   | Now computable from the vault directly — task provenance was the missing input. Ask for the chart; don't ship one.                      |
| Quarterly / annual rollups per person  | This is literally "generate a report". It is the agent's job description.                                                               |
| 1:1 prep from accumulated agenda items | A query over `team.<person>.md`, which already holds dated notes. Ask for it when the 1:1 is tomorrow.                                  |
| A "draft my review" command            | Same. The vault plus a prompt beats a button whose output we'd have to template.                                                        |

Two adjacent ideas survive, because they are about _access_ rather than
analysis:

- **An MCP server over the vault** (`search_notes`, `person_summary`,
  `week_rollup`). Not because the agent can't read Markdown — it can — but
  because tools make the answers cheaper and more precise than grepping, and it
  removes the "point Claude at this folder" setup step. Worth it only once the
  manual flow is proven; the folder is the interface until then.
- **Configurable vault path via a folder picker.** The Rust command
  (`vault_set_dir`) and the JS bridge exist and the panel shows the active path;
  what's missing is the picker, which needs the dialog plugin's `open`
  permission. Left out of the MVP panel rather than widening the capability set
  for a below-the-line feature.

## Storage (still open)

If a SQLite index is ever added despite the above, the rule is unchanged and
non-negotiable: **the Markdown stays authoritative**, the index is rebuildable
from it at any time, and if the two disagree you delete the index and re-derive
it. That turns the classic two-stores sync problem into a non-problem. It would
mean `tauri-plugin-sql`, a `rebuild_index()` that walks the vault, and a schema
version so a format change just triggers a rebuild. **Never** write to SQLite
without writing the Markdown first.

- Optional encryption at rest, if work notes ever warrant it. Note the tension:
  an agent has to be able to read the folder, so this trades the product's whole
  premise for confidentiality. Only worth it if the notes genuinely warrant it.

## The people pillar

`@person` and `#kudos` are parsed and indexed from the user's own day-file
notes, and manager mode builds on top of that with its own per-person storage:

| Status | Item                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | A settings toggle ("I manage people") that adds an end-of-day step for logging what a report is up to — see `Settings.managerModeEnabled`.                                                                                                         |
| done   | A per-person view: `team.<person>.md`, one running file per report — its own tasks and dated notes, separate from the user's day files.                                                                                                            |
| done   | The Team panel (tray, or the card icon): open/create a report by handle, cycle their tasks, add dated notes, browse the last few.                                                                                                                  |
| done   | A weekly rollup across every tracked report, `YYYY-Www-team.md`, refreshed the same way the personal weekly rollup is — plus a "Copy team week" clipboard briefing for an agent.                                                                   |
| done   | Roster-by-usage rather than a roster to maintain: a report's file is created the first time they're logged, from either the Team panel or an `@mention` in the day-end step.                                                                       |
| todo   | Handle aliasing, so `@alice` and `@alice.smith` resolve to one person rather than two team files. This is a _capture_ fix, not a reporting one — two files for one person is corrupt data, and an agent has no way to know they're the same human. |

1:1 prep and per-person quarterly rollups moved to **Ruled out** — both are
questions to ask of `team.<person>.md`, not screens to build.

## Task model

Title, status, and the date it first appeared. Candidates, each weighed against
the friction it adds to a prompt seen eight times a day — and now against a
second test: **does an agent reading the folder need this stated, or can it
infer it from the notes?** Grouping and priority it can infer. Elapsed time it
could not, which is why provenance got built and the rest of this list didn't.

- Projects or tags for grouping. `#tag` already exists in notes and costs
  nothing; a first-class field has to beat that.
- Estimates and actuals. Actuals are now largely derivable; estimates are not,
  and are the only half that would need typing.
- Subtasks.
- Due dates and a "what's overdue" view — the date half is real capture, the
  view half is Ruled out.
- Import from Jira / Linear / GitHub Issues — read-only first, as an adapter
  behind the existing `VaultPort` seam. This is capture: it's work that happened
  and isn't in the folder.

## Platform and release

- Taskbar-aware placement: respect the OS work area, not just the monitor bounds.
- Per-monitor DPI correctness for the card's size.
- A signed Windows installer and an auto-update channel.
- macOS and Linux support (the code is portable; only the tray and positioning
  have been reasoned about for Windows).
- Coverage thresholds in CI.

---

## Known unknowns

The Rust compiles and its tests pass — `cargo check`, `cargo test`, `cargo
clippy --all-targets -- -D warnings` and `cargo fmt --check` were all run
against this tree, and `Cargo.lock` is committed.

What was **never executed** is anything requiring a desktop webview or a Windows
machine. The list below is reviewed for correctness only; verify each on real
hardware before trusting it:

1. **Windows foreground activation.** `SetForegroundWindow` is refused for a
   process that hasn't received recent user input, which is exactly a timer
   firing at 14:00. `show()` + `set_focus()` + `request_user_attention()` is the
   documented mitigation, but whether the card reliably lands _focused and ready
   to type_ is the single most important thing to test on-device. If it doesn't,
   the fallback is a brief `always_on_top` toggle or an `AttachThreadInput`
   workaround in Rust.
2. **Transparency, `skipTaskbar` and always-on-top** behaving as configured on
   Windows 11, including on a multi-monitor setup with mixed DPI.
3. **Tray icon and menu** rendering, and each menu item's event reaching the
   webview.
4. **The autostart plugin** actually registering at login. The settings panel now
   toggles it, but `enable()`/`disable()` are no-ops in a browser, so the
   checkbox has only ever been driven against a stub.
5. **The tray's "Settings…" item** reaching the webview. The panel itself is
   covered end to end, but only via the card's gear — a browser has no tray, so
   the `open-settings` event and the hidden-window path it opens through are
   reviewed, not run.
6. **Clipboard writes** from a hidden window — the standup copy fires from the
   tray while the card may not be visible.
7. **The settings panel's native controls.** `input[type="time"]` is painted by
   the webview in the OS locale's format — 12-hour with a meridiem on a US
   machine, 24-hour elsewhere — and the field is sized for the wider of the two.
   Worth a look on a real Windows install, along with `color-scheme: dark`
   actually darkening the time picker's dropdown.
8. **The whole loop end to end** — a real workday of hourly prompts producing a
   day file you'd actually want to read back.
9. **The expand/collapse toggle's `setSize` call**, against a window configured
   `resizable: false`. Programmatic resize is expected to work regardless of
   that flag — it's a common pattern for splash-to-main-window transitions —
   but it's unverified against a real Windows compositor, and so is whether
   re-invoking `position_checkin` after the resize reliably keeps the window
   pinned to the same corner rather than a platform re-centering it.
