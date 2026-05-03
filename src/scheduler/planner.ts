import { addMinutes } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { parseTimeString, formatDateString } from '../utils/date.js';
import { findAvailableSlots, type TimeSlot, fitsInSlot } from './time-slots.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('planner');

/**
 * Score a task for priority scheduling.
 * Higher score = schedule earlier in the day.
 */
function scoreTask(task: ITask): number {
  const priorityWeight = 3;
  const cognitiveWeight = 2;
  const urgencyWeight = 2;

  let urgency = 1;
  if (task.dueDate) {
    const daysUntilDue = Math.max(0, (task.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysUntilDue <= 1) urgency = 5;
    else if (daysUntilDue <= 3) urgency = 3;
    else if (daysUntilDue <= 7) urgency = 2;
  }

  return (task.priority * priorityWeight) + (task.cognitiveLoad * cognitiveWeight) + (urgency * urgencyWeight);
}

/**
 * Determine preferred time window for a task based on cognitive load and user preferences.
 */
function getPreferredWindow(
  task: ITask,
  memory: RetrievedMemory,
  workingStart: Date,
  workingEnd: Date,
): { idealStart: Date; idealEnd: Date } {
  // Check if user has deep work time preference
  const deepWorkPref = memory.preferences.find(p => p.key === 'deep_work_time');

  if (task.cognitiveLoad >= 3) {
    // High cognitive load → morning by default, or user preference
    if (deepWorkPref?.value === 'evening') {
      const evening = new Date(workingStart);
      evening.setHours(18, 0, 0, 0);
      return { idealStart: evening, idealEnd: workingEnd };
    }
    // Default: morning window
    const morningEnd = new Date(workingStart);
    morningEnd.setHours(12, 0, 0, 0);
    return { idealStart: workingStart, idealEnd: morningEnd };
  }

  if (task.cognitiveLoad <= 1) {
    // Low cognitive load → afternoon/evening
    const afternoonStart = new Date(workingStart);
    afternoonStart.setHours(14, 0, 0, 0);
    return { idealStart: afternoonStart, idealEnd: workingEnd };
  }

  // Medium → any time
  return { idealStart: workingStart, idealEnd: workingEnd };
}

/**
 * Core deterministic scheduling algorithm.
 * 
 * Algorithm:
 * 1. Lock fixed constraints (classes, meetings)
 * 2. Lock habits (daily nap, gym) at their preferred times
 * 3. Score remaining tasks by priority × urgency × cognitive_demand
 * 4. Allocate high-cognitive tasks into optimal time windows
 * 5. Fill remaining slots with lower-priority tasks
 * 6. Insert buffers and leave slack time
 */
export async function planSchedule(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
): Promise<IScheduleEntry[]> {
  const entries: IScheduleEntry[] = [];

  const [y, m, d] = targetDate.split('-').map(Number);
  const baseDateUTC = new Date(Date.UTC(y!, m! - 1, d!));

  const workingStart = parseTimeString(config.workingHours.start, targetDate, config.timezone);
  const workingEnd = parseTimeString(config.workingHours.end, targetDate, config.timezone);

  log.info({ targetDate, tasks: tasks.length }, 'Planning schedule');

  // Step 1: Lock fixed constraints
  const occupiedSlots: TimeSlot[] = [];

  /** Convert snake_case key to Title Case for display */
  const prettyKey = (key: string) =>
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  for (const constraint of memory.constraints) {
    const dayOfWeek = baseDateUTC.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = constraint.days.includes('daily') || constraint.days.includes(dayOfWeek);

    if (isApplicable && constraint.isActive) {
      const start = parseTimeString(constraint.timeRange.start, targetDate, config.timezone);
      const end = parseTimeString(constraint.timeRange.end, targetDate, config.timezone);
      occupiedSlots.push({ start, end });
      entries.push({
        title: prettyKey(constraint.key),
        description: constraint.description,
        startTime: start,
        endTime: end,
        status: ScheduleEntryStatus.SCHEDULED,
        priority: 5,
        isFixed: true,
        flexibility: 0,
      } as IScheduleEntry);
    }
  }

  // Step 2: Lock habits
  for (const habit of memory.habits) {
    const dayOfWeek = baseDateUTC.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = habit.days.includes('daily') || habit.days.includes(dayOfWeek);

    if (isApplicable && habit.isActive) {
      const start = parseTimeString(habit.timeRange.start, targetDate, config.timezone);
      const end = parseTimeString(habit.timeRange.end, targetDate, config.timezone);
      occupiedSlots.push({ start, end });
      entries.push({
        title: prettyKey(habit.key),
        description: habit.description,
        startTime: start,
        endTime: end,
        status: ScheduleEntryStatus.SCHEDULED,
        priority: 3,
        isFixed: false,
        flexibility: 0.3,
      } as IScheduleEntry);
    }
  }

  // Step 3: Filter tasks and lock fixed-time tasks for TODAY
  const validTasks = tasks.filter(t => {
    // If a task is fixed and has a specific date, it MUST match the targetDate
    if (t.isFixed && t.dueDate) {
      const taskDateStr = formatDateString(t.dueDate, config.timezone);
      if (taskDateStr !== targetDate) {
        return false;
      }
    }
    // For flexible tasks, we could also filter them out if their due date is in the future
    // and we only want to do them ON that date, but for now we leave them to be scheduled
    // if there is free time, unless they are specifically fixed for another day.
    return true;
  });

  const fixedTasks = validTasks.filter(t => t.isFixed && t.fixedStartTime && t.fixedEndTime);
  const flexibleTasks = validTasks.filter(t => !t.isFixed);

  for (const task of fixedTasks) {
    const start = parseTimeString(task.fixedStartTime!, targetDate, config.timezone);
    const end = parseTimeString(task.fixedEndTime!, targetDate, config.timezone);
    occupiedSlots.push({ start, end });
    entries.push({
      taskId: task._id,
      title: task.title,
      description: task.description,
      startTime: start,
      endTime: end,
      status: ScheduleEntryStatus.SCHEDULED,
      priority: task.priority,
      isFixed: true,
      flexibility: 0,
    } as IScheduleEntry);
  }

  // Step 4: Sort flexible tasks by score (highest first)
  const scoredTasks = flexibleTasks.map(t => ({ task: t, score: scoreTask(t) }));
  scoredTasks.sort((a, b) => b.score - a.score);

  // Calculate slack time to leave
  const totalWorkingMinutes = (workingEnd.getTime() - workingStart.getTime()) / (60 * 1000);
  const slackMinutes = totalWorkingMinutes * (config.slackPercentage / 100);
  let allocatedFlexMinutes = 0;
  const maxFlexMinutes = totalWorkingMinutes - slackMinutes;

  // Step 5: Allocate flexible tasks into available slots
  for (const { task } of scoredTasks) {
    if (allocatedFlexMinutes >= maxFlexMinutes) {
      log.debug({ task: task.title }, 'Slack limit reached, skipping task');
      break;
    }

    // Add buffer to occupied slots for gap calculation
    const bufferedSlots = occupiedSlots.map(s => ({
      start: s.start,
      end: addMinutes(s.end, config.bufferMinutes),
    }));

    const availableSlots = findAvailableSlots(bufferedSlots, workingStart, workingEnd, task.estimatedMinutes);
    const preferred = getPreferredWindow(task, memory, workingStart, workingEnd);

    // Try to find a slot in the preferred window first
    let bestSlot: TimeSlot | null = null;
    for (const slot of availableSlots) {
      if (fitsInSlot(slot, task.estimatedMinutes)) {
        // Prefer slots that overlap with the ideal window
        if (slot.start >= preferred.idealStart && slot.start < preferred.idealEnd) {
          bestSlot = slot;
          break;
        }
        if (!bestSlot) {
          bestSlot = slot;
        }
      }
    }

    if (bestSlot) {
      const taskStart = bestSlot.start;
      const taskEnd = addMinutes(taskStart, task.estimatedMinutes);

      occupiedSlots.push({ start: taskStart, end: taskEnd });
      allocatedFlexMinutes += task.estimatedMinutes;

      entries.push({
        taskId: task._id,
        title: task.title,
        description: task.description,
        startTime: taskStart,
        endTime: taskEnd,
        status: ScheduleEntryStatus.SCHEDULED,
        priority: task.priority,
        isFixed: false,
        flexibility: 0.7,
      } as IScheduleEntry);
    } else {
      log.debug({ task: task.title }, 'No available slot found');
    }
  }

  // Sort entries by start time
  entries.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  log.info({ entries: entries.length, allocatedMinutes: allocatedFlexMinutes }, 'Schedule planned');
  return entries;
}
