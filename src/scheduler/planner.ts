import { addMinutes } from 'date-fns';
import type mongoose from 'mongoose';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import type { PlanningContext } from './planning-context.js';
import { hasLowEnergy, isDepleted } from './planning-context.js';
import { ScheduleEntryStatus, PREFERENCE_KEYS, PLANNING } from '../config/defaults.js';
import { parseTimeString, formatDateString, roundUpToMinutes, weekdayOfDateString, daysBetween, normalizeTimeString } from '../utils/date.js';
import { findAvailableSlots, type TimeSlot } from './time-slots.js';
import { dayApplies, inferBlockFromText, isAllDayRange, TIME_BLOCKS, type TimeBlock } from '../memory/memory-utils.js';
import { getLLMProvider } from '../llm/index.js';
import type { ScheduleBlueprint } from '../utils/zod-schemas.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('planner');

export type UnscheduledReason = 'no_slot' | 'overload' | 'low_energy' | 'conflict' | 'not_due_yet' | 'no_time_left';

export interface UnscheduledTask {
  taskId: string;
  title: string;
  reason: UnscheduledReason;
}

export interface PlanResult {
  entries: IScheduleEntry[];
  unscheduled: UnscheduledTask[];
}

export interface PlanOptions {
  /** Slots already taken by entries the caller wants to keep (replans). */
  preoccupied?: TimeSlot[];
  now?: Date;
  useBlueprint?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  /** Due more than LOOKAHEAD_DAYS away — only scheduled if the day has spare capacity. */
  ahead: boolean;
  dueToday: boolean;
  overdue: boolean;
  daysUntilDue: number | null;
}

interface Window {
  idealStart: Date;
  idealEnd: Date;
}

const BLOCK_HOURS: Record<TimeBlock, [string, string]> = {
  morning: ['06:00', '12:00'],
  afternoon: ['12:00', '17:00'],
  evening: ['17:00', '21:00'],
  night: ['21:00', '23:59'],
};

const RECOVERY_KIND = 'recovery';
const BREAK_KIND = 'break';

// ─── Task eligibility for a given day ─────────────────────────────────────────

export function taskEligibility(task: ITask, targetDate: string, timezone: string): Eligibility {
  const none: Eligibility = { eligible: false, ahead: false, dueToday: false, overdue: false, daysUntilDue: null };

  if (task.deferredUntil && task.deferredUntil > targetDate) return none;

  const dueStr = task.dueDate ? formatDateString(task.dueDate, timezone) : null;
  const days = dueStr ? daysBetween(targetDate, dueStr) : null;
  const hasFixedTimes = !!(task.isFixed && task.fixedStartTime && task.fixedEndTime);

  if (hasFixedTimes && dueStr) {
    // A fixed event belongs to its day only.
    return { eligible: days === 0, ahead: false, dueToday: days === 0, overdue: days !== null && days < 0, daysUntilDue: days };
  }

  return {
    eligible: true,
    ahead: days !== null && days > PLANNING.LOOKAHEAD_DAYS,
    dueToday: days === 0,
    overdue: days !== null && days < 0,
    daysUntilDue: days,
  };
}

// ─── Scoring & preferences ────────────────────────────────────────────────────

function scoreTask(task: ITask, elig: Eligibility): number {
  let urgency = 1;
  if (elig.daysUntilDue !== null) {
    const d = elig.daysUntilDue;
    urgency = d < 0 ? 6 : d === 0 ? 5 : d <= 1 ? 4 : d <= 3 ? 3 : d <= 7 ? 2 : 1;
  }
  // Repeatedly skipped tasks get a nudge so they stop sliding forever.
  const procrastination = Math.min(2, (task.deferCount ?? 0) * 0.5);
  return task.priority * 3 + task.cognitiveLoad * 2 + urgency * 3 + procrastination;
}

function getPreference(memory: RetrievedMemory, key: string): string | undefined {
  return memory.preferences.find(p => p.key === key)?.value;
}

function learnedFocusBlock(memory: RetrievedMemory): TimeBlock | null {
  return inferBlockFromText(getPreference(memory, PREFERENCE_KEYS.PEAK_FOCUS_WINDOW))
    ?? inferBlockFromText(getPreference(memory, 'deep_work_time'))
    ?? inferBlockFromText(getPreference(memory, 'study_time'));
}

