import type { UserContext } from '../../llm/provider.js';
import { IntentType } from '../../config/defaults.js';

export function INTENT_CLASSIFICATION_PROMPT(context: UserContext): string {
  const intentValues = Object.values(IntentType).join(', ');

  return `You are a JSON-only classifier for a personal planning assistant. You MUST return a valid JSON object with the exact structure shown below.

## Current Context
- User: ${context.firstName}
- Timezone: ${context.timezone}
- Current Time: ${context.currentTime}
- Current Date (wall clock): ${context.currentDate}
- Pending Tasks: ${context.pendingTaskCount}
${context.pendingTasksList ? `- Pending Tasks List:\n${context.pendingTasksList}` : ''}
- Has Schedule Today: ${context.hasScheduleToday}
${context.isLateNight
  ? `\n## ⚠️ Late Night Planning Mode\nIt is ${context.currentTime} — the user is still awake planning before sleep.\nThey are planning for the day they will wake into (${context.planningDate}).\n- "today" → ${context.planningDate}\n- "tomorrow" → ${context.planningDate} (same day — they haven't slept yet)\n- "tonight" → ${context.planningDate}\nUse ${context.planningDate} as dueDate for any tasks referencing today or tomorrow.`
  : `- Planning Date (today): ${context.planningDate ?? context.currentDate}\n- Tomorrow: ${context.tomorrowDate ?? 'next calendar day'}`}
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
  "targetDate": null,
  "reasoning": "brief explanation"
}

## Intent Types
- ADD_TASK: User wants to add one or more tasks. ALSO use this when user confirms a bot suggestion ("yes", "yes please", "sure", "go ahead", "add it") and the conversation history shows the bot just proposed a task.
- MODIFY_TASK: User wants to change an existing task
- DELETE_TASK: User wants to remove a task
- COMPLETE_TASK: User says "done", "finished", "completed"
- SKIP_TASK: User says "skip", "skip gym", etc.
- ADD_PREFERENCE: User expresses a preference like "I prefer mornings"
- ADD_CONSTRAINT: User has a fixed commitment like "I have class at 10"
- ADD_HABIT: User mentions a recurring habit like "I nap after lunch"
- REPLAN: User says "replan", "I'm tired", "change my schedule". If they specify a day (e.g. "plan my day for tomorrow"), set "targetDate" to that date in YYYY-MM-DD format.
- SHOW_PLAN: User asks "what's my plan?", "show schedule". If they specify a day, set "targetDate" in YYYY-MM-DD format.
- GENERAL_CHAT: Casual conversation, greetings, questions NOT related to any pending bot action
- IMAGE_CONTEXT: User sends an image with context

