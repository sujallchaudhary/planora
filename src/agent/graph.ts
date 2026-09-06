import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentStateAnnotation, type AgentState } from './state.js';
import { classifyIntentNode } from './nodes/classify-intent.node.js';
import { extractMemoryNode } from './nodes/extract-memory.node.js';
import { retrieveMemoryNode } from './nodes/retrieve-memory.node.js';
import { analyzeContextNode } from './nodes/analyze-context.node.js';
import { executeActionNode } from './nodes/execute-action.node.js';
import { generateResponseNode } from './nodes/generate-response.node.js';
import { IntentType } from '../config/defaults.js';
import type { ClassificationResult } from '../utils/zod-schemas.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('agent-graph');

function routeByIntent(state: AgentState): string {
  const intent = state.intent?.intent;

  // The LLM call itself failed — do not execute anything on a guessed intent.
  if (state.intent?.classificationError) return 'generate-response';

  if (state.autonomyContext?.shouldReplan || state.memoryChanged) return 'execute-action';
  if (intent === IntentType.GENERAL_CHAT && (state.intent?.secondaryIntents.length ?? 0) === 0) return 'generate-response';

  return 'execute-action';
}

function buildGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('classify-intent', classifyIntentNode)
    .addNode('extract-memory', extractMemoryNode)
    .addNode('retrieve-memory', retrieveMemoryNode)
    .addNode('analyze-context', analyzeContextNode)
    .addNode('execute-action', executeActionNode)
    .addNode('generate-response', generateResponseNode)

    .addEdge(START, 'classify-intent')
    .addEdge('classify-intent', 'extract-memory')
    .addEdge('extract-memory', 'retrieve-memory')
    .addEdge('retrieve-memory', 'analyze-context')
    .addConditionalEdges('analyze-context', routeByIntent, {
      'execute-action': 'execute-action',
      'generate-response': 'generate-response',
    })
    .addEdge('execute-action', 'generate-response')
    .addEdge('generate-response', END);

  return graph.compile();
}

let compiledGraph: ReturnType<typeof buildGraph> | null = null;

export function getAgentGraph() {
  if (!compiledGraph) {
    compiledGraph = buildGraph();
    log.info('Agent graph compiled');
  }
  return compiledGraph;
}

export async function runAgent(input: {
  userId: string;
  telegramId: number;
  chatId: number;
  rawInput: string;
  imageBase64?: string;
  imageMimeType?: string;
}): Promise<AgentRunResult> {
  const graph = getAgentGraph();

  const result = await graph.invoke({
    userId: input.userId,
    telegramId: input.telegramId,
    chatId: input.chatId,
    rawInput: input.rawInput,
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
  });

  return {
    response: result.response || 'I processed your message but couldn\'t put a reply together. Try again?',
    intent: result.intent,
    memorable: isMemorable(result.intent),
  };
}

export interface AgentRunResult {
  response: string;
  intent: ClassificationResult | null;
  /** Whether this turn carries context worth embedding into long-term memory. */
  memorable: boolean;
}

const ROUTINE_INTENTS = new Set<string>([IntentType.SHOW_PLAN, IntentType.COMPLETE_TASK, IntentType.SKIP_TASK, IntentType.DELETE_TASK]);

function isMemorable(intent: ClassificationResult | null): boolean {
  if (!intent || intent.classificationError) return false;
  if (intent.reasoning?.startsWith('fast:')) return false;
  if (intent.memorySignals.length > 0 || intent.userState?.energy || intent.userState?.mood) return true;
  return !ROUTINE_INTENTS.has(intent.intent);
}