function lowSuccessBlock(memory: RetrievedMemory): TimeBlock | null {
  return inferBlockFromText(getPreference(memory, PREFERENCE_KEYS.LOW_SUCCESS_WINDOW))
    ?? (getPreference(memory, PREFERENCE_KEYS.MORNING_TASK_DIFFICULTY) === 'high' ? 'morning' : null);
}

function estimateMultiplier(memory: RetrievedMemory): number {
  const raw = Number(getPreference(memory, PREFERENCE_KEYS.TIME_ESTIMATE_MULTIPLIER));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(0.75, Math.min(1.75, raw));
}

function nextBlockAfter(block: TimeBlock): TimeBlock {
  const i = TIME_BLOCKS.indexOf(block);
  return TIME_BLOCKS[Math.min(TIME_BLOCKS.length - 1, i + 1)]!;
}

// ─── Blueprint cache (avoid an LLM call on every replan of the same task set) ─

const blueprintCache = new Map<string, { blueprint: ScheduleBlueprint | null; at: number }>();

async function getBlueprint(tasks: ITask[], memory: RetrievedMemory, config: UserConfig, targetDate: string): Promise<ScheduleBlueprint | null> {
  const key = `${targetDate}|${tasks.map(t => String(t._id)).sort().join(',')}|${memory.preferences.length}|${memory.habits.length}|${memory.constraints.length}`;
  const cached = blueprintCache.get(key);
  if (cached && Date.now() - cached.at < PLANNING.BLUEPRINT_CACHE_MS) {
    return cached.blueprint;
  }
  const blueprint = await getLLMProvider().generateScheduleBlueprint(tasks, memory, config, targetDate).catch(() => null);
  blueprintCache.set(key, { blueprint, at: Date.now() });
  if (blueprintCache.size > 200) {
    const oldest = Array.from(blueprintCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) blueprintCache.delete(oldest[0]);
  }
  return blueprint;
}

// ─── Core planner ─────────────────────────────────────────────────────────────

/**
 * Deterministic day planner.
 *
 * 1. Lock fixed constraints (classes, meetings) and habits (gym, nap)
 * 2. Lock fixed-time tasks for the day
 * 3. Score flexible tasks (priority × urgency × cognitive load × procrastination)
 * 4. Allocate each into its preferred window (learned focus windows, energy, blueprint)
 * 5. Keep slack, insert recovery breaks after deep work
 * 6. Report everything that could not be placed, with a reason
 */
