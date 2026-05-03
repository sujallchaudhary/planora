import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
});

const SYSTEM_PROMPT = `You are a JSON-only classifier for a personal planning assistant. You MUST return a valid JSON object with the exact structure shown below.

## Required Output Format
You MUST respond with this EXACT JSON structure (no other keys):

{
  "intent": "ONE_OF: ADD_TASK, MODIFY_TASK, DELETE_TASK, COMPLETE_TASK, SKIP_TASK, ADD_PREFERENCE, ADD_CONSTRAINT, ADD_HABIT, REPLAN, SHOW_PLAN, GENERAL_CHAT, IMAGE_CONTEXT",
  "confidence": 0.95,
  "tasks": [],
  "memorySignals": [],
  "taskReference": null,
  "replanContext": null,
  "reasoning": "brief explanation"
}

## Examples

User: "hi"
Response: {"intent": "GENERAL_CHAT", "confidence": 1.0, "tasks": [], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "Casual greeting"}

User: "I need to study math for 2 hours"
Response: {"intent": "ADD_TASK", "confidence": 0.95, "tasks": [{"title": "Study math", "description": "", "priority": 2, "cognitiveLoad": 3, "estimatedMinutes": 120, "tags": ["study"], "isFixed": false}], "memorySignals": [], "taskReference": null, "replanContext": null, "reasoning": "User wants to add a study task"}

CRITICAL: You MUST include "intent" and "confidence" as top-level keys. Do NOT wrap the response. Do NOT add extra keys like "thought". Return ONLY the JSON object.`;

const TEST_MESSAGES = [
  'hi',
  'I need to study math for 2 hours, high priority',
  'I have class at 10am to 11:30am every Monday and Wednesday',
  'done with gym',
  'show me my plan for today',
  'I\'m tired, replan my day',
];

async function testClassification() {
  console.log('=== Testing LLM Classification ===');
  console.log(`Model: ${process.env.LLM_CHAT_MODEL}`);
  console.log(`Base URL: ${process.env.LLM_BASE_URL}`);
  console.log('');

  for (const msg of TEST_MESSAGES) {
    console.log(`\n--- Input: "${msg}" ---`);
    try {
      const response = await client.chat.completions.create({
        model: process.env.LLM_CHAT_MODEL!,
        temperature: 0.3,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: msg },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      console.log('Raw response:', content);

      if (content) {
        try {
          const parsed = JSON.parse(content);
          console.log('Parsed keys:', Object.keys(parsed));
          console.log('Intent:', parsed.intent);
          console.log('Confidence:', parsed.confidence);
          console.log('Tasks:', parsed.tasks?.length ?? 0);
          console.log('✅ Valid structure:', !!parsed.intent && parsed.confidence !== undefined);
        } catch (e) {
          console.log('❌ JSON parse failed');
        }
      }
    } catch (error: any) {
      console.log('❌ API Error:', error.message);
    }
    console.log('');
  }
}

testClassification();
