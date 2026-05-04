import type { ITask } from '../../memory/mongo/models/task.model.js';
import type { RetrievedMemory } from '../../memory/hybrid-retriever.js';
import type { UserConfig } from '../../config/config-resolver.js';

export function SCHEDULE_BLUEPRINT_PROMPT(
  tasks: ITask[],
  memory: RetrievedMemory,
  config: UserConfig,
  targetDate: string
): string {
  const formatTasks = tasks.map(t => 
    `[ID: ${t._id}] ${t.title} | Priority: ${t.priority}/5 | Load: ${t.cognitiveLoad}/3 | ${t.estimatedMinutes}m | Due: ${t.dueDate ? t.dueDate.toISOString() : 'None'}`
  ).join('\n');

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

## Rules
1. Assign every task to one of: 'morning' (start of day to 12:00), 'afternoon' (12:00 to 17:00), 'evening' (17:00 to end of day), or 'any'.
2. If a constraint or habit occupies a significant portion of a block, avoid assigning high cognitive load tasks to that same block if possible.
3. Group similar tasks if it reduces context switching.
4. If a task has a due date close to the target date, give it a strategic block to ensure it gets done.
5. Provide a brief reasoning for each task's assignment, and a global reasoning summarizing your strategy.

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
