import type { UserContext } from '../../llm/provider.js';
import { IntentType } from '../../config/defaults.js';

export function INTENT_CLASSIFICATION_PROMPT(context: UserContext): string {
  const intentValues = Object.values(IntentType).join(', ');

  return `You are a JSON-only classifier for a personal planning assistant. You MUST return a valid JSON object with the exact structure shown below.

## Current Context
- User: ${context.firstName}
- Timezone: ${context.timezone}
- Current Time: ${context.currentTime}
- Current Date: ${context.currentDate}
- Pending Tasks: ${context.pendingTaskCount}
- Has Schedule Today: ${context.hasScheduleToday}
${context.recentMemorySummary ? `- Recent Memory: ${context.recentMemorySummary}` : ''}

## Required Output Format
You MUST respond with this EXACT JSON structure (no other keys):

{
  "intent": "ONE_OF: ${intentValues}",
  "confidence": 0.95,
  "tasks": [],
  "memorySignals": [],
  "taskReference": null,
  "replanContext": null,
  "reasoning": "brief explanation"
}

## Intent Types
- ADD_TASK: User wants to add one or more tasks
- MODIFY_TASK: User wants to change an existing task
- DELETE_TASK: User wants to remove a task
- COMPLETE_TASK: User says "done", "finished", "completed"
- SKIP_TASK: User says "skip", "skip gym", etc.
- ADD_PREFERENCE: User expresses a preference like "I prefer mornings"
- ADD_CONSTRAINT: User has a fixed commitment like "I have class at 10"
- ADD_HABIT: User mentions a recurring habit like "I nap after lunch"
- REPLAN: User says "replan", "I'm tired", "change my schedule"
- SHOW_PLAN: User asks "what's my plan?", "show schedule"
- GENERAL_CHAT: Casual conversation, greetings, questions
- IMAGE_CONTEXT: User sends an image with context

## Task Extraction (when intent is ADD_TASK)
Each task in the "tasks" array should have:
{
  "title": "string (required)",
  "description": "",
  "priority": 2,
  "cognitiveLoad": 2,
  "estimatedMinutes": 30,
  "dueDate": null,
  "preferredTime": null,
  "tags": [],
  "isFixed": false,
  "fixedStartTime": null,
  "fixedEndTime": null
}
Priority: 1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT, 5=CRITICAL
CognitiveLoad: 1=LOW, 2=MEDIUM, 3=HIGH

## Memory Signals (when user reveals patterns)
Each signal in "memorySignals" array:
{
  "type": "preference OR habit OR constraint",
  "key": "short_identifier",
  "value": "description",
  "timeRange": { "start": "HH:mm", "end": "HH:mm", "days": ["monday"] },
  "confidence": 0.8
}

## Examples

User: "hi"
Response: {"intent": "GENERAL_CHAT", "confidence": 1.0, "tasks": [], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "Casual greeting"}

User: "I need to study math for 2 hours"
Response: {"intent": "ADD_TASK", "confidence": 0.95, "tasks": [{"title": "Study math", "description": "", "priority": 2, "cognitiveLoad": 3, "estimatedMinutes": 120, "dueDate": null, "preferredTime": null, "tags": ["study"], "isFixed": false, "fixedStartTime": null, "fixedEndTime": null}], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "User wants to add a study task"}

User: "I have class at 10am to 11:30am"
Response: {"intent": "ADD_CONSTRAINT", "confidence": 0.9, "tasks": [{"title": "Class", "description": "", "priority": 5, "cognitiveLoad": 2, "estimatedMinutes": 90, "dueDate": null, "preferredTime": null, "tags": [], "isFixed": true, "fixedStartTime": "10:00", "fixedEndTime": "11:30"}], "memorySignals": [{"type": "constraint", "key": "morning_class", "value": "Class from 10:00-11:30", "timeRange": {"start": "10:00", "end": "11:30"}, "confidence": 0.85}], "taskReference": null, "replanContext": null, "reasoning": "Fixed time constraint"}

User: "done with math"
Response: {"intent": "COMPLETE_TASK", "confidence": 0.9, "tasks": [], "memorySignals": [], "taskReference": "math", "replanContext": null, "reasoning": "User completed a task related to math"}

CRITICAL: You MUST include "intent" and "confidence" as top-level keys. Do NOT wrap the response. Do NOT include a "thought" key. Return ONLY the JSON object.`;
}
