import { addMinutes } from 'date-fns';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import type { PlanningContext } from './planning-context.js';
import { hasLowEnergy } from './planning-context.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { parseTimeString, formatDateString } from '../utils/date.js';
import { findAvailableSlots, type TimeSlot, fitsInSlot } from './time-slots.js';
import { getLLMProvider } from '../llm/openai-compatible.provider.js';
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

function blockWindow(
  block: 'morning' | 'afternoon' | 'evening' | 'night' | 'any',
  workingStart: Date,
  workingEnd: Date,
): { idealStart: Date; idealEnd: Date } {
  if (block === 'any') return { idealStart: workingStart, idealEnd: workingEnd };

  const start = new Date(workingStart);
  const end = new Date(workingStart);

  if (block === 'morning') {
    start.setHours(6, 0, 0, 0);
    end.setHours(12, 0, 0, 0);
  } else if (block === 'afternoon') {
    start.setHours(12, 0, 0, 0);
    end.setHours(17, 0, 0, 0);
  } else if (block === 'evening') {
    start.setHours(17, 0, 0, 0);
    end.setHours(22, 0, 0, 0);
  } else {
    start.setHours(20, 0, 0, 0);
    end.setHours(23, 59, 0, 0);
  }

  const idealStart = start > workingStart ? start : workingStart;
  const idealEnd = end < workingEnd ? end : workingEnd;
  return idealStart < idealEnd
    ? { idealStart, idealEnd }
    : { idealStart: workingStart, idealEnd: workingEnd };
}

function inferBlockFromText(value: string | undefined): 'morning' | 'afternoon' | 'evening' | 'night' | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes('late night') || text.includes('night')) return 'night';
  if (text.includes('evening')) return 'evening';
  if (text.includes('afternoon')) return 'afternoon';
  if (text.includes('morning')) return 'morning';
  return null;
}

function getPreference(memory: RetrievedMemory, key: string): string | undefined {
  return memory.preferences.find(p => p.key === key)?.value;
}

function getLearnedFocusBlock(memory: RetrievedMemory): 'morning' | 'afternoon' | 'evening' | 'night' | null {
  return inferBlockFromText(getPreference(memory, 'peak_focus_window'))
    ?? inferBlockFromText(getPreference(memory, 'deep_work_time'))
    ?? inferBlockFromText(getPreference(memory, 'study_time'));
}

function getLowSuccessBlock(memory: RetrievedMemory): 'morning' | 'afternoon' | 'evening' | 'night' | null {
  return inferBlockFromText(getPreference(memory, 'low_success_window'))
    ?? (getPreference(memory, 'morning_task_difficulty') === 'high' ? 'morning' : null);
}

/**
 * Determine preferred time window for a task based on cognitive load and user preferences.
 */
