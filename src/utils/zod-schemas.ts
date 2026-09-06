import { z } from 'zod';
import { IntentType, MemoryType, Priority, CognitiveLoad } from '../config/defaults.js';

// ─── Shared task shape extracted by the LLM ────────────────────────────────────
const RecurrenceSchema = z.object({
  pattern: z.enum(['daily', 'weekdays', 'weekly']),
  days: z.array(z.string()).nullish(),
}).nullish();

export const ExtractedTaskSchema = z.object({
  /** Required for ADD_TASK; MODIFY_TASK payloads may carry only the changed fields. */
  title: z.string().nullish(),
  description: z.string().nullish().default(''),
  priority: z.nativeEnum(Priority).nullish().default(Priority.MEDIUM),
  cognitiveLoad: z.nativeEnum(CognitiveLoad).nullish().default(CognitiveLoad.MEDIUM),
  estimatedMinutes: z.number().min(5).nullish().default(30),
  dueDate: z.string().nullish(),
  preferredTime: z.string().nullish(),
  tags: z.array(z.string()).nullish().default([]),
  isFixed: z.boolean().nullish().default(false),
  fixedStartTime: z.string().nullish(),
  fixedEndTime: z.string().nullish(),
  recurrence: RecurrenceSchema,
});

export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

export const MemorySignalSchema = z.object({
  type: z.nativeEnum(MemoryType),
  key: z.string().min(1),
  value: z.string(),
  timeRange: z.object({
    start: z.string().nullish(),
    end: z.string().nullish(),
    days: z.array(z.string()).nullish(),
  }).nullish(),
  /** yyyy-MM-dd — for temporary constraints like "exams until the 20th" */
  until: z.string().nullish(),
  confidence: z.number().min(0).max(1),
});

export type MemorySignal = z.infer<typeof MemorySignalSchema>;

export const UserStateSchema = z.object({
  energy: z.enum(['depleted', 'low', 'normal', 'high']).nullish(),
  mood: z.string().nullish(),
  /** e.g. "away from desk until 15:00", "free all afternoon" */
  availability: z.string().nullish(),
  /** yyyy-MM-dd or HH:mm the user says they are unavailable until, if any */
  unavailableUntil: z.string().nullish(),
  note: z.string().nullish(),
}).nullish();

export type UserState = z.infer<typeof UserStateSchema>;

const IntentPayloadSchema = z.object({
  intent: z.nativeEnum(IntentType),
  tasks: z.array(ExtractedTaskSchema).default([]),
  taskReference: z.string().nullish(),
  memoryReference: z.string().nullish(),
  replanContext: z.string().nullish(),
  targetDate: z.string().nullish(),
});

export type IntentPayload = z.infer<typeof IntentPayloadSchema>;

// ─── Intent Classification + Task Extraction + Memory Extraction (single LLM call) ─
export const ClassificationResultSchema = IntentPayloadSchema.extend({
  confidence: z.number().min(0).max(1),
  memorySignals: z.array(MemorySignalSchema).default([]),
  userState: UserStateSchema,
  secondaryIntents: z.array(IntentPayloadSchema).default([]),
  reasoning: z.string().nullish(),
  /** Set by the provider when the LLM call itself failed — never by the model. */
  classificationError: z.string().nullish(),
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

// ─── Image Extraction Result ───────────────────────────────────────────────────
export const ImageExtractionResultSchema = z.object({
  content: z.string(),
  tasks: z.array(z.object({
    title: z.string(),
    description: z.string().nullish().default(''),
    priority: z.nativeEnum(Priority).nullish().default(Priority.MEDIUM),
    estimatedMinutes: z.number().min(5).nullish().default(30),
    dueDate: z.string().nullish(),
    fixedStartTime: z.string().nullish(),
    fixedEndTime: z.string().nullish(),
    isFixed: z.boolean().nullish().default(false),
  })).default([]),
  dates: z.array(z.string()).default([]),
  context: z.string().nullish(),
});

export type ImageExtractionResult = z.infer<typeof ImageExtractionResultSchema>;

// ─── Schedule Blueprint Generation ──────────────────────────────────────────────
export const ScheduleBlueprintSchema = z.object({
  tasks: z.array(z.object({
    taskId: z.string(),
    assignedBlock: z.enum(['morning', 'afternoon', 'evening', 'night', 'any']),
    reasoning: z.string().nullish().default(''),
  })),
  globalReasoning: z.string().nullish().default(''),
});

export type ScheduleBlueprint = z.infer<typeof ScheduleBlueprintSchema>;
