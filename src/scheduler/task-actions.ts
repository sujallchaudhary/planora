/**
 * Task lifecycle actions shared by the chat pipeline, inline buttons and workers.
 * Everything that changes a task's state goes through here so history, schedule
 * entries across days, recurrence and deferral stay consistent.
 */
import type { IUser } from '../memory/mongo/models/user.model.js';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { UserConfig } from '../config/config-resolver.js';
import { taskRepo } from '../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../memory/mongo/repositories/schedule.repo.js';
import { taskHistoryRepo } from '../memory/mongo/repositories/task-history.repo.js';
import { ScheduleEntryStatus, TaskStatus } from '../config/defaults.js';
import { addDaysToDateString, weekdayOfDateString, dateStringToDate, formatDateString } from '../utils/date.js';
import { normalizeDays } from '../memory/memory-utils.js';
import { taskEligibility } from './planner.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('task-actions');

const OPEN_ENTRY = [ScheduleEntryStatus.SCHEDULED, ScheduleEntryStatus.ACTIVE, ScheduleEntryStatus.MISSED] as string[];

export interface FoundEntry { entry: IScheduleEntry; date: string }

/** Find the schedule entry for a task on `date`, falling back to the previous day (late-night sessions). */
export async function findTaskEntry(telegramId: number, taskId: string, date: string): Promise<FoundEntry | null> {
  for (const d of [date, addDaysToDateString(date, -1)]) {
    const schedule = await scheduleRepo.findByDate(telegramId, d);
    const entry = schedule?.entries.find(e => e.taskId?.toString() === taskId && OPEN_ENTRY.includes(e.status));
    if (entry) return { entry, date: d };
  }
  return null;
}

/**
 * "done" with no task named: the task in progress, else the one whose slot just ended,
 * else the one starting imminently, else the only open task for today. Otherwise null.
 */
export async function inferCurrentTask(telegramId: number, today: string, timezone: string, now = new Date()): Promise<ITask | null> {
  const schedule = await scheduleRepo.findByDate(telegramId, today);
  const entries = (schedule?.entries ?? []).filter(e => e.taskId);

  const pick = async (entry?: IScheduleEntry) => {
    if (!entry?.taskId) return null;
    const task = await taskRepo.findById(entry.taskId.toString());
    return task && task.status !== TaskStatus.COMPLETED ? task : null;
  };

  const active = entries.find(e => e.status === ScheduleEntryStatus.ACTIVE);
  const fromActive = await pick(active);
  if (fromActive) return fromActive;

  const threeHours = 3 * 60 * 60_000;
  const justEnded = entries
    .filter(e => (e.status === ScheduleEntryStatus.SCHEDULED || e.status === ScheduleEntryStatus.MISSED) && new Date(e.endTime) <= now && now.getTime() - new Date(e.endTime).getTime() <= threeHours)
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0];
  const fromEnded = await pick(justEnded);
  if (fromEnded) return fromEnded;

  const imminent = entries
    .filter(e => e.status === ScheduleEntryStatus.SCHEDULED && new Date(e.startTime) > now && new Date(e.startTime).getTime() - now.getTime() <= 45 * 60_000)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0];
  const fromImminent = await pick(imminent);
  if (fromImminent) return fromImminent;

  const open = await taskRepo.findOpenTasksForDate(telegramId, today);
  const eligible = open.filter(t => taskEligibility(t, today, timezone).eligible);
  return eligible.length === 1 ? eligible[0]! : null;
}

/** The next task the user should start (for "next up" hints). */
export async function nextUpcomingEntry(telegramId: number, today: string, now = new Date()): Promise<IScheduleEntry | null> {
  const schedule = await scheduleRepo.findByDate(telegramId, today);
  return (schedule?.entries ?? [])
    .filter(e => e.status === ScheduleEntryStatus.SCHEDULED && new Date(e.endTime) > now)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0] ?? null;
}

export interface CompletionResult {
  task: ITask;
  entry?: IScheduleEntry;
  late: boolean;
  next?: ITask;
}

