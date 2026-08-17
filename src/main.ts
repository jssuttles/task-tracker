/**
 * Application entry point.
 *
 * Two cadences, kept apart on purpose (the same split the sibling calendar-alert
 * project uses):
 *
 * - **The scheduler tick** is pure arithmetic on a one-minute timer. It decides
 *   whether a check-in is due and touches no disk.
 * - **Vault I/O** happens only in response to something real: a check-in coming
 *   due, or the user adding a task. Every write is serialized through a promise
 *   chain so two edits can never interleave and produce a half-written day file.
 *
 * The window is hidden except while a check-in is up. That's the entire UI
 * surface — everything else the app knows lives in the vault as Markdown.
 */

import { addDays, fromDateKey, startOfIsoWeek, toClock, toDateKey } from './lib/dates.ts';
import { describeError } from './lib/errors.ts';
import { addNote, type DayDocument } from './lib/markdown/day.ts';
import { CONTEXT_DOC, CONTEXT_FILENAME } from './lib/markdown/context-doc.ts';
import { extractPeople } from './lib/markdown/mentions.ts';
import {
  agentWeekBriefing,
  standupSummary,
  teamWeekBriefing,
  teamWeeklyRollup,
  teamWeekFileName,
  weeklyRollup,
  weekFileName,
} from './lib/markdown/rollup.ts';
import { addTeamNote, updateCompletedDates, type TeamMemberDocument } from './lib/markdown/team.ts';
import {
  describeCheckIn,
  describeNextWorkingDay,
  dueCheckIn,
  endsWorkingWeek,
  INITIAL_CHECK_IN_STATE,
  markHandled,
  onDemandSlot,
  restoreCheckInState,
  slotClock,
  snooze,
  SCHEDULER_TICK_MS,
  type CheckInSlot,
  type CheckInState,
} from './lib/schedule.ts';
import {
  applyDraft,
  DAY_LABELS,
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  toDraft,
  toggleWorkDay,
  validateDraft,
  type Settings,
  type SettingsDraft,
  type SettingsIssue,
} from './lib/settings.ts';
import {
  addTask,
  completedBeforeCheckIn,
  cycleStatus,
  isCarriedOver,
  removeTask,
  setTaskStatus,
  summarizeTasks,
  tasksForCheckIn,
  type Task,
} from './lib/tasks.ts';
import { formatTrayStatus } from './lib/tray.ts';
import {
  copyToClipboard,
  createVault,
  hideWindow,
  isAutostartEnabled,
  loadSettingsJson,
  onCheckInRequested,
  onOpenVaultRequested,
  onSettingsRequested,
  onStandupRequested,
  onTeamRequested,
  onTeamWeekRequested,
  onWeekRequested,
  openVaultFolder,
  saveSettingsJson,
  setAutostart,
  setTrayStatus,
  setWindowSize,
  showCheckIn,
  showError,
  showWindow,
  vaultPath,
} from './lib/tauri.ts';
import {
  isPersonHandle,
  listTeamPeople,
  openDay,
  openTeamMember,
  previousDayKey,
  listDayKeys,
  readDay,
  readDayRange,
  readTeamMember,
  writeDay,
  writeTeamMember,
  type VaultPort,
} from './lib/vault.ts';

/** How long a transient status message stays on the card. */
const STATUS_HOLD_MS = 2_400;

/** The window's footprint, matching `tauri.conf.json`. */
const COMPACT_SIZE = { width: 420, height: 470 };
/** More room for a long task list, a browsed-through Team panel, or a tight Settings panel. */
const EXPANDED_SIZE = { width: 420, height: 760 };

interface Elements {
  card: HTMLElement;
  headline: HTMLElement;
  subhead: HTMLElement;
  taskList: HTMLUListElement;
  emptyState: HTMLElement;
  taskForm: HTMLFormElement;
  taskInput: HTMLInputElement;
  noteForm: HTMLFormElement;
  noteInput: HTMLInputElement;
  teamDayEndForm: HTMLFormElement;
  teamDayEndInput: HTMLInputElement;
  done: HTMLButtonElement;
  snooze: HTMLButtonElement;
  copyStandup: HTMLButtonElement;
  copyWeek: HTMLButtonElement;
  expandToggle: HTMLButtonElement;
  status: HTMLElement;
  settings: SettingsElements;
  team: TeamElements;
}

interface SettingsElements {
  panel: HTMLElement;
  open: HTMLButtonElement;
  close: HTMLButtonElement;
  expandToggle: HTMLButtonElement;
  workStart: HTMLInputElement;
  workEnd: HTMLInputElement;
  workDays: HTMLElement;
  hourlyEnabled: HTMLInputElement;
  snoozeMinutes: HTMLInputElement;
  managerModeEnabled: HTMLInputElement;
  launchAtLogin: HTMLInputElement;
  vaultPath: HTMLElement;
  openVault: HTMLButtonElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
  error: HTMLElement;
}

/**
 * The Team panel's elements. A sibling overlay to Settings, reached the same
 * two ways (the icon on the card, the tray item) and always available — see
 * `Settings.managerModeEnabled` for why it isn't gated by that setting.
 */
interface TeamElements {
  open: HTMLButtonElement;
  panel: HTMLElement;
  close: HTMLButtonElement;
  expandToggle: HTMLButtonElement;
  personInput: HTMLInputElement;
  personLoad: HTMLButtonElement;
  personError: HTMLElement;
  peopleList: HTMLDataListElement;
  taskList: HTMLUListElement;
  emptyState: HTMLElement;
  taskForm: HTMLFormElement;
  taskInput: HTMLInputElement;
  noteForm: HTMLFormElement;
  noteInput: HTMLInputElement;
  notes: HTMLElement;
  copyWeek: HTMLButtonElement;
  status: HTMLElement;
}

/** Resolve a required element or fail loudly at startup. */
function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing required element #${id}`);
  return el as T;
}