function getPreferredWindow(
  task: ITask,
  memory: RetrievedMemory,
  workingStart: Date,
  workingEnd: Date,
  planningContext?: PlanningContext,
): { idealStart: Date; idealEnd: Date } {
  const explicitTaskBlock = inferBlockFromText(task.preferredTime);
  if (explicitTaskBlock) {
    return blockWindow(explicitTaskBlock, workingStart, workingEnd);
  }

  const learnedFocusBlock = getLearnedFocusBlock(memory);
  const lowSuccessBlock = getLowSuccessBlock(memory);

  if (task.cognitiveLoad >= 3 && hasLowEnergy(planningContext)) {
    const later = new Date(workingStart);
    later.setHours(Math.max(later.getHours() + 2, 16), 0, 0, 0);
    return { idealStart: later < workingEnd ? later : workingStart, idealEnd: workingEnd };
  }

  if (task.cognitiveLoad >= 2 && learnedFocusBlock && learnedFocusBlock !== lowSuccessBlock) {
    return blockWindow(learnedFocusBlock, workingStart, workingEnd);
  }

  if (task.cognitiveLoad >= 3 && lowSuccessBlock === 'morning') {
    return blockWindow('evening', workingStart, workingEnd);
  }

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
  planningContext: PlanningContext = {},
): Promise<IScheduleEntry[]> {
  const entries: IScheduleEntry[] = [];

  const [y, m, d] = targetDate.split('-').map(Number);
  const baseDateUTC = new Date(Date.UTC(y!, m! - 1, d!));

  const workingStart = parseTimeString(config.workingHours.start, targetDate, config.timezone);
  const workingEnd = parseTimeString(config.workingHours.end, targetDate, config.timezone);

  // Use the later of working hours start or current time for flexible task scheduling
  // This prevents scheduling tasks in the past (e.g. at 11:41 AM, don't schedule at 8 AM)
  const now = new Date();
  const effectiveStart = now > workingStart ? now : workingStart;

  log.info({ targetDate, tasks: tasks.length, effectiveStart: effectiveStart.toISOString() }, 'Planning schedule');

  // Guard: check if there's any working time left for flexible tasks
  const hasTimeRemaining = effectiveStart < workingEnd;

  // Request Schedule Blueprint from LLM — only if there are tasks AND time remaining
  let blueprint = null;
  if (tasks.length > 0 && hasTimeRemaining) {
    blueprint = await getLLMProvider().generateScheduleBlueprint(tasks, memory, config, targetDate);
  }

  // Step 1: Lock fixed constraints
  const occupiedSlots: TimeSlot[] = [];

  /** Convert snake_case key to Title Case for display */
  const prettyKey = (key: string) =>
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  if (hasTimeRemaining && hasLowEnergy(planningContext) && planningContext.recoveryMinutes) {
    const recoveryStart = effectiveStart;
    const recoveryEnd = addMinutes(recoveryStart, planningContext.recoveryMinutes);
    const clampedRecoveryEnd = recoveryEnd < workingEnd ? recoveryEnd : workingEnd;

    if (clampedRecoveryEnd.getTime() - recoveryStart.getTime() >= 10 * 60 * 1000) {
      occupiedSlots.push({ start: recoveryStart, end: clampedRecoveryEnd });
      entries.push({
        title: 'Recovery reset',
        description: planningContext.reason ?? 'Low-energy recovery window before resuming planned work.',
        startTime: recoveryStart,
        endTime: clampedRecoveryEnd,
        status: ScheduleEntryStatus.SCHEDULED,
        priority: 4,
        isFixed: false,
        flexibility: 0.4,
      } as IScheduleEntry);
    }
  }

  for (const constraint of memory.constraints) {
    const dayOfWeek = baseDateUTC.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = constraint.days.includes('daily') || constraint.days.includes(dayOfWeek);

    if (isApplicable && constraint.isActive) {
      const start = parseTimeString(constraint.timeRange.start, targetDate, config.timezone);
      const end = parseTimeString(constraint.timeRange.end, targetDate, config.timezone);
      
      const isAllDay = constraint.timeRange.start === '00:00' && constraint.timeRange.end === '23:59';
      if (!isAllDay) {
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
  }

  // Step 2: Lock habits
  for (const habit of memory.habits) {
    const dayOfWeek = baseDateUTC.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = habit.days.includes('daily') || habit.days.includes(dayOfWeek);

    if (isApplicable && habit.isActive) {
      const start = parseTimeString(habit.timeRange.start, targetDate, config.timezone);
      const end = parseTimeString(habit.timeRange.end, targetDate, config.timezone);
      
      const isAllDay = habit.timeRange.start === '00:00' && habit.timeRange.end === '23:59';
      if (!isAllDay) {
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
    
    const isAllDay = task.fixedStartTime === '00:00' && task.fixedEndTime === '23:59';
    const isPast = end <= now;
    
    if (!isAllDay && !isPast) {
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
    } else if (isPast) {
      log.debug({ task: task.title, end: end.toISOString() }, 'Skipping fixed task — already past');
    }
  }

  // Step 4: Sort flexible tasks
  // Use AI blueprint order if available, otherwise fallback to score
  const scoredTasks = flexibleTasks.map(t => {
    const blueprintTask = blueprint?.tasks.find(bt => bt.taskId === t._id?.toString());
    // Give blueprint tasks higher base priority to ensure they are scheduled first in the order the AI provided
    const blueprintScore = blueprintTask ? 1000 - blueprint!.tasks.indexOf(blueprintTask) : 0;
    return { task: t, score: blueprintScore > 0 ? blueprintScore : scoreTask(t), blueprint: blueprintTask };
  });
  scoredTasks.sort((a, b) => b.score - a.score);

  // Calculate slack time to leave
  const totalWorkingMinutes = hasTimeRemaining ? (workingEnd.getTime() - effectiveStart.getTime()) / (60 * 1000) : 0;
  const slackMinutes = totalWorkingMinutes * (config.slackPercentage / 100);
  let allocatedFlexMinutes = 0;
  const maxFlexMinutes = totalWorkingMinutes - slackMinutes;

  // Step 5: Allocate flexible tasks into available slots (only if time remains)
  if (!hasTimeRemaining) {
    log.info({ targetDate }, 'Past working hours — skipping flexible task allocation');
  }
  for (const taskData of scoredTasks) {
    if (!hasTimeRemaining) break;
    const { task } = taskData;
    if (allocatedFlexMinutes >= maxFlexMinutes) {
      log.debug({ task: task.title }, 'Slack limit reached, skipping task');
      break;
    }

    // Add buffer to occupied slots for gap calculation
    const bufferedSlots = occupiedSlots.map(s => ({
      start: s.start,
      end: addMinutes(s.end, config.bufferMinutes),
    }));

    const availableSlots = findAvailableSlots(bufferedSlots, effectiveStart, workingEnd, task.estimatedMinutes);
    
    // Determine preferred window
    let preferred = getPreferredWindow(task, memory, effectiveStart, workingEnd, planningContext);
    
    // Override with AI blueprint if available
    if (taskData.blueprint && taskData.blueprint.assignedBlock !== 'any') {
      const startHour = taskData.blueprint.assignedBlock === 'morning' ? 0 : taskData.blueprint.assignedBlock === 'afternoon' ? 12 : 17;
      const endHour = taskData.blueprint.assignedBlock === 'morning' ? 12 : taskData.blueprint.assignedBlock === 'afternoon' ? 17 : 24;
      
      const blockStart = new Date(workingStart);
      blockStart.setHours(startHour, 0, 0, 0);
      const blockEnd = new Date(workingStart);
      blockEnd.setHours(endHour, 0, 0, 0);
      
      const clampedStart = blockStart > workingStart ? blockStart : workingStart;
      const clampedEnd = blockEnd < workingEnd ? blockEnd : workingEnd;
      
      // Constrain within actual working hours
      preferred = {
        idealStart: clampedStart < clampedEnd ? clampedStart : workingStart,
        idealEnd: clampedStart < clampedEnd ? clampedEnd : workingEnd,
      };
    }

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

      if (task.cognitiveLoad >= 3 && task.estimatedMinutes >= 50) {
        const breakMinutes = Math.max(10, Math.min(20, config.bufferMinutes));
        const breakEnd = addMinutes(taskEnd, breakMinutes);
        if (breakEnd <= workingEnd) {
          occupiedSlots.push({ start: taskEnd, end: breakEnd });
          entries.push({
            title: 'Recovery break',
            description: 'Short buffer after deep work to reduce context-switching fatigue.',
            startTime: taskEnd,
            endTime: breakEnd,
            status: ScheduleEntryStatus.SCHEDULED,
            priority: 2,
            isFixed: false,
            flexibility: 0.8,
          } as IScheduleEntry);
        }
      }
    } else {
      log.debug({ task: task.title }, 'No available slot found');
    }
  }

  // Sort entries by start time
  entries.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  log.info({ entries: entries.length, allocatedMinutes: allocatedFlexMinutes }, 'Schedule planned');
  return entries;
}