export async function planSchedule(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
  planningContext: PlanningContext = {},
  options: PlanOptions = {},
): Promise<PlanResult> {
  const tz = config.timezone;
  const at = (hhmm: string) => parseTimeString(hhmm, targetDate, tz);
  const now = options.now ?? new Date();
  const todayStr = formatDateString(now, tz);
  const isToday = targetDate === todayStr;

  const entries: IScheduleEntry[] = [];
  const unscheduled: UnscheduledTask[] = [];

  if (targetDate < todayStr) {
    log.info({ targetDate }, 'Refusing to plan a past day');
    return { entries, unscheduled };
  }

  const workingStart = at(config.workingHours.start);
  const workingEnd = at(config.workingHours.end);

  let effectiveStart = isToday && now > workingStart ? roundUpToMinutes(now, PLANNING.ROUND_MINUTES) : workingStart;
  if (isToday && planningContext.unavailableUntil && planningContext.unavailableUntil > effectiveStart) {
    effectiveStart = roundUpToMinutes(planningContext.unavailableUntil, PLANNING.ROUND_MINUTES);
  }
  const hasTimeRemaining = effectiveStart < workingEnd;
  const weekday = weekdayOfDateString(targetDate);

  const occupied: TimeSlot[] = [...(options.preoccupied ?? [])];
  const overlapsOccupied = (start: Date, end: Date) => occupied.some(o => start < o.end && o.start < end);
  const prettyKey = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  log.info({ targetDate, tasks: tasks.length, effectiveStart: effectiveStart.toISOString(), preoccupied: occupied.length }, 'Planning schedule');

  // Step 0: recovery window when the user is running on empty
  if (isToday && hasTimeRemaining && hasLowEnergy(planningContext) && planningContext.recoveryMinutes) {
    const recoveryStart = effectiveStart;
    const recoveryEnd = addMinutes(recoveryStart, planningContext.recoveryMinutes);
    const clampedEnd = recoveryEnd < workingEnd ? recoveryEnd : workingEnd;
    if (clampedEnd.getTime() - recoveryStart.getTime() >= 10 * 60 * 1000 && !overlapsOccupied(recoveryStart, clampedEnd)) {
      occupied.push({ start: recoveryStart, end: clampedEnd });
      entries.push({
        title: 'Recovery reset',
        description: planningContext.reason ?? 'Low-energy recovery window before resuming planned work.',
        startTime: recoveryStart,
        endTime: clampedEnd,
        status: ScheduleEntryStatus.SCHEDULED,
        priority: 4,
        isFixed: false,
        flexibility: 0.4,
        kind: RECOVERY_KIND,
      });
    }
  }

  // Step 1: constraints (fixed commitments)
  for (const constraint of memory.constraints) {
    if (!constraint.isActive) continue;
    if (constraint.expiresOn && constraint.expiresOn < targetDate) continue;
    if (constraint.specificDate && formatDateString(constraint.specificDate, tz) !== targetDate) continue;
    if (!constraint.specificDate && !dayApplies(constraint.days, weekday)) continue;
    if (isAllDayRange(constraint.timeRange)) continue;

    const start = at(constraint.timeRange.start);
    const end = at(constraint.timeRange.end);
    if (end <= start) continue;
    if (isToday && end <= now) continue;
    if (overlapsOccupied(start, end)) continue; // already preserved by the replanner

    occupied.push({ start, end });
    entries.push({
      title: prettyKey(constraint.key),
      description: constraint.description,
      startTime: start,
      endTime: end,
      status: ScheduleEntryStatus.SCHEDULED,
      priority: 5,
      isFixed: true,
      flexibility: 0,
      kind: 'constraint',
    });
  }

  // Step 2: habits (soft routines)
  const habitEntries: IScheduleEntry[] = [];
  for (const habit of memory.habits) {
    if (!habit.isActive) continue;
    if (!dayApplies(habit.days, weekday)) continue;
    if (isAllDayRange(habit.timeRange)) continue;

    const start = at(habit.timeRange.start);
    const end = at(habit.timeRange.end);
    if (end <= start) continue;
    if (isToday && end <= now) continue;
    if (overlapsOccupied(start, end)) continue;

    occupied.push({ start, end });
    const entry: IScheduleEntry = {
      title: prettyKey(habit.key),
      description: habit.description,
      startTime: start,
      endTime: end,
      status: ScheduleEntryStatus.SCHEDULED,
      priority: 3,
      isFixed: false,
      flexibility: 0.3,
      kind: 'habit',
    };
    entries.push(entry);
    habitEntries.push(entry);
  }

  // Step 3: split tasks
  const eligible = tasks
    .map(task => ({ task, elig: taskEligibility(task, targetDate, tz) }))
    .filter(x => x.elig.eligible);

  const fixedTasks = eligible.filter(x => x.task.isFixed && x.task.fixedStartTime && x.task.fixedEndTime);
  const flexibleTasks = eligible.filter(x => !(x.task.isFixed && x.task.fixedStartTime && x.task.fixedEndTime));

  for (const { task } of fixedTasks) {
    const start = at(task.fixedStartTime!);
    const end = at(task.fixedEndTime!);
    if (end <= start) continue;
    if (isAllDayRange({ start: task.fixedStartTime, end: task.fixedEndTime })) continue;
    if (isToday && end <= now) {
      log.debug({ task: task.title }, 'Skipping fixed task — already past');
      continue;
    }
    if (overlapsOccupied(start, end)) {
      unscheduled.push({ taskId: String(task._id), title: task.title, reason: 'conflict' });
      continue;
    }
    occupied.push({ start, end });
    entries.push({
      taskId: task._id as mongoose.Types.ObjectId,
      title: task.title,
      description: task.description,
      startTime: start,
      endTime: end,
      status: ScheduleEntryStatus.SCHEDULED,
      priority: task.priority,
      isFixed: true,
      flexibility: 0,
      kind: 'task',
    });
  }

  if (!hasTimeRemaining) {
    for (const { task } of flexibleTasks) {
      unscheduled.push({ taskId: String(task._id), title: task.title, reason: 'no_time_left' });
    }
    entries.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    log.info({ targetDate, entries: entries.length, unscheduled: unscheduled.length }, 'Past working hours — fixed entries only');
    return { entries, unscheduled };
  }

  // Step 4: order flexible tasks (blueprint order when available, else score)
  const primary = flexibleTasks.filter(x => !x.elig.ahead);
  const ahead = flexibleTasks.filter(x => x.elig.ahead);

  let blueprint: ScheduleBlueprint | null = null;
  if (options.useBlueprint !== false && primary.length >= PLANNING.BLUEPRINT_MIN_TASKS) {
    blueprint = await getBlueprint(primary.map(x => x.task), memory, config, targetDate);
  }

  const order = (list: typeof flexibleTasks) => list
    .map(x => {
      const bp = blueprint?.tasks.find(bt => bt.taskId === String(x.task._id));
      const bpScore = bp ? 1000 - blueprint!.tasks.indexOf(bp) : 0;
      return { ...x, blueprint: bp, score: bpScore > 0 ? bpScore : scoreTask(x.task, x.elig) };
    })
    .sort((a, b) => b.score - a.score);

  const queue = [...order(primary), ...order(ahead)];

  // Capacity
  const totalWorkingMinutes = (workingEnd.getTime() - effectiveStart.getTime()) / 60_000;
  const maxFlexMinutes = totalWorkingMinutes * (1 - config.slackPercentage / 100);
  let allocatedFlexMinutes = 0;
  const multiplier = estimateMultiplier(memory);
  const workoutBoost = getPreference(memory, PREFERENCE_KEYS.WORKOUT_BOOSTS_FOCUS) === 'yes';
  const workoutEntry = workoutBoost
    ? habitEntries.find(h => /gym|workout|exercise|run|training|yoga|swim/i.test(h.title))
    : undefined;

  // Step 5: allocate
  for (const item of queue) {
    const { task, elig } = item;
    const taskId = String(task._id);
    const duration = Math.max(5, Math.ceil((task.estimatedMinutes * multiplier) / PLANNING.ROUND_MINUTES) * PLANNING.ROUND_MINUTES);

    if (elig.ahead && allocatedFlexMinutes >= maxFlexMinutes * PLANNING.AHEAD_FILL_RATIO) {
      unscheduled.push({ taskId, title: task.title, reason: 'not_due_yet' });
      continue;
    }

    if (isToday && isDepleted(planningContext) && task.cognitiveLoad >= 3 && !elig.dueToday && !elig.overdue) {
      unscheduled.push({ taskId, title: task.title, reason: 'low_energy' });
      continue;
    }

    if (allocatedFlexMinutes + duration > maxFlexMinutes) {
      unscheduled.push({ taskId, title: task.title, reason: 'overload' });
      continue;
    }

    const bufferedSlots = occupied.map(s => ({ start: addMinutes(s.start, -config.bufferMinutes), end: addMinutes(s.end, config.bufferMinutes) }));
    const availableSlots = findAvailableSlots(bufferedSlots, effectiveStart, workingEnd, duration);

    let window = getPreferredWindow(task, memory, effectiveStart, workingEnd, planningContext, at);
    if (item.blueprint && item.blueprint.assignedBlock !== 'any') {
      window = blockWindow(item.blueprint.assignedBlock, effectiveStart, workingEnd, at);
    }
    if (workoutEntry && task.cognitiveLoad >= 3 && workoutEntry.endTime < workingEnd) {
      const start = addMinutes(workoutEntry.endTime, config.bufferMinutes);
      const end = addMinutes(start, 180);
      window = { idealStart: start, idealEnd: end < workingEnd ? end : workingEnd };
    }

    const start = chooseStart(availableSlots, duration, window);
    if (!start) {
      unscheduled.push({ taskId, title: task.title, reason: 'no_slot' });
      continue;
    }

    const end = addMinutes(start, duration);
    occupied.push({ start, end });
    allocatedFlexMinutes += duration;

    entries.push({
      taskId: task._id as mongoose.Types.ObjectId,
      title: task.title,
      description: task.description,
      startTime: start,
      endTime: end,
      status: ScheduleEntryStatus.SCHEDULED,
      priority: task.priority,
      isFixed: false,
      flexibility: 0.7,
      kind: 'task',
    });

    if (task.cognitiveLoad >= 3 && duration >= 50) {
      const breakMinutes = Math.max(10, Math.min(20, config.bufferMinutes));
      const breakEnd = addMinutes(end, breakMinutes);
      if (breakEnd <= workingEnd && !overlapsOccupied(end, breakEnd)) {
        occupied.push({ start: end, end: breakEnd });
        entries.push({
          title: 'Recovery break',
          description: 'Short buffer after deep work to reduce context-switching fatigue.',
          startTime: end,
          endTime: breakEnd,
          status: ScheduleEntryStatus.SCHEDULED,
          priority: 2,
          isFixed: false,
          flexibility: 0.8,
          kind: BREAK_KIND,
        });
      }
    }
  }

  entries.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  log.info({ targetDate, entries: entries.length, allocatedMinutes: allocatedFlexMinutes, unscheduled: unscheduled.length }, 'Schedule planned');
  return { entries, unscheduled };
}