function resolveElements(): Elements {
  return {
    card: mustGet('card'),
    headline: mustGet('headline'),
    subhead: mustGet('subhead'),
    taskList: mustGet<HTMLUListElement>('task-list'),
    emptyState: mustGet('empty-state'),
    taskForm: mustGet<HTMLFormElement>('task-form'),
    taskInput: mustGet<HTMLInputElement>('task-input'),
    noteForm: mustGet<HTMLFormElement>('note-form'),
    noteInput: mustGet<HTMLInputElement>('note-input'),
    teamDayEndForm: mustGet<HTMLFormElement>('team-day-end-form'),
    teamDayEndInput: mustGet<HTMLInputElement>('team-day-end-input'),
    done: mustGet<HTMLButtonElement>('done'),
    snooze: mustGet<HTMLButtonElement>('snooze'),
    copyStandup: mustGet<HTMLButtonElement>('copy-standup'),
    copyWeek: mustGet<HTMLButtonElement>('copy-week'),
    expandToggle: mustGet<HTMLButtonElement>('card-expand'),
    status: mustGet('status'),
    settings: {
      panel: mustGet('settings'),
      open: mustGet<HTMLButtonElement>('settings-open'),
      close: mustGet<HTMLButtonElement>('settings-close'),
      expandToggle: mustGet<HTMLButtonElement>('settings-expand'),
      workStart: mustGet<HTMLInputElement>('work-start'),
      workEnd: mustGet<HTMLInputElement>('work-end'),
      workDays: mustGet('work-days'),
      hourlyEnabled: mustGet<HTMLInputElement>('hourly-enabled'),
      snoozeMinutes: mustGet<HTMLInputElement>('snooze-minutes'),
      managerModeEnabled: mustGet<HTMLInputElement>('manager-mode-enabled'),
      launchAtLogin: mustGet<HTMLInputElement>('launch-at-login'),
      vaultPath: mustGet('vault-path'),
      openVault: mustGet<HTMLButtonElement>('open-vault'),
      save: mustGet<HTMLButtonElement>('settings-save'),
      cancel: mustGet<HTMLButtonElement>('settings-cancel'),
      error: mustGet('settings-error'),
    },
    team: {
      open: mustGet<HTMLButtonElement>('team-open'),
      panel: mustGet('team'),
      close: mustGet<HTMLButtonElement>('team-close'),
      expandToggle: mustGet<HTMLButtonElement>('team-expand'),
      personInput: mustGet<HTMLInputElement>('team-person-input'),
      personLoad: mustGet<HTMLButtonElement>('team-person-load'),
      personError: mustGet('team-person-error'),
      peopleList: mustGet<HTMLDataListElement>('team-people-list'),
      taskList: mustGet<HTMLUListElement>('team-task-list'),
      emptyState: mustGet('team-empty-state'),
      taskForm: mustGet<HTMLFormElement>('team-task-form'),
      taskInput: mustGet<HTMLInputElement>('team-task-input'),
      noteForm: mustGet<HTMLFormElement>('team-note-form'),
      noteInput: mustGet<HTMLInputElement>('team-note-input'),
      notes: mustGet('team-notes'),
      copyWeek: mustGet<HTMLButtonElement>('team-copy-week'),
      status: mustGet('team-status'),
    },
  };
}

/**
 * One task row: a status toggle, the title, and a remove button. Shared by
 * the card's own task list and the Team panel's, which render the identical
 * shape against two different underlying documents.
 *
 * Titles go in with `textContent`, never `innerHTML`. The text is the user's
 * own, but it round-trips through a file on disk that other tools (and agents)
 * can write — treating it as markup would be a standing XSS hole for the sake
 * of nothing.
 */
function renderTaskRow(
  task: Task,
  options: { carried?: boolean; onToggle: () => void; onRemove: () => void },
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'task';
  if (task.status === 'in-progress') item.classList.add('is-in-progress');
  if (task.status === 'completed') item.classList.add('is-completed');
  if (options.carried === true) item.classList.add('is-carried');

  const glyphs: Record<Task['status'], string> = {
    upcoming: '',
    'in-progress': '•',
    completed: '✓',
  };

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'task-toggle';
  toggle.textContent = glyphs[task.status];
  toggle.title = `Mark ${cycleStatus(task.status).replace('-', ' ')}`;
  toggle.setAttribute('aria-label', `${task.title} — ${task.status}`);
  toggle.addEventListener('click', options.onToggle);

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'task-remove';
  remove.textContent = '×';
  remove.title = 'Remove task';
  remove.setAttribute('aria-label', `Remove ${task.title}`);
  remove.addEventListener('click', options.onRemove);

  item.append(toggle, title, remove);
  return item;
}

class CheckInController {
  private readonly vault: VaultPort;
  private readonly elements: Elements;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private state: CheckInState = { ...INITIAL_CHECK_IN_STATE };
  /** The day currently loaded in the card, or `null` when nothing is open. */
  private day: DayDocument | null = null;
  /** The slot the open card belongs to, so Done knows what to mark handled. */
  private slot: CheckInSlot | null = null;
  /** `true` while the card is on screen. */
  private visible = false;
  /** `true` between the decision to present and the card actually appearing. */
  private presenting = false;
  /** `true` while the settings panel is on screen. */
  private settingsOpen = false;
  /**
   * `true` when settings were opened with no check-in behind them, so closing
   * them has to hide the window rather than reveal an empty card.
   */
  private settingsStandalone = false;
  /** The working-day selection being edited, applied only on Save. */
  private draftWorkDays: number[] = [];
  /** `true` while the Team panel is on screen. Mutually exclusive with Settings. */
  private teamOpen = false;
  /** Same bookkeeping as `settingsStandalone`, for the Team panel. */
  private teamStandalone = false;
  /** The report currently loaded in the Team panel, or `null` when none is. */
  private teamMember: TeamMemberDocument | null = null;
  private teamStatusTimer: number | undefined;
  /**
   * `true` when the window is at `EXPANDED_SIZE` rather than `COMPACT_SIZE`.
   *
   * In-memory only, not persisted to `settings.json` — like a snooze, this is
   * "more room right now," not durable configuration. It survives between
   * check-ins within one run of the app (this controller lives for the whole
   * run) and resets to compact on the next launch.
   */
  private expanded = false;
  /** Last text pushed to the tray, so identical updates aren't re-sent. */
  private lastTrayStatus: string | null = null;
  /**
   * Tasks already marked done when this check-in opened. They stay in the day
   * file but are hidden until wrap-up; only work finished during this prompt
   * lingers at the bottom of the list.
   */
  private completedBeforeCheckIn = new Set<string>();
  /**
   * Serializes vault writes. Every save appends to this chain rather than
   * racing, so a fast "add task, add task, Done" can't produce interleaved
   * writes where the second read clobbers the first.
   */
  private writes: Promise<void> = Promise.resolve();
  private statusTimer: number | undefined;

