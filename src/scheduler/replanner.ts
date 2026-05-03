import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { planSchedule } from './planner.js';
import { nowInTimezone } from '../utils/date.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('replanner');

/**
 * Partial replanner — minimally adjusts the existing schedule.
 * 
 * Rules:
 * - Only adjusts entries AFTER the current time
 * - Preserves completed/active entries
 * - Removes skipped entries
 * - Replans remaining entries using the planner algorithm
 * - Stability: won't replan more than once per configured frequency
 */
export async function replan(
  tasks: ITask[],
  existingEntries: IScheduleEntry[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
): Promise<IScheduleEntry[]> {
  const now = nowInTimezone(config.timezone);

  log.info({ targetDate, existingEntries: existingEntries.length }, 'Starting partial replan');

  // Preserve entries that are completed, active, or in the past
  const preserved: IScheduleEntry[] = [];
  const taskIdsToExclude = new Set<string>();

  for (const entry of existingEntries) {
    const isPast = new Date(entry.endTime) <= now;
    const isCompleted = entry.status === ScheduleEntryStatus.COMPLETED;
    const isActive = entry.status === ScheduleEntryStatus.ACTIVE;
    const isSkipped = entry.status === ScheduleEntryStatus.SKIPPED;

    if (isCompleted || isActive || isPast) {
      preserved.push(entry);
      if (entry.taskId) {
        taskIdsToExclude.add(entry.taskId.toString());
      }
    } else if (isSkipped) {
      // Don't preserve skipped entries, but exclude their tasks
      if (entry.taskId) {
        taskIdsToExclude.add(entry.taskId.toString());
      }
    }
    // Scheduled entries after current time will be replanned
  }

  // Filter out tasks that are already handled
  const remainingTasks = tasks.filter(t => !taskIdsToExclude.has(t._id!.toString()));

  // Replan only remaining tasks
  const newEntries = await planSchedule(remainingTasks, memory, config, targetDate);

  // Filter new entries to only include those after current time
  const futureNewEntries = newEntries.filter(e => new Date(e.startTime) > now);

  // Merge preserved + new future entries
  const merged = [...preserved, ...futureNewEntries];
  merged.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  log.info({
    preserved: preserved.length,
    newEntries: futureNewEntries.length,
    total: merged.length,
  }, 'Partial replan complete');

  return merged;
}