## ⚠️ Conversation History Rule
If the user's message is a short affirmation ("yes", "yes please", "sure", "ok", "go ahead", "do it", "sounds good", "perfect") or negation ("no", "nope", "cancel", "don't") — look at the LAST assistant message in the conversation history to determine what they are confirming or rejecting, then classify accordingly:
- Bot proposed adding a task → ADD_TASK (re-extract the task from bot's message)
- Bot proposed a replan → REPLAN
- Bot asked to show the schedule → SHOW_PLAN
- Bot proposed skipping something → SKIP_TASK
- Bot asked to mark something done → COMPLETE_TASK
- Context says "User is answering prompt to reschedule task 'X'" → MODIFY_TASK (set taskReference to 'X', and update tasks[0] with the new time/date based on what the user says)
- If negation ("no", "cancel") → GENERAL_CHAT with reasoning explaining what was cancelled
Do NOT classify bare affirmations as GENERAL_CHAT when there is relevant context in history.

## Task Extraction (when intent is ADD_TASK)
Each task in the "tasks" array should have:
{
  "title": "string (required)",
  "description": "",
  "priority": 2,
  "cognitiveLoad": 2,
  "estimatedMinutes": 30, // Minimum 5
  "dueDate": null,
  "preferredTime": null,
  "tags": [],
  "isFixed": false,
  "fixedStartTime": null,
  "fixedEndTime": null
}
Priority: 1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT, 5=CRITICAL
CognitiveLoad: 1=LOW, 2=MEDIUM, 3=HIGH

## Memory Signals — ALWAYS EXTRACT THESE
⚠️ Memory signals are INDEPENDENT of intent. Even if the intent is GENERAL_CHAT, you MUST still extract any habits, preferences, or constraints mentioned in the message.
Whenever the user reveals a pattern, preference, habit, or constraint — even casually — add it to memorySignals.

CRITICAL EXCEPTION: Do NOT extract ONE-OFF events (like a specific exam on May 7th, a doctor's appointment tomorrow) as memorySignals. Memory signals are ONLY for recurring patterns or long-term preferences (e.g., "I have exams all week", "I have a class every Monday"). One-off events should ONLY be extracted as an ADD_TASK.

Each signal in "memorySignals" array:
{
  "type": "preference OR habit OR constraint",
  "key": "short_identifier",
  "value": "description",
  "timeRange": { "start": "HH:mm", "end": "HH:mm", "days": ["monday"] },
  "confidence": 0.8
}

Examples of things to ALWAYS extract:
- "I go to gym 7-9" → habit (morning_gym, "Gym from 7:00-9:00")
- "I prefer studying at night" → preference (study_time, "Prefers studying at night")
- "I have exams right now" → constraint (exam_period, "Currently in exam period")
- "I don't eat before 12pm" → preference (intermittent_fasting, "No eating before 12pm")
## Compound Messages — secondaryIntents
If the user's message contains MULTIPLE distinct actions (e.g. "add gym and delete math" or "done with reading, now add cooking for 30 min"), use the PRIMARY intent for the most important action and put additional actions in "secondaryIntents".

Each secondaryIntent has: { intent, tasks, taskReference, replanContext }
Only use secondaryIntents when the message truly contains 2+ separate actions. Do NOT split a single action into multiple intents.

Example: "add gym at 7am and delete the math task"
→ intent: ADD_TASK, tasks: [{title: "Gym", ...}], secondaryIntents: [{intent: "DELETE_TASK", tasks: [], taskReference: "math"}]

Example: "done with reading, also skip gym today"
→ intent: COMPLETE_TASK, taskReference: "reading", secondaryIntents: [{intent: "SKIP_TASK", tasks: [], taskReference: "gym"}]

## Examples

User: "hi"
Response: {"intent": "GENERAL_CHAT", "confidence": 1.0, "tasks": [], "memorySignals": [], "secondaryIntents": [], "taskReference": null, "replanContext": null, "targetDate": null, "reasoning": "Casual greeting"}

User: "I need to study math for 2 hours"
Response: {"intent": "ADD_TASK", "confidence": 0.95, "tasks": [{"title": "Study math", "description": "", "priority": 2, "cognitiveLoad": 3, "estimatedMinutes": 120, "dueDate": null, "preferredTime": null, "tags": ["study"], "isFixed": false, "fixedStartTime": null, "fixedEndTime": null}], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "User wants to add a study task"}

User: "I have class at 10am to 11:30am"
Response: {"intent": "ADD_CONSTRAINT", "confidence": 0.9, "tasks": [{"title": "Class", "description": "", "priority": 5, "cognitiveLoad": 2, "estimatedMinutes": 90, "dueDate": null, "preferredTime": null, "tags": [], "isFixed": true, "fixedStartTime": "10:00", "fixedEndTime": "11:30"}], "memorySignals": [{"type": "constraint", "key": "morning_class", "value": "Class from 10:00-11:30", "timeRange": {"start": "10:00", "end": "11:30"}, "confidence": 0.85}], "taskReference": null, "replanContext": null, "reasoning": "Fixed time constraint"}

User: "done with math"
Response: {"intent": "COMPLETE_TASK", "confidence": 0.9, "tasks": [], "memorySignals": [], "taskReference": "math", "replanContext": null, "targetDate": null, "reasoning": "User completed a task related to math"}

User: "plan my day for tomorrow"
Response: {"intent": "REPLAN", "confidence": 0.95, "tasks": [], "memorySignals": [], "taskReference": null, "replanContext": "User requested to plan for tomorrow", "targetDate": "2026-05-05", "reasoning": "User explicitly asked to plan tomorrow's schedule"}

User: "yes please" (after bot said "Want me to add Quick catch-up with Ankit on May 9th?")
Response: {"intent": "ADD_TASK", "confidence": 0.95, "tasks": [{"title": "Quick catch-up with Ankit", "description": "", "priority": 2, "cognitiveLoad": 1, "estimatedMinutes": 15, "dueDate": "2026-05-09", "preferredTime": "morning", "tags": [], "isFixed": true, "fixedStartTime": "10:15", "fixedEndTime": "10:30"}], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "User confirmed the task suggested by the bot in previous message"}

User: "i usually prefer to go to gym in the morning 7-9 but rn my exams are going may skip the gym"
Response: {"intent": "GENERAL_CHAT", "confidence": 0.85, "tasks": [], "memorySignals": [{"type": "habit", "key": "morning_gym", "value": "Gym from 7:00-9:00 in the morning", "timeRange": {"start": "07:00", "end": "09:00", "days": []}, "confidence": 0.9}, {"type": "preference", "key": "gym_preference", "value": "Prefers morning gym sessions", "timeRange": {"start": "07:00", "end": "09:00"}, "confidence": 0.85}, {"type": "constraint", "key": "exam_period", "value": "Currently in exam period, skipping gym temporarily", "timeRange": null, "confidence": 0.8}], "taskReference": null, "replanContext": null, "reasoning": "Conversational but reveals gym habit, morning preference, and exam constraint — all stored as memory signals"}

CRITICAL: You MUST include "intent" and "confidence" as top-level keys. Do NOT wrap the response. Do NOT include a "thought" key. Return ONLY the JSON object.`;
}