  constructor(vault: VaultPort, elements: Elements) {
    this.vault = vault;
    this.elements = elements;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.elements.taskForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.onAddTask();
    });

    this.elements.noteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.onAddNote();
    });

    this.elements.done.addEventListener('click', () => {
      void this.finish();
    });

    this.elements.snooze.addEventListener('click', () => {
      void this.onSnooze();
    });

    this.elements.copyStandup.addEventListener('click', () => {
      void this.copyStandup();
    });

    this.elements.copyWeek.addEventListener('click', () => {
      void this.copyWeek();
    });

    this.elements.teamDayEndForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.onAddTeamDayEndNote();
    });

    this.elements.expandToggle.addEventListener('click', () => {
      void this.toggleExpanded();
    });

    this.bindSettingsEvents();
    this.bindTeamEvents();

    // Esc snoozes; the card is a prompt, not a modal you have to defeat.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();

      // With a panel up, Esc belongs to the panel. Falling through to the
      // snooze would dismiss a check-in the user never looked at — and, when
      // a panel was opened from the tray with nothing due, would snooze a slot
      // that isn't even on screen. Team and Settings are mutually exclusive
      // (see `openTeam`/`openSettings`), so checking both in sequence is safe.
      if (this.teamOpen) {
        void this.closeTeam();
        return;
      }

      if (this.settingsOpen) {
        void this.closeSettings();
        return;
      }

      void this.onSnooze();
    });
  }

  private bindTeamEvents(): void {
    const team = this.elements.team;

    team.open.addEventListener('click', () => {
      void this.openTeam();
    });

    team.close.addEventListener('click', () => {
      void this.closeTeam();
    });

    team.personLoad.addEventListener('click', () => {
      void this.loadTeamMember(team.personInput.value);
    });

    // Keyboard-first, like the rest of the app: no need to reach for the mouse
    // to open a report you just typed.
    team.personInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void this.loadTeamMember(team.personInput.value);
    });

    team.taskForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.onAddTeamTask();
    });

    team.noteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.onAddTeamNote();
    });

    team.copyWeek.addEventListener('click', () => {
      void this.copyTeamWeek();
    });

    team.expandToggle.addEventListener('click', () => {
      void this.toggleExpanded();
    });
  }

  private bindSettingsEvents(): void {
    const settings = this.elements.settings;

    settings.open.addEventListener('click', () => {
      void this.openSettings();
    });

    settings.close.addEventListener('click', () => {
      void this.closeSettings();
    });

    settings.expandToggle.addEventListener('click', () => {
      void this.toggleExpanded();
    });

    settings.cancel.addEventListener('click', () => {
      void this.closeSettings();
    });

    settings.save.addEventListener('click', () => {
      void this.saveSettings();
    });

    settings.openVault.addEventListener('click', () => {
      void openVaultFolder();
    });

    // One row of day toggles, built from the shared labels so the buttons and
    // the `Date.getDay()` numbering can't drift apart.
    settings.workDays.replaceChildren(
      ...DAY_LABELS.map((label, day) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'day-toggle';
        button.textContent = label;
        button.dataset.day = String(day);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          this.draftWorkDays = toggleWorkDay(this.draftWorkDays, day);
          this.renderWorkDays();
        });
        return button;
      }),
    );
  }

  /** Load settings, publish the agent guide, and arm the scheduler. */
  async start(): Promise<void> {
    await this.loadSettings();

    // Rewritten every launch so it can never drift from the format the app
    // actually writes. Failing here must not stop the app from running.
    try {
      await this.vault.write(CONTEXT_FILENAME, CONTEXT_DOC);
    } catch (error) {
      console.warn('Could not write the vault guide:', describeError(error));
    }

    await this.restoreSchedulerState();
    await this.registerTrayHandlers();
    await this.refreshTrayStatus();

    window.setInterval(() => {
      void this.tick();
    }, SCHEDULER_TICK_MS);

    // Evaluate immediately so launching mid-morning doesn't wait an hour for
    // the first tick to notice an outstanding slot.
    await this.tick();
  }

  /**
   * Recover which check-in was last handled today, from today's day file.
   *
   * The scheduler's state is in-memory, and this app is expected to survive
   * reboots, Windows updates and its own crashes mid-workday. Without this the
   * app would relaunch believing nothing had been handled and immediately
   * re-prompt for a slot the user already completed.
   */
  private async restoreSchedulerState(): Promise<void> {
    try {
      const today = toDateKey(new Date());
      const day = await readDay(this.vault, today, this.settings.workStart, this.settings.workEnd);
      if (day === null) return;

      this.state = restoreCheckInState(today, day.lastCheckIn);
    } catch (error) {
      // Falling back to "nothing handled" costs at most one extra prompt, which
      // is a far better failure than refusing to start.
      console.warn('Could not restore check-in state:', describeError(error));
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await loadSettingsJson();
      this.settings = raw === null ? { ...DEFAULT_SETTINGS } : parseSettings(JSON.parse(raw));
    } catch (error) {
      // A corrupt settings file must not stop the app from starting.
      console.warn('Falling back to default settings:', describeError(error));
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private async registerTrayHandlers(): Promise<void> {
    await onCheckInRequested(() => {
      void this.openOnDemand();
    });
    await onStandupRequested(() => {
      void this.copyStandup();
    });
    await onWeekRequested(() => {
      void this.copyWeek();
    });
    await onOpenVaultRequested(() => {
      void openVaultFolder();
    });
    await onSettingsRequested(() => {
      void this.openSettings();
    });
    await onTeamRequested(() => {
      void this.openTeam();
    });
    await onTeamWeekRequested(() => {
      void this.copyTeamWeek();
    });
  }

  /** The scheduler cadence: decide whether to interrupt, and do nothing if not. */
  private async tick(): Promise<void> {
    // A due check-in must not land on top of an overlay: the card would paint
    // underneath a panel the user is typing into, and Done/Esc would reach the
    // wrong surface. The slot stays outstanding and is served as soon as the
    // panel closes, which is exactly the coalescing behavior slots exist for —
    // nothing is lost by waiting.
    if (this.visible || this.settingsOpen || this.teamOpen) return;

    // Keep the tray honest even on the many ticks that don't prompt.
    await this.refreshTrayStatus();

    const now = new Date();
    const slot = dueCheckIn(now, this.settings, this.state);
    if (slot === null) return;

    await this.present(slot);
  }

  /**
   * Load the day behind `slot` and bring the card on screen.
   *
   * `presenting` is raised **synchronously**, before the first `await`. The
   * `visible` flag alone is not a sufficient guard: it is only set after the
   * vault read resolves, so a tray "check in now" landing during that read would
   * pass the `visible` check and present a second card over the first. The
   * sibling calendar-alert project shipped exactly this race between its
   * animation and poll paths before adding a mutual-exclusion flag.
   */
  private async present(slot: CheckInSlot): Promise<void> {
    if (this.presenting || this.settingsOpen || this.teamOpen) return;
    this.presenting = true;

    try {
      this.day = await openDay(
        this.vault,
        slot.date,
        this.settings.workStart,
        this.settings.workEnd,
      );
    } catch (error) {
      await showError('Could not open your journal', describeError(error));
      // Mark the slot handled anyway: re-prompting every minute against a
      // broken vault would be worse than missing one check-in.
      this.state = markHandled(slot);
      return;
    } finally {
      this.presenting = false;
    }

    this.slot = slot;
    this.visible = true;
    this.completedBeforeCheckIn = completedBeforeCheckIn(this.day.tasks);

    this.render();
    await showCheckIn();

    // Let the entrance transition start from the off-stage position before
    // flipping the class, or the card simply appears with no motion.
    requestAnimationFrame(() => {
      this.elements.card.classList.add('is-open');
    });

    this.elements.taskInput.focus();
  }

  /** Tray "Check in now": open the current slot even if it was already handled. */
  private async openOnDemand(): Promise<void> {
    if (this.visible) return;

    await this.present(onDemandSlot(new Date(), this.settings));
  }

  /* ----------------------------------------------------------------- expand */

  /**
   * Toggle between `COMPACT_SIZE` and `EXPANDED_SIZE`.
   *
   * One flag drives all three headers (card, Settings, Team): the window is
   * one size regardless of which overlay happens to be showing, so whichever
   * one the button was clicked from, all three stay in sync for whenever the
   * others are opened next.
   *
   * `expanded` flips **synchronously**, before the `await`, and the buttons
   * are rendered immediately after — not after `setWindowSize` resolves. A
   * flag updated only on success is not a guard against two clicks fired
   * before the first IPC round trip returns: both would read the same stale
   * `this.expanded`, compute the same `next`, and a double-click meant to
   * toggle expand-then-collapse would net out expanded instead. Same
   * reasoning as `presenting` in `present()`.
   */
  private async toggleExpanded(): Promise<void> {
    const next = !this.expanded;
    this.expanded = next;
    this.renderExpandButtons();

    const size = next ? EXPANDED_SIZE : COMPACT_SIZE;
    try {
      await setWindowSize(size.width, size.height);
    } catch (error) {
      // Revert: leave `expanded` (and so the buttons) truthful about the size
      // the window is actually still at, rather than claiming a resize that
      // didn't happen.
      this.expanded = !next;
      this.renderExpandButtons();
      await showError('Could not resize the window', describeError(error));
    }
  }

  private renderExpandButtons(): void {
    const label = this.expanded ? 'Collapse' : 'Expand';

    for (const button of [
      this.elements.expandToggle,
      this.elements.settings.expandToggle,
      this.elements.team.expandToggle,
    ]) {
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(this.expanded));
    }
  }

  /* ---------------------------------------------------------------- settings */

  /**
   * Bring up the settings panel, over the card if one is open and alone if not.
   *
   * Reached two ways — the gear on the card, and the tray item — which differ in
   * whether the window is already on screen. `settingsStandalone` records which,
   * because closing has to put things back the way it found them.
   */
  private async openSettings(): Promise<void> {
    if (this.settingsOpen || this.teamOpen) return;

    this.settingsOpen = true;
    this.settingsStandalone = !this.visible;

    try {
      this.fillSettingsForm(toDraft(this.settings));
      this.showSettingsIssues([]);
      await this.loadNativeSettingsFields();

      const panel = this.elements.settings.panel;
      panel.hidden = false;

      // The panel covers the card but does not trap focus on its own, and
      // `aria-modal` is only a hint to assistive tech. Without this, Tab walks
      // straight into the task input behind the overlay and you type your next
      // task into a field you cannot see.
      this.elements.card.inert = true;

      // From the tray the window itself is hidden, so it has to come up. No
      // attention request: the user clicked a menu item a moment ago.
      if (this.settingsStandalone) await showWindow();

      // Same rAF two-step as the card: let the browser paint the off-stage
      // position once, or the transition has nothing to animate from.
      requestAnimationFrame(() => {
        panel.classList.add('is-open');
      });

      this.elements.settings.workStart.focus();
    } catch (error) {
      // A raised `settingsOpen` that never comes down is far worse than failing
      // to open: the panel could never reopen, *and* `tick()` would suppress
      // every check-in for the rest of the day — the app would simply go quiet.
      // `show()`/`set_focus()` are real IPC calls that can reject, and the
      // caller is a `void`-ed click handler, so nothing else would catch this.
      // Same reasoning as the `presenting` flag's `finally` in `present()`.
      this.hideSettingsPanel();
      await showError('Could not open settings', describeError(error));
    }
  }

  /**
   * Put the panel away and hand the card back, without touching the window.
   *
   * Split out so the failure path above resets exactly the same state the
   * ordinary close does, and can't itself throw part-way through.
   */
  private hideSettingsPanel(): void {
    this.settingsOpen = false;

    const panel = this.elements.settings.panel;
    panel.classList.remove('is-open');
    panel.hidden = true;
    this.elements.card.inert = false;
  }

  /**
   * Close the panel, discarding anything not saved.
   *
   * There is no exit animation on purpose. Removing the class and hiding in the
   * same frame keeps the close synchronous; animating out would mean hiding on a
   * timer, and a pending timer is a thing the next open has to reason about.
   */
  private async closeSettings(): Promise<void> {
    if (!this.settingsOpen) return;

    this.hideSettingsPanel();

    if (this.settingsStandalone) {
      await hideWindow();
      return;
    }

    // A check-in is still up behind the panel; put the cursor back where it was.
    this.elements.taskInput.focus();
  }

  /**
   * Validate, persist, and adopt the edited settings.
   *
   * Order matters: `settings.json` is written *before* the in-memory settings
   * change, so a failed write leaves the running app on the values that are
   * actually on disk rather than on values that would vanish at the next launch.
   */
  private async saveSettings(): Promise<void> {
    const draft = this.readDraft();
    const issues = validateDraft(draft);
    this.showSettingsIssues(issues);
    if (issues.length > 0) return;

    const next = applyDraft(this.settings, draft);

    try {
      await saveSettingsJson(serializeSettings(next));
    } catch (error) {
      await showError('Could not save your settings', describeError(error));
      return;
    }

    this.settings = next;

    // A check-in already open behind the panel reads settings on every render
    // (the day-end team step, the headline's "ends the week" framing, the
    // wrap-up's next-working-day text) — without this it would keep showing
    // what was true when it opened rather than what was just saved. `render()`
    // no-ops when nothing is open.
    this.render();

    // Launch-at-login lives in the OS, not in settings.json. It is applied after
    // the write and its failure is reported without undoing that write — the
    // rest of the settings did save, and pretending otherwise would be worse.
    try {
      await setAutostart(this.elements.settings.launchAtLogin.checked);
    } catch (error) {
      await showError('Could not change launch at login', describeError(error));
    }

    await this.closeSettings();
    await this.refreshTrayStatus();
  }

  /** Read the native-owned fields: the vault path and the autostart state. */
  private async loadNativeSettingsFields(): Promise<void> {
    const settings = this.elements.settings;

    try {
      // `textContent`, like every other path through this app: the vault
      // directory is a string from outside the webview.
      settings.vaultPath.textContent = await vaultPath();
    } catch (error) {
      settings.vaultPath.textContent = 'Could not read the vault location.';
      console.warn('Could not read the vault path:', describeError(error));
    }

    try {
      settings.launchAtLogin.checked = await isAutostartEnabled();
    } catch (error) {
      settings.launchAtLogin.checked = false;
      console.warn('Could not read the autostart state:', describeError(error));
    }
  }

  private readDraft(): SettingsDraft {
    const settings = this.elements.settings;
    return {
      workStart: settings.workStart.value,
      workEnd: settings.workEnd.value,
      hourlyEnabled: settings.hourlyEnabled.checked,
      snoozeMinutes: settings.snoozeMinutes.value,
      workDays: [...this.draftWorkDays],
      managerModeEnabled: settings.managerModeEnabled.checked,
    };
  }

  private fillSettingsForm(draft: SettingsDraft): void {
    const settings = this.elements.settings;
    settings.workStart.value = draft.workStart;
    settings.workEnd.value = draft.workEnd;
    settings.hourlyEnabled.checked = draft.hourlyEnabled;
    settings.snoozeMinutes.value = draft.snoozeMinutes;
    settings.managerModeEnabled.checked = draft.managerModeEnabled;

    this.draftWorkDays = [...draft.workDays];
    this.renderWorkDays();
  }

  private renderWorkDays(): void {
    for (const button of this.elements.settings.workDays.querySelectorAll('button')) {
      const day = Number(button.dataset.day);
      button.setAttribute('aria-pressed', String(this.draftWorkDays.includes(day)));
    }
  }

  /** Mark the offending controls and say what's wrong; `[]` clears both. */
  private showSettingsIssues(issues: readonly SettingsIssue[]): void {
    const settings = this.elements.settings;
    const flagged = new Set(issues.map((issue) => issue.field));

    settings.workStart.classList.toggle('is-invalid', flagged.has('workStart'));
    settings.workEnd.classList.toggle('is-invalid', flagged.has('workEnd'));
    settings.snoozeMinutes.classList.toggle('is-invalid', flagged.has('snoozeMinutes'));
    settings.workDays.classList.toggle('is-invalid', flagged.has('workDays'));

    // Every message at once. Reporting one problem per Save press turns a form
    // with three mistakes in it into three round trips.
    settings.error.textContent = issues.map((issue) => issue.message).join(' ');
  }

  /* -------------------------------------------------------------------- team */

  /**
   * Bring up the Team panel, over the card if one is open and alone if not.
   *
   * Reached the same two ways Settings is — the icon on the card, and the tray
   * item — and follows the identical standalone-window bookkeeping. Refuses to
   * open on top of Settings (`openSettings` returns the guard), so the app
   * shows at most one overlay at a time.
   */
  private async openTeam(): Promise<void> {
    if (this.teamOpen || this.settingsOpen) return;

    this.teamOpen = true;
    this.teamStandalone = !this.visible;

    try {
      await this.refreshTeamPeopleList();
      this.elements.team.personInput.value = '';
      this.setTeamPersonError('');
      this.teamMember = null;
      this.renderTeamMember();

      const panel = this.elements.team.panel;
      panel.hidden = false;

      // Same reasoning as Settings: `aria-modal` alone doesn't stop Tab from
      // reaching the card behind the overlay.
      this.elements.card.inert = true;

      if (this.teamStandalone) await showWindow();

      requestAnimationFrame(() => {
        panel.classList.add('is-open');
      });

      this.elements.team.personInput.focus();
    } catch (error) {
      // Same reasoning as `openSettings`'s catch: a `teamOpen` that never comes
      // down would both block reopening and suppress every check-in for the
      // rest of the day via the `tick()` guard.
      this.hideTeamPanel();
      await showError('Could not open the Team panel', describeError(error));
    }
  }

  /** Put the panel away and hand the card back, without touching the window. */
  private hideTeamPanel(): void {
    this.teamOpen = false;
    this.teamMember = null;

    const panel = this.elements.team.panel;
    panel.classList.remove('is-open');
    panel.hidden = true;
    this.elements.card.inert = false;
  }

  private async closeTeam(): Promise<void> {
    if (!this.teamOpen) return;

    this.hideTeamPanel();

    if (this.teamStandalone) {
      await hideWindow();
      return;
    }

    this.elements.taskInput.focus();
  }

  /** Populate the handle autocomplete with every report that already has a file. */
  private async refreshTeamPeopleList(): Promise<void> {
    const people = await listTeamPeople(this.vault);
    this.elements.team.peopleList.replaceChildren(
      ...people.map((person) => {
        const option = document.createElement('option');
        option.value = person;
        return option;
      }),
    );
  }

  /**
   * Load (or create) a report's file and show it.
   *
   * Waits on `this.writes` first: a day-end mention of the same person may
   * still be queued, and reading ahead of it would show stale tasks/notes and
   * risk a lost update the next time this panel saves.
   */
  private async loadTeamMember(rawHandle: string): Promise<void> {
    const handle = rawHandle.trim().replace(/^@/, '').toLowerCase();
    if (handle === '') return;

    if (!isPersonHandle(handle)) {
      this.setTeamPersonError(
        'Handles use lowercase letters, numbers, dots, dashes and underscores.',
      );
      return;
    }

    this.setTeamPersonError('');

    try {
      await this.writes;
      this.teamMember = await openTeamMember(this.vault, handle);
      this.elements.team.personInput.value = handle;
      this.renderTeamMember();
      await this.refreshTeamPeopleList();
    } catch (error) {
      await showError('Could not open that report', describeError(error));
    }
  }

  private setTeamPersonError(message: string): void {
    this.elements.team.personError.textContent = message;
  }

  private renderTeamMember(): void {
    const team = this.elements.team;
    const tasks = this.teamTasks();

    team.taskList.replaceChildren(...tasks.map((task) => this.renderTeamTask(task)));
    team.emptyState.hidden = tasks.length > 0;

    // Newest first, and capped: this is a glance at recent activity, not a
    // full history browser — the file on disk is that.
    const notes = [...(this.teamMember?.notes ?? [])]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8);

    team.notes.replaceChildren(
      ...notes.map((note) => {
        const item = document.createElement('li');
        item.className = 'team-note';

        const date = document.createElement('span');
        date.className = 'team-note-date';
        date.textContent = note.date;

        const text = document.createElement('span');
        text.textContent = note.text;

        item.append(date, text);
        return item;
      }),
    );
  }

  private renderTeamTask(task: Task): HTMLLIElement {
    return renderTaskRow(task, {
      onToggle: () => {
        this.updateTeamTasks(setTaskStatus(this.teamTasks(), task.title, cycleStatus(task.status)));
      },
      onRemove: () => {
        this.updateTeamTasks(removeTask(this.teamTasks(), task.title));
      },
    });
  }

  private teamTasks(): Task[] {
    return this.teamMember?.tasks ?? [];
  }

  /**
   * Apply an edited task list, recomputing which completions have a date.
   *
   * Every task mutation — toggling status, adding, removing — flows through
   * here, which is what makes this the one place `completedDates` needs to
   * stay in sync rather than something each caller has to remember to do.
   */
  private updateTeamTasks(tasks: Task[]): void {
    if (this.teamMember === null) return;

    const completedDates = updateCompletedDates(
      this.teamMember.tasks,
      this.teamMember.completedDates,
      tasks,
      toDateKey(new Date()),
    );

    this.teamMember = { ...this.teamMember, tasks, completedDates };
    this.renderTeamMember();
    this.saveTeamMember();
  }

  private onAddTeamTask(): void {
    const title = this.elements.team.taskInput.value;
    if (title.trim() === '') return;

    if (this.teamMember === null) {
      this.setTeamStatus('Open a report first');
      return;
    }

    this.elements.team.taskInput.value = '';
    this.updateTeamTasks(addTask(this.teamTasks(), title));
  }

  private onAddTeamNote(): void {
    const text = this.elements.team.noteInput.value;
    if (text.trim() === '') return;

    if (this.teamMember === null) {
      this.setTeamStatus('Open a report first');
      return;
    }

    this.elements.team.noteInput.value = '';
    this.teamMember = addTeamNote(this.teamMember, toDateKey(new Date()), text);
    this.renderTeamMember();
    this.saveTeamMember();
    this.setTeamStatus('Note saved');
  }

  /** Queue a team file write behind any in flight, on the same chain day-file saves use. */
  private saveTeamMember(): void {
    const member = this.teamMember;
    if (member === null) return;

    this.writes = this.writes
      .then(() => writeTeamMember(this.vault, member))
      .catch(async (error: unknown) => {
        await showError('Could not save your team notes', describeError(error));
      });
  }

  /**
   * The day-end "anything on your reports?" step. Only shown when manager mode
   * is on (see `render`); auto-creates a report's file the first time they're
   * mentioned, the same "no roster, just usage" rule the Team panel follows.
   */
  private async onAddTeamDayEndNote(): Promise<void> {
    const trimmed = this.elements.teamDayEndInput.value.trim();
    if (trimmed === '') return;

    const people = extractPeople(trimmed);
    if (people.length === 0) {
      this.setStatus('Mention someone with @ to log it, e.g. @alice');
      return;
    }

    this.elements.teamDayEndInput.value = '';
    const today = toDateKey(new Date());

    this.writes = this.writes
      .then(async () => {
        for (const person of people) {
          const existing = await openTeamMember(this.vault, person);
          await writeTeamMember(this.vault, addTeamNote(existing, today, trimmed));
        }
      })
      .catch(async (error: unknown) => {
        await showError('Could not save your team note', describeError(error));
      });

    await this.writes;
    this.setStatus('Logged');
  }

  /**
   * Every tracked report's file, for the rollup writer and the clipboard
   * briefing — the manager-perspective sibling of `daysOfWeek`.
   */
  private async allTeamMembers(): Promise<TeamMemberDocument[]> {
    const people = await listTeamPeople(this.vault);
    const members: TeamMemberDocument[] = [];

    for (const person of people) {
      const member = await readTeamMember(this.vault, person);
      if (member !== null) members.push(member);
    }

    return members;
  }

  /** Copy this week across every tracked report, framed for an agent. */
  private async copyTeamWeek(): Promise<void> {
    try {
      const monday = startOfIsoWeek(new Date());
      const weekStart = toDateKey(monday);
      const weekEnd = toDateKey(addDays(monday, 6));

      const briefing = teamWeekBriefing(await this.allTeamMembers(), weekStart, weekEnd);
      if (briefing === null) {
        this.setTeamStatus('No reports tracked yet');
        return;
      }

      await copyToClipboard(briefing);
      this.setTeamStatus('Team week copied');
    } catch (error) {
      await showError('Could not copy your team week', describeError(error));
    }
  }

  private setTeamStatus(text: string): void {
    const status = this.elements.team.status;
    status.textContent = text;
    status.classList.add('is-visible');

    window.clearTimeout(this.teamStatusTimer);
    this.teamStatusTimer = window.setTimeout(() => {
      status.classList.remove('is-visible');
    }, STATUS_HOLD_MS);
  }

  private render(): void {
    const day = this.day;
    const slot = this.slot;
    if (day === null || slot === null) return;

    this.elements.headline.textContent = describeCheckIn(slot.kind, this.endsWeek(slot));
    this.elements.subhead.textContent = this.describeProgress(day, slot);

    const previouslyCompleted =
      slot.kind === 'day-end' ? new Set<string>() : this.completedBeforeCheckIn;
    const visible = tasksForCheckIn(day.tasks, previouslyCompleted);
    this.elements.taskList.replaceChildren(...visible.map((task) => this.renderTask(task)));
    this.elements.emptyState.hidden = visible.length > 0;

    // The one place the recurring check-in grows an extra step: only at
    // day-end, and only with manager mode on. See `Settings.managerModeEnabled`.
    this.elements.teamDayEndForm.hidden = !(
      slot.kind === 'day-end' && this.settings.managerModeEnabled
    );
  }

  private describeProgress(day: DayDocument, slot: CheckInSlot): string {
    const summary = summarizeTasks(day.tasks);

    if (slot.kind === 'day-start') {
      return summary.total === 0
        ? "Nothing carried over — what's on today?"
        : `${String(summary.open)} to pick up today`;
    }

    if (slot.kind === 'day-end') {
      // "plan tomorrow?" is wrong on the last working day of the week, which is
      // exactly the wrap-up that matters most — those leftovers sit until Monday.
      //
      // "open" rather than "still open" because a weekday name is longer than
      // "tomorrow" and this line has one card header to live in. It also matches
      // the wording of the tray status.
      const next = describeNextWorkingDay(this.slotDate(slot), this.settings);
      return `${String(summary.completed)} done, ${String(summary.open)} open — plan ${next}?`;
    }

    return `${String(summary.completed)} of ${String(summary.total)} done`;
  }

  /**
   * The calendar date a slot belongs to.
   *
   * Derived from the slot rather than from `new Date()` because the day-end slot
   * stays outstanding all evening: at 00:20 the wall clock has rolled over, and
   * "plan tomorrow?" against the wrong date would offer to plan the day you are
   * already standing in. Falls back to now if the key is somehow unparseable.
   */
  private slotDate(slot: CheckInSlot): Date {
    return fromDateKey(slot.date) ?? new Date();
  }

  /** `true` when this slot's day is the last working day of its week. */
  private endsWeek(slot: CheckInSlot): boolean {
    return endsWorkingWeek(this.slotDate(slot), this.settings);
  }

  private renderTask(task: Task): HTMLLIElement {
    return renderTaskRow(task, {
      carried: this.day !== null && isCarriedOver(task, this.day.date),
      onToggle: () => {
        this.updateTasks(setTaskStatus(this.tasks(), task.title, cycleStatus(task.status)));
      },
      onRemove: () => {
        this.updateTasks(removeTask(this.tasks(), task.title));
      },
    });
  }

  private tasks(): Task[] {
    return this.day?.tasks ?? [];
  }

  private updateTasks(tasks: Task[]): void {
    if (this.day === null) return;

    this.day = { ...this.day, tasks };
    this.render();
    this.save();
  }

  private onAddTask(): void {
    const title = this.elements.taskInput.value;
    if (title.trim() === '') return;

    this.elements.taskInput.value = '';
    this.updateTasks(addTask(this.tasks(), title, 'upcoming', this.day?.date));
  }

  private onAddNote(): void {
    const text = this.elements.noteInput.value;
    if (text.trim() === '' || this.day === null) return;

    this.elements.noteInput.value = '';
    this.day = addNote(this.day, toClock(new Date()), text);
    this.save();
    this.setStatus('Note saved');
  }

  /**
   * Queue a vault write behind any in flight.
   *
   * Captures `this.day` at call time so a later edit can't retroactively change
   * what this write was supposed to persist.
   */
  private save(): void {
    const day = this.day;
    if (day === null) return;

    this.writes = this.writes
      .then(() => writeDay(this.vault, day))
      .catch(async (error: unknown) => {
        await showError('Could not save your journal', describeError(error));
      });
  }

  /** Done: persist, mark the slot handled, and get out of the way. */
  private async finish(): Promise<void> {
    const slot = this.slot;
    if (slot === null) return;

    // Record the handled slot *in the day file* before saving, so the scheduler
    // can recover it after a reboot. This has to happen before `save()`, which
    // snapshots the document.
    if (this.day !== null) this.day = { ...this.day, lastCheckIn: slotClock(slot) };

    this.save();
    await this.writes;

    await this.refreshRollups(slot);

    this.state = markHandled(slot);
    await this.dismiss();
    await this.refreshTrayStatus();
  }

  private async onSnooze(): Promise<void> {
    if (this.slot === null) return;

    this.save();
    await this.writes;

    this.state = snooze(this.state, new Date(), this.settings);
    await this.dismiss();
  }

  private async dismiss(): Promise<void> {
    this.elements.card.classList.remove('is-open');
    this.visible = false;
    this.slot = null;
    await hideWindow();
  }

  /**
   * Keep the weekly rollups current, and heal any the week boundary skipped.
   *
   * The rollup used to be written only at `day-end`, which quietly lost a whole
   * week whenever the last working day didn't get a wrap-up — knock off early on
   * a Friday and that week produced no rollup at all, forever. Since the rollups
   * are what make a year of day files reviewable, a silently missing week is the
   * expensive kind of gap.
   *
   * So: refresh the current week on every check-in (it is derived data and cheap
   * to rebuild), and on the first check-in of a day, also rebuild the previous
   * logged week if that day belongs to a different week. That makes Monday
   * morning repair the Friday nobody closed.
   */
  private async refreshRollups(slot: CheckInSlot): Promise<void> {
    await this.writeRollupForWeekOf(slot.date);
    if (this.settings.managerModeEnabled) await this.writeTeamRollupForWeekOf(slot.date);

    if (slot.kind !== 'day-start') return;

    try {
      const previous = previousDayKey(await listDayKeys(this.vault), slot.date);
      if (previous === null) return;
      if (weekFileName(previous) === weekFileName(slot.date)) return;

      await this.writeRollupForWeekOf(previous);
      if (this.settings.managerModeEnabled) await this.writeTeamRollupForWeekOf(previous);
    } catch (error) {
      console.warn('Could not heal the previous weekly rollup:', describeError(error));
    }
  }

  /**
   * Every logged day of the ISO week containing `date`, ascending.
   *
   * Shared by the rollup writer and the clipboard briefing so the two can never
   * disagree about where a week starts.
   */
  private async daysOfWeek(date: Date): Promise<DayDocument[]> {
    const monday = startOfIsoWeek(date);
    return await readDayRange(
      this.vault,
      toDateKey(monday),
      toDateKey(addDays(monday, 6)),
      this.settings.workStart,
      this.settings.workEnd,
    );
  }

  /** Regenerate the rollup file for the ISO week containing `date`. */
  private async writeRollupForWeekOf(date: string): Promise<void> {
    const name = weekFileName(date);
    if (name === null) return;

    const slotDate = fromDateKey(date);
    if (slotDate === null) return;

    try {
      await this.vault.write(name, weeklyRollup(await this.daysOfWeek(slotDate)));
    } catch (error) {
      // A rollup is derived data — never let it take down the check-in.
      console.warn('Could not write the weekly rollup:', describeError(error));
    }
  }

  /** Regenerate the team rollup file for the ISO week containing `date`. */
  private async writeTeamRollupForWeekOf(date: string): Promise<void> {
    const name = teamWeekFileName(date);
    if (name === null) return;

    const slotDate = fromDateKey(date);
    if (slotDate === null) return;

    const monday = startOfIsoWeek(slotDate);
    const weekStart = toDateKey(monday);
    const weekEnd = toDateKey(addDays(monday, 6));

    try {
      const members = await this.allTeamMembers();
      await this.vault.write(name, teamWeeklyRollup(members, weekStart, weekEnd));
    } catch (error) {
      // A rollup is derived data — never let it take down the check-in.
      console.warn('Could not write the team weekly rollup:', describeError(error));
    }
  }

  /**
   * Copy this week to the clipboard, framed for an agent that can't see the
   * vault.
   *
   * The vault is already agent-readable, so this is not for someone with the
   * folder in front of them — it's for pasting into a chat. It reads from disk
   * rather than from the open card because a week is more than today, and it
   * deliberately reports rather than silently copying nothing when the week is
   * empty.
   */
  private async copyWeek(): Promise<void> {
    try {
      const briefing = agentWeekBriefing(await this.daysOfWeek(new Date()));
      if (briefing === null) {
        this.setStatus('No entries this week');
        return;
      }

      await copyToClipboard(briefing);
      this.setStatus('Week copied');
    } catch (error) {
      await showError('Could not copy your week', describeError(error));
    }
  }

  /** Copy a paste-ready standup summary for today. */
  private async copyStandup(): Promise<void> {
    try {
      const today = toDateKey(new Date());
      // Only reuse the cached document if it is actually today's. The app runs
      // overnight, so after midnight `this.day` still holds yesterday — and
      // pasting yesterday's plan into today's standup is exactly the failure
      // this feature exists to prevent.
      const cached = this.day?.date === today ? this.day : null;
      const day =
        cached ??
        (await openDay(this.vault, today, this.settings.workStart, this.settings.workEnd));

      const keys = await listDayKeys(this.vault);
      const previousKey = previousDayKey(keys, today);
      const previous =
        previousKey === null
          ? null
          : await readDay(this.vault, previousKey, this.settings.workStart, this.settings.workEnd);

      await copyToClipboard(standupSummary(day, previous));
      this.setStatus('Standup copied');
    } catch (error) {
      await showError('Could not copy your standup', describeError(error));
    }
  }

  /**
   * Keep the tray menu's status line current.
   *
   * Runs on every scheduler tick, not just at launch and after a check-in.
   * Refreshing only on those two events left the line showing a snapshot that
   * could be hours old — a status that looks broken rather than live, which is
   * the same defect the sibling calendar-alert project fixed in its tray
   * countdown.
   *
   * It reads from the in-memory day when that is today's, and only pushes to the
   * tray when the rendered text actually changed, so a minute-by-minute refresh
   * costs neither a disk read nor a redundant IPC call in the common case.
   */
  private async refreshTrayStatus(): Promise<void> {
    try {
      const today = toDateKey(new Date());
      const day =
        this.day?.date === today
          ? this.day
          : await readDay(this.vault, today, this.settings.workStart, this.settings.workEnd);

      const text = formatTrayStatus(day);
      if (text === this.lastTrayStatus) return;

      this.lastTrayStatus = text;
      await setTrayStatus(text);
    } catch {
      // The tray line is cosmetic; a failure here is not worth a dialog.
    }
  }

  private setStatus(text: string): void {
    this.elements.status.textContent = text;
    this.elements.status.classList.add('is-visible');

    window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.elements.status.classList.remove('is-visible');
    }, STATUS_HOLD_MS);
  }
}

const controller = new CheckInController(createVault(), resolveElements());
void controller.start().catch(async (error: unknown) => {
  await showError('Task Tracker failed to start', describeError(error));
});
