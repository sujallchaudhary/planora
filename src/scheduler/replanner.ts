import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import type { PlanningContext } from './planning-context.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { planSchedule, type PlanResult } from './planner.js';
import type { TimeSlot } from './time-slots.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('replanner');

/**
 * Partial replanner — minimally adjusts an existing schedule.
 *
 * - Completed, active and past entries are kept as a record.
 * - Fixed / low-flexibility future entries are kept unless stability is 'free'.
 * - Skipped entries are dropped and their task is excluded for the day.
 * - Missed entries are kept as a record but their task is re-fitted later in the day.
 * - Everything kept is passed to the planner as pre-occupied time, so new entries
 *   are placed *around* it instead of being silently dropped.
 */
export async function replan(
  tasks: ITask[],
  existingEntries: IScheduleEntry[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
  planningContext: PlanningContext = {},
): Promise<PlanResult> {
  const now = new Date();
  const keepStable = planningContext.scheduleStability !== 'free';

  const preserved: IScheduleEntry[] = [];
  const excludeTaskIds = new Set<string>();
  const preoccupied: TimeSlot[] = [];

  for (const entry of existingEntries) {
    const start = new Date(entry.startTime);
    const end = new Date(entry.endTime);
    const isPast = end <= now;
    const taskId = entry.taskId ? entry.taskId.toString() : null;

    switch (entry.status) {
      case ScheduleEntryStatus.SKIPPED:
        if (taskId) excludeTaskIds.add(taskId);
        continue;

      case ScheduleEntryStatus.MISSED:
        preserved.push(entry); // keep the record, but let the task be re-fitted
        continue;

      case ScheduleEntryStatus.COMPLETED:
        preserved.push(entry);
        if (taskId) excludeTaskIds.add(taskId);
        if (end > now) preoccupied.push({ start, end });
        continue;

      case ScheduleEntryStatus.ACTIVE:
        preserved.push(entry);
        if (taskId) excludeTaskIds.add(taskId);
        // Someone is working on this right now — keep the slot (and a little tail if it overran).
        preoccupied.push({ start, end: end > now ? end : new Date(now.getTime() + 15 * 60_000) });
        continue;

      default: {
        // scheduled
        if (isPast) {
          if (taskId) {
            // Never started and the slot is gone: treat as missed so it gets re-fitted.
            preserved.push({ ...(toPlain(entry)), status: ScheduleEntryStatus.MISSED });
          } else {
            preserved.push(entry);
          }
          continue;
        }
        const stable = keepStable && (entry.isFixed || entry.flexibility <= 0.35);
        if (stable) {
          preserved.push(entry);
          if (taskId) excludeTaskIds.add(taskId);
          preoccupied.push({ start, end });
        }
        // Flexible future entries are simply re-planned.
      }
    }
  }

  const remainingTasks = tasks.filter(t => !excludeTaskIds.has(String(t._id)));

  log.info({ targetDate, existing: existingEntries.length, preserved: preserved.length, remainingTasks: remainingTasks.length }, 'Starting partial replan');

  const result = await planSchedule(remainingTasks, memory, config, targetDate, planningContext, { preoccupied, now });

  // Safety net: the planner already avoids preoccupied slots, but never let two live entries overlap.
  const liveFuture = preserved.filter(p => new Date(p.endTime) > now && p.status !== ScheduleEntryStatus.MISSED);
  const safeNew = result.entries.filter(e => {
    const clash = liveFuture.some(p => new Date(e.startTime) < new Date(p.endTime) && new Date(p.startTime) < new Date(e.endTime));
    if (clash) log.warn({ title: e.title }, 'Dropped overlapping entry during replan');
    return !clash;
  });

  const merged = [...preserved, ...safeNew];
  merged.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  log.info({ preserved: preserved.length, newEntries: safeNew.length, total: merged.length, unscheduled: result.unscheduled.length }, 'Partial replan complete');

  return { entries: merged, unscheduled: result.unscheduled };
}

function toPlain(entry: IScheduleEntry): IScheduleEntry {
  const anyEntry = entry as any;
  return typeof anyEntry.toObject === 'function' ? anyEntry.toObject() : { ...entry };
}
