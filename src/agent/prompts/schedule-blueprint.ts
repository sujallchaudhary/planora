import type { ITask } from '../../memory/mongo/models/task.model.js';
import type { RetrievedMemory } from '../../memory/hybrid-retriever.js';
import type { UserConfig } from '../../config/config-resolver.js';

export function SCHEDULE_BLUEPRINT_PROMPT(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string
): string {
  const targetMs = new Date(targetDate).getTime();
  
  const formatTasks = tasks.map(t => {
    const daysUntilDue = t.dueDate
      ? Math.max(0, Math.ceil((t.dueDate.getTime() - targetMs) / (1000 * 60 * 60 * 24)))
      : null;
    const urgencyTag = daysUntilDue !== null
      ? (daysUntilDue <= 1 ? '🔴 DUE TODAY/TOMORROW' : daysUntilDue <= 3 ? '🟡 DUE SOON' : `📅 ${daysUntilDue}d away`)
      : '';
    return `[ID: ${t._id}] ${t.title} | Priority: ${t.priority}/5 | Load: ${t.cognitiveLoad}/3 | ${t.estimatedMinutes}m | Due: ${t.dueDate ? t.dueDate.toISOString().split('T')[0] : 'None'} ${urgencyTag}`;
  }).join('\n');

  const formatConstraints = memory.constraints.filter(c => c.isActive).map(c => 
    `- ${c.key}: ${c.description} (${c.timeRange.start} - ${c.timeRange.end})`
  ).join('\n');

  const formatHabits = memory.habits.filter(h => h.isActive).map(h => 
    `- ${h.key}: ${h.description} (${h.timeRange.start} - ${h.timeRange.end})`
  ).join('\n');

  const formatPreferences = memory.preferences.map(p => `- ${p.key}: ${p.value}`).join('\n');

  return `You are an expert AI productivity planner. Your job is to create a strategic "Blueprint" for the user's day.
You do NOT need to assign exact minute-by-minute timestamps. A deterministic algorithm will do that.
Instead, you must analyze the tasks, constraints, habits, and preferences, and assign each task to a broad time block ('morning', 'afternoon', 'evening', or 'any').

## Current Context
- Date: ${targetDate}
- Working Hours: ${config.workingHours.start} to ${config.workingHours.end}

## Tasks to Schedule
${formatTasks || 'None'}

## Constraints (Fixed Events)
${formatConstraints || 'None'}

## Habits (Preferred Routines)
${formatHabits || 'None'}

## Preferences & Context
${formatPreferences || 'None'}

## Rules (STRICTLY FOLLOW)
1. Assign every task to one of: 'morning' (start of day to 12:00), 'afternoon' (12:00 to 17:00), 'evening' (17:00 to end of day), or 'any'.
2. **URGENCY IS THE #1 PRIORITY.** Tasks with closer deadlines (🔴 DUE TODAY/TOMORROW) MUST be placed in EARLIER time blocks than tasks with distant deadlines. A task due tomorrow must ALWAYS be scheduled before a task due next week.
3. Order the tasks array from MOST IMPORTANT/URGENT to LEAST. The first task in the array will be scheduled first by the algorithm.
4. If a constraint or habit occupies a significant portion of a block, avoid assigning high cognitive load tasks to that same block.
5. Group similar tasks together if it reduces context switching, but NEVER at the expense of urgency.
6. High cognitive load tasks (3/3) should go in the morning when the user has peak energy, unless user preferences say otherwise.
7. Provide a brief reasoning for each task's assignment, and a global reasoning summarizing your strategy.

## Output Format
You must output a valid JSON object matching this schema:
{
  "tasks": [
    {
      "taskId": "string",
      "assignedBlock": "morning" | "afternoon" | "evening" | "any",
      "reasoning": "string"
    }
  ],
  "globalReasoning": "string"
}
Return ONLY JSON. Do not use code blocks or markdown wrapping.`;
}
