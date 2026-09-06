import type { ITask } from '../../memory/mongo/models/task.model.js';
import type { RetrievedMemory } from '../../memory/hybrid-retriever.js';
import type { UserConfig } from '../../config/config-resolver.js';
import type { SystemPrompt } from '../../llm/types.js';
import { formatDateString, daysBetween } from '../../utils/date.js';
import { describeDays } from '../../memory/memory-utils.js';

const STABLE = `You are the strategic planner inside Memora, an autonomous personal chief-of-staff. Produce a "blueprint" for the user's day: assign each task to a broad block and order them. A deterministic scheduler assigns exact times and already handles fixed commitments, habits, buffers and breaks.

Blocks: morning (start → 12:00), afternoon (12:00 → 17:00), evening (17:00 → 21:00), night (21:00 → end), or any.

## Rules
1. Urgency first: overdue and due-today tasks go in the EARLIEST feasible block and first in the array.
2. Respect learned preferences literally: peak_focus_window says where deep work (load 3) goes; low_success_window is where deep work must NOT go. If the user says they focus at night, deep work goes to "night" even if that feels unusual.
3. Without a stated preference, deep work goes to the morning; light admin (load 1) to the afternoon or after deep work.
4. Avoid stacking deep work in a block that a long commitment or habit already dominates.
5. Group similar tasks to reduce context switching, never at the expense of urgency.
6. Tasks that slipped repeatedly get placed early and first.
7. Order the "tasks" array from most to least important; the scheduler places them in that order.

## Output — JSON only
{ "tasks": [ { "taskId": "string", "assignedBlock": "morning|afternoon|evening|night|any", "reasoning": "short" } ], "globalReasoning": "short" }`;

export function buildBlueprintPrompt(tasks: ITask[], memory: RetrievedMemory, config: UserConfig, targetDate: string): SystemPrompt {
  const formatTasks = tasks.map(t => {
    const dueStr = t.dueDate ? formatDateString(t.dueDate, config.timezone) : null;
    const daysUntilDue = dueStr ? daysBetween(targetDate, dueStr) : null;
    const urgencyTag = daysUntilDue === null
      ? ''
      : daysUntilDue < 0 ? '🔴 OVERDUE'
        : daysUntilDue === 0 ? '🔴 DUE TODAY'
          : daysUntilDue <= 1 ? '🟠 DUE TOMORROW'
            : daysUntilDue <= 3 ? '🟡 DUE SOON'
              : `📅 ${daysUntilDue}d away`;
    const slipped = t.deferCount > 0 ? ` | slipped ${t.deferCount}x` : '';
    return `[ID: ${t._id}] ${t.title} | Priority ${t.priority}/5 | Load ${t.cognitiveLoad}/3 | ${t.estimatedMinutes}m | Due: ${dueStr ?? 'none'} ${urgencyTag}${slipped}`;
  }).join('\n');

  const formatConstraints = memory.constraints.filter(c => c.isActive).map(c =>
    `- ${c.key}: ${c.description} (${c.timeRange.start}-${c.timeRange.end}, ${describeDays(c.days)})`
  ).join('\n');
  const formatHabits = memory.habits.filter(h => h.isActive).map(h =>
    `- ${h.key}: ${h.description} (${h.timeRange.start}-${h.timeRange.end}, ${describeDays(h.days)})`
  ).join('\n');
  const formatPreferences = memory.preferences.map(p => `- ${p.key}: ${p.value}`).join('\n');

  const dynamic = `## Context
- Date: ${targetDate}
- Working hours: ${config.workingHours.start} to ${config.workingHours.end}

## Tasks to place
${formatTasks || 'None'}

## Fixed commitments
${formatConstraints || 'None'}

## Habits / routines
${formatHabits || 'None'}

## Learned preferences
${formatPreferences || 'None'}

Produce the blueprint JSON now.`;

  return { stable: STABLE, dynamic };
}