export async function completeTask(user: IUser, config: UserConfig, task: ITask, today: string, now = new Date()): Promise<CompletionResult> {
  const telegramId = user.telegramId;
  const taskId = String(task._id);
  const found = await findTaskEntry(telegramId, taskId, today);

  let actualMinutes: number | undefined;
  let late = false;

  if (found) {
    const start = new Date(found.entry.startTime).getTime();
    const end = new Date(found.entry.endTime).getTime();
    const planned = Math.max(5, (end - start) / 60_000);
    const elapsed = (now.getTime() - start) / 60_000;
    if (elapsed > 0 && elapsed <= planned * 3) actualMinutes = Math.round(elapsed);
    const delayMinutes = Math.round((now.getTime() - end) / 60_000);
    late = delayMinutes > 15;

    await taskHistoryRepo.record({
      userId: user._id as any,
      telegramId,
      taskId: task._id as any,
      title: task.title,
      scheduledDate: found.date,
      scheduledStartTime: found.entry.startTime,
      scheduledEndTime: found.entry.endTime,
      outcome: late ? 'completed_late' : 'completed',
      completedAt: now,
      delayMinutes: delayMinutes > 0 ? delayMinutes : undefined,
    });
  }

  await taskRepo.markCompleted(taskId, actualMinutes);
  await scheduleRepo.updateTaskEntriesStatus(telegramId, taskId, ScheduleEntryStatus.COMPLETED);

  const next = await createNextOccurrence(user, task, today, config.timezone);
  log.info({ telegramId, taskId, late, next: next ? String(next._id) : undefined }, 'Task completed');

  return { task, entry: found?.entry, late, next: next ?? undefined };
}

export interface SkipResult {
  task: ITask;
  entry?: IScheduleEntry;
  deferredUntil: string;
}

/** Skip a task for today: entry → skipped, task stays open and rolls to tomorrow. */
export async function skipTaskToday(user: IUser, task: ITask, today: string): Promise<SkipResult> {
  const telegramId = user.telegramId;
  const taskId = String(task._id);
  const tomorrow = addDaysToDateString(today, 1);
  const found = await findTaskEntry(telegramId, taskId, today);

  if (found && found.entry._id) {
    await scheduleRepo.updateEntryStatus(telegramId, found.date, found.entry._id.toString(), ScheduleEntryStatus.SKIPPED);
    await taskHistoryRepo.record({
      userId: user._id as any,
      telegramId,
      taskId: task._id as any,
      title: task.title,
      scheduledDate: found.date,
      scheduledStartTime: found.entry.startTime,
      scheduledEndTime: found.entry.endTime,
      outcome: 'skipped',
    });
  }

  await taskRepo.deferTask(taskId, tomorrow);
  return { task, entry: found?.entry, deferredUntil: tomorrow };
}

export function nextOccurrenceDate(task: ITask, fromDate: string): string | null {
  const pattern = task.recurrence?.pattern;
  if (!pattern) return null;
  if (pattern === 'daily') return addDaysToDateString(fromDate, 1);
  if (pattern === 'weekdays') {
    let d = addDaysToDateString(fromDate, 1);
    while (['saturday', 'sunday'].includes(weekdayOfDateString(d))) d = addDaysToDateString(d, 1);
    return d;
  }
  const days = normalizeDays(task.recurrence?.days);
  if (days.includes('daily')) return addDaysToDateString(fromDate, 7);
  for (let i = 1; i <= 7; i++) {
    const d = addDaysToDateString(fromDate, i);
    if (days.includes(weekdayOfDateString(d))) return d;
  }
  return addDaysToDateString(fromDate, 7);
}

/** For recurring tasks: queue the next occurrence once the current one is done. */
export async function createNextOccurrence(user: IUser, task: ITask, completedOn: string, timezone: string): Promise<ITask | null> {
  if (!task.recurrence?.pattern) return null;
  const base = task.dueDate ? formatDateString(task.dueDate, timezone) : completedOn;
  const from = base > completedOn ? base : completedOn;
  const nextStr = nextOccurrenceDate(task, from);
  if (!nextStr) return null;

  const { task: next, created } = await taskRepo.createIfNew({
    userId: user._id as any,
    telegramId: user.telegramId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    cognitiveLoad: task.cognitiveLoad,
    estimatedMinutes: task.estimatedMinutes,
    dueDate: dateStringToDate(nextStr, timezone),
    preferredTime: task.preferredTime,
    tags: task.tags,
    isFixed: task.isFixed,
    fixedStartTime: task.fixedStartTime,
    fixedEndTime: task.fixedEndTime,
    recurrence: task.recurrence,
    deferredUntil: nextStr,
  });
  return created ? next : null;
}
