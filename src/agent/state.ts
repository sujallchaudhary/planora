import { Annotation } from '@langchain/langgraph';
import type { ClassificationResult, ImageExtractionResult } from '../utils/zod-schemas.js';
import type { ActionResult } from '../llm/provider.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { AutonomyContext } from './autonomy-context.js';

export const AgentStateAnnotation = Annotation.Root({
  // Input
  userId: Annotation<string>(),
  telegramId: Annotation<number>(),
  chatId: Annotation<number>(),
  rawInput: Annotation<string>(),
  imageBase64: Annotation<string | undefined>(),
  imageMimeType: Annotation<string | undefined>(),

  // Processing
  intent: Annotation<ClassificationResult | null>({ reducer: (_p, n) => n, default: () => null }),
  imageContext: Annotation<ImageExtractionResult | null>({ reducer: (_p, n) => n, default: () => null }),
  retrievedMemory: Annotation<RetrievedMemory | null>({ reducer: (_p, n) => n, default: () => null }),
  autonomyContext: Annotation<AutonomyContext | null>({ reducer: (_p, n) => n, default: () => null }),
  /** True when extract-memory stored something that can change today's plan (habit/constraint with a time). */
  memoryChanged: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),

  // Output
  actionResult: Annotation<ActionResult | null>({ reducer: (_p, n) => n, default: () => null }),
  response: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
});

export type AgentState = typeof AgentStateAnnotation.State;
