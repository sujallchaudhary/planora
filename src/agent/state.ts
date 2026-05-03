import { Annotation } from '@langchain/langgraph';
import type { ClassificationResult, ImageExtractionResult } from '../utils/zod-schemas.js';
import type { ActionResult } from '../llm/provider.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';

// ─── Agent State Definition ───────────────────────────────────────────────────
export const AgentStateAnnotation = Annotation.Root({
  // Input fields
  userId: Annotation<string>(),
  telegramId: Annotation<number>(),
  chatId: Annotation<number>(),
  rawInput: Annotation<string>(),
  imageBase64: Annotation<string | undefined>(),
  imageMimeType: Annotation<string | undefined>(),

  // Processing fields
  intent: Annotation<ClassificationResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  imageContext: Annotation<ImageExtractionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  retrievedMemory: Annotation<RetrievedMemory | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // Output fields
  actionResult: Annotation<ActionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  response: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