// ─── Window helpers ───────────────────────────────────────────────────────────

function blockWindow(block: TimeBlock, effectiveStart: Date, workingEnd: Date, at: (t: string) => Date): Window {
  const [s, e] = BLOCK_HOURS[block];
  const start = at(s);
  const end = at(e);
  const idealStart = start > effectiveStart ? start : effectiveStart;
  const idealEnd = end < workingEnd ? end : workingEnd;
  return idealStart < idealEnd ? { idealStart, idealEnd } : { idealStart: effectiveStart, idealEnd: workingEnd };
}

function getPreferredWindow(
  task: ITask,
  memory: RetrievedMemory,
  effectiveStart: Date,
  workingEnd: Date,
  ctx: PlanningContext,
  at: (t: string) => Date,
): Window {
  const whole: Window = { idealStart: effectiveStart, idealEnd: workingEnd };
  const block = (b: TimeBlock) => blockWindow(b, effectiveStart, workingEnd, at);

  // Explicit time on the task ("10:00", "10am") → a 3h window starting there
  const explicitTime = normalizeTimeString(task.preferredTime);
  if (explicitTime) {
    const s = at(explicitTime);
    const start = s > effectiveStart ? s : effectiveStart;
    const end = addMinutes(start, 180) < workingEnd ? addMinutes(start, 180) : workingEnd;
    if (start < end) return { idealStart: start, idealEnd: end };
  }
  const explicitBlock = inferBlockFromText(task.preferredTime);
  if (explicitBlock) return block(explicitBlock);

  const focus = learnedFocusBlock(memory);
  const low = lowSuccessBlock(memory);

  if (task.cognitiveLoad >= 3 && hasLowEnergy(ctx)) {
    const later = addMinutes(effectiveStart, 120);
    const four = at('16:00');
    const start = later > four ? later : four;
    return start < workingEnd ? { idealStart: start, idealEnd: workingEnd } : whole;
  }

  if (task.cognitiveLoad >= 2 && focus && focus !== low) return block(focus);
  if (task.cognitiveLoad >= 3 && low) return block(nextBlockAfter(low));
  if (task.cognitiveLoad >= 3) return block('morning');

  if (task.cognitiveLoad <= 1) {
    const s = at('14:00');
    return s > effectiveStart && s < workingEnd ? { idealStart: s, idealEnd: workingEnd } : whole;
  }

  return whole;
}

/**
 * Earliest start inside the preferred window. If nothing fits there, take the candidate
 * start (earliest or latest within each free slot) that lands closest to the window —
 * a night owl's 2.5h block should end at the day's end, not start at 11:40.
 */
function chooseStart(slots: TimeSlot[], durationMinutes: number, window: Window): Date | null {
  const durMs = durationMinutes * 60_000;
  for (const slot of slots) {
    const s = slot.start > window.idealStart ? slot.start : window.idealStart;
    const e = slot.end < window.idealEnd ? slot.end : window.idealEnd;
    if (e.getTime() - s.getTime() >= durMs) return s;
  }

  let best: Date | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const ws = window.idealStart.getTime();
  const we = window.idealEnd.getTime();
  for (const slot of slots) {
    if (slot.end.getTime() - slot.start.getTime() < durMs) continue;
    const candidates = [slot.start, new Date(slot.end.getTime() - durMs)];
    for (const c of candidates) {
      const t = c.getTime();
      const distance = t >= ws && t < we ? 0 : Math.min(Math.abs(t - ws), Math.abs(t - we));
      if (distance < bestDistance || (distance === bestDistance && best && t < best.getTime())) {
        bestDistance = distance;
        best = c;
      }
    }
  }
  return best;
}
