import { z } from 'zod';
import { IntentType, MemoryType, Priority, CognitiveLoad, TaskStatus } from '../config/defaults.js';

// ─── Intent Classification + Task Extraction + Memory Extraction (single LLM call) ─
export const ClassificationResultSchema = z.object({
  intent: z.nativeEnum(IntentType),
  confidence: z.number().min(0).max(1),

  // Extracted tasks (if any)
  tasks: z.array(z.object({
    title: z.string(),
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
  })).default([]),

  // Extracted memory signals (if any)
  memorySignals: z.array(z.object({
    type: z.nativeEnum(MemoryType),
    key: z.string(),
    value: z.string(),
    timeRange: z.object({
      start: z.string().nullish(),
      end: z.string().nullish(),
      days: z.array(z.string()).nullish(),
    }).nullish(),
    confidence: z.number().min(0).max(1),
  })).default([]),

  // For MODIFY/DELETE/COMPLETE/SKIP intents — which task is being referenced
  taskReference: z.string().nullish(),

  // For REPLAN — reason/context
  replanContext: z.string().nullish(),

  // For REPLAN / SHOW_PLAN — specific date (YYYY-MM-DD) if user asked for "tomorrow", "Friday", etc.
  targetDate: z.string().nullish(),

  // Secondary intents for compound messages (e.g. "add gym and delete math")
  secondaryIntents: z.array(z.object({
    intent: z.nativeEnum(IntentType),
    tasks: z.array(z.object({
      title: z.string(),
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
    })).default([]),
    taskReference: z.string().nullish(),
    replanContext: z.string().nullish(),
    targetDate: z.string().nullish(),
  })).default([]),

  // Raw reasoning from LLM
  reasoning: z.string().nullish(),
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

// ─── Response Generation ───────────────────────────────────────────────────────
export const ResponseGenerationSchema = z.object({
  message: z.string(),
  suggestedActions: z.array(z.string()).optional().default([]),
});

export type ResponseGeneration = z.infer<typeof ResponseGenerationSchema>;

// ─── Schedule Blueprint Generation ──────────────────────────────────────────────
export const ScheduleBlueprintSchema = z.object({
  tasks: z.array(z.object({
    taskId: z.string(),
    assignedBlock: z.enum(['morning', 'afternoon', 'evening', 'any']),
    reasoning: z.string(),
  })),
  globalReasoning: z.string(),
});

export type ScheduleBlueprint = z.infer<typeof ScheduleBlueprintSchema>;

