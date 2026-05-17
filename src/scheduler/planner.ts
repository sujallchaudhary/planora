import mongoose from 'mongoose';
import { generateObject } from 'ai';
import { z } from 'zod';
import { reasoningModel } from '../llm/ai-provider.js';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { parseTimeString, formatDateString } from '../utils/date.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('planner');

// ─── Planning context (passed by callers to influence scheduling) ──────────────
export type ScheduleStability = 'preserve' | 'moderate' | 'free';

export interface PlanningContext {
  trigger?: string;
  reason?: string;
  energyLevel?: number; // 1 = depleted, 5 = high energy
  recoveryMinutes?: number;
  scheduleStability?: ScheduleStability;
}

// ─── Zod schema for the LLM-generated schedule ────────────────────────────────
const ScheduleOutputSchema = z.object({
  entries: z.array(z.object({
    taskId: z.string().nullable().describe('MongoDB _id of the task, if this entry corresponds to a task. null for habits/constraints/breaks.'),
    title: z.string(),
    description: z.string().describe('Brief description of the entry'),
    startTime: z.string().describe('Start time in HH:mm format'),
    endTime: z.string().describe('End time in HH:mm format'),
    priority: z.number().min(1).max(5).describe('1=low, 5=critical'),
    isFixed: z.boolean().describe('Whether this entry has a fixed time slot'),
    flexibility: z.number().min(0).max(1).describe('0 = immovable, 1 = very flexible'),
  })),
  reasoning: z.string().describe('Brief explanation of the scheduling strategy'),
});

// ─── Prompt builder ────────────────────────────────────────────────────────────
function buildPlannerPrompt(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
  planningContext: PlanningContext = {},
): string {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

  const taskList = tasks.map(t => {
    const daysUntilDue = t.dueDate
      ? Math.max(0, Math.ceil((t.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;
    const urgency = daysUntilDue !== null
      ? (daysUntilDue <= 1 ? '🔴 DUE TODAY/TOMORROW' : daysUntilDue <= 3 ? '🟡 DUE SOON' : `📅 ${daysUntilDue}d away`)
      : '';
    const fixed = t.isFixed && t.fixedStartTime && t.fixedEndTime
      ? ` | FIXED: ${t.fixedStartTime}–${t.fixedEndTime}`
      : '';
    const preferred = t.preferredTime ? ` | Preferred: ${t.preferredTime}` : '';
    return `  - [ID: ${t._id}] "${t.title}" | Priority: ${t.priority}/5 | Cognitive: ${t.cognitiveLoad}/3 | ${t.estimatedMinutes}min${fixed}${preferred} ${urgency}`;
  }).join('\n');

  const constraintList = memory.constraints.filter(c => c.isActive).map(c => {
    const dayOfWeek = new Date(targetDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = c.days.includes('daily') || c.days.includes(dayOfWeek);
    if (!isApplicable) return null;

    // Skip full-day constraints (00:00–23:59 or similar) — they block everything and make planning useless.
    // Instead, mention them as context but not as hard blockers.
    const isFullDay = (c.timeRange.start === '00:00' && (c.timeRange.end === '23:59' || c.timeRange.end === '23:00'));
    if (isFullDay) {
      return `  - ${c.key}: ${c.description || c.key} (all day — for context only, still schedule tasks around other commitments)`;
    }

    return `  - ${c.key}: ${c.description || c.key} (${c.timeRange.start}–${c.timeRange.end}) [BLOCKED — cannot schedule tasks here]`;
  }).filter(Boolean).join('\n');

  const habitList = memory.habits.filter(h => h.isActive).map(h => {
    const dayOfWeek = new Date(targetDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const isApplicable = h.days.includes('daily') || h.days.includes(dayOfWeek);
    if (!isApplicable) return null;

    // Full-day habits (00:00–23:59) are just labels, not real time blocks — treat as context
    const isFullDay = (h.timeRange.start === '00:00' && (h.timeRange.end === '23:59' || h.timeRange.end === '23:00'));
    if (isFullDay) {
      return `  - ${h.key}: ${h.description || h.key} (ongoing — weave into schedule as appropriate)`;
    }

    return `  - ${h.key}: ${h.description || h.key} (${h.timeRange.start}–${h.timeRange.end})`;
  }).filter(Boolean).join('\n');

  const prefList = memory.preferences.map(p => `  - ${p.key}: ${p.value}`).join('\n');

  let energyNote = '';
  if (planningContext.energyLevel !== undefined) {
    if (planningContext.energyLevel <= 1) energyNote = '\n⚠️ USER IS EXHAUSTED. Start with a recovery break. Push hard tasks later. Reduce total load.';
    else if (planningContext.energyLevel <= 2) energyNote = '\n⚠️ USER IS TIRED. Add a recovery break at the start. Avoid heavy cognitive work early.';
    else if (planningContext.energyLevel >= 5) energyNote = '\n💪 User is highly energized. Front-load the hardest tasks.';
  }
  if (planningContext.recoveryMinutes) {
    energyNote += `\nInclude a ${planningContext.recoveryMinutes}-minute "Recovery break" at the start before scheduling tasks.`;
  }

  return `You are an expert personal productivity planner. Create a precise, minute-level schedule for the user's day.

## Context
- Date: ${targetDate}
- Current time: ${currentTimeStr} (do NOT schedule anything before this time)
- Working hours: ${config.workingHours.start} to ${config.workingHours.end}
- Buffer between tasks: ${config.bufferMinutes} minutes
- Leave ~${config.slackPercentage}% of time unscheduled as slack/flexibility${energyNote}

## Tasks to Schedule
${taskList || '  (none)'}

## Constraints (Fixed Blocked Time — MUST include, CANNOT overlap)
${constraintList || '  (none)'}

## Habits (Recurring Routines — include at their times)
${habitList || '  (none)'}

## User Preferences
${prefList || '  (none)'}

## Rules (STRICTLY FOLLOW)
1. NEVER schedule before ${currentTimeStr} or outside working hours (${config.workingHours.start}–${config.workingHours.end}).
2. Include ALL constraints and habits at their specified times. Mark them as isFixed: true, flexibility: 0.
3. Fixed tasks (with FIXED times) MUST be placed at their exact times. Mark as isFixed: true, flexibility: 0.
4. URGENCY IS #1 PRIORITY. Tasks due sooner go earlier in the day.
5. Place high cognitive load (3/3) tasks when the user is freshest (typically morning), unless preferences say otherwise.
6. Place low cognitive load (1/3) tasks in afternoon/evening.
7. Add ${config.bufferMinutes}-minute gaps between tasks.
8. After any task ≥50min with cognitive load 3/3, add a 10-15min "Recovery break".
9. Leave ~${config.slackPercentage}% of total working time unscheduled.
10. Times must be in HH:mm format, entries must not overlap.
11. For task entries, include the taskId. For habits, constraints, and breaks, set taskId to null.
12. Sort entries chronologically.`;
}

// ─── Core planner: LLM generates the full schedule ────────────────────────────
export async function planSchedule(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string,
  planningContext: PlanningContext = {},
): Promise<IScheduleEntry[]> {
  const now = new Date();
  const workingStart = parseTimeString(config.workingHours.start, targetDate, config.timezone);
  const workingEnd = parseTimeString(config.workingHours.end, targetDate, config.timezone);
  const effectiveStart = now > workingStart ? now : workingStart;

  log.info({ targetDate, tasks: tasks.length, effectiveStart: effectiveStart.toISOString() }, 'Planning schedule via LLM');

  // Guard: no time remaining
  if (effectiveStart >= workingEnd) {
    log.info({ targetDate }, 'Past working hours — nothing to schedule');
    return [];
  }

  // If no tasks AND no habits/constraints for the day, return empty
  const dayOfWeek = new Date(targetDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
  const activeHabits = memory.habits.filter(h => h.isActive && (h.days.includes('daily') || h.days.includes(dayOfWeek)));
  const activeConstraints = memory.constraints.filter(c => c.isActive && (c.days.includes('daily') || c.days.includes(dayOfWeek)));

  if (tasks.length === 0 && activeHabits.length === 0 && activeConstraints.length === 0) {
    log.info({ targetDate }, 'No tasks, habits, or constraints — empty schedule');
    return [];
  }

  // Filter tasks: fixed tasks for other dates shouldn't be scheduled today
  const validTasks = tasks.filter(t => {
    if (t.isFixed && t.dueDate) {
      return formatDateString(t.dueDate, config.timezone) === targetDate;
    }
    return true;
  });

  const prompt = buildPlannerPrompt(validTasks, memory, config, targetDate, planningContext);

  try {
    const { object } = await generateObject({
      model: reasoningModel,
      schema: ScheduleOutputSchema,
      system: prompt,
      prompt: 'Generate the complete schedule now.',
      temperature: 0.2,
    });

    log.info({ entries: object.entries.length, reasoning: object.reasoning }, 'LLM generated schedule');

    // Convert LLM output to IScheduleEntry[]
    const entries: IScheduleEntry[] = object.entries
      .map(e => {
        const startTime = parseTimeString(e.startTime, targetDate, config.timezone);
        const endTime = parseTimeString(e.endTime, targetDate, config.timezone);

        // Skip entries in the past
        if (endTime <= now) return null;
        // Skip entries outside working hours
        if (startTime >= workingEnd) return null;

        return {
          taskId: e.taskId ? new mongoose.Types.ObjectId(e.taskId) : undefined,
          title: e.title,
          description: e.description,
          startTime,
          endTime,
          status: ScheduleEntryStatus.SCHEDULED,
          priority: e.priority,
          isFixed: e.isFixed,
          flexibility: e.flexibility,
        } as IScheduleEntry;
      })
      .filter((e): e is IScheduleEntry => e !== null);

    // Sort chronologically
    entries.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    log.info({ entries: entries.length }, 'Schedule planned');
    return entries;
  } catch (error) {
    log.error({ error }, 'LLM schedule generation failed — returning empty schedule');
    return [];
  }
}
