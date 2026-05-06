import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentStateAnnotation, type AgentState } from './state.js';
import { classifyIntentNode } from './nodes/classify-intent.node.js';
import { extractMemoryNode } from './nodes/extract-memory.node.js';
import { retrieveMemoryNode } from './nodes/retrieve-memory.node.js';
import { analyzeContextNode } from './nodes/analyze-context.node.js';
import { executeActionNode } from './nodes/execute-action.node.js';
import { generateResponseNode } from './nodes/generate-response.node.js';
import { IntentType } from '../config/defaults.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('agent-graph');

function routeByIntent(state: AgentState): string {
  const intent = state.intent?.intent;

  if (state.autonomyContext?.shouldReplan) {
    return 'execute-action';
  }

  if (intent === IntentType.GENERAL_CHAT) {
    return 'generate-response';
  }

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

    // Flow: START → classify → extract-memory → retrieve-memory → (route) → ...
    .addEdge(START, 'classify-intent')
    .addEdge('classify-intent', 'extract-memory')
    .addEdge('extract-memory', 'retrieve-memory')
    .addEdge('retrieve-memory', 'analyze-context')

    // Conditional routing after memory retrieval
    .addConditionalEdges('analyze-context', routeByIntent, {
      'execute-action': 'execute-action',
      'generate-response': 'generate-response',
    })

    // After execution, generate response
    .addEdge('execute-action', 'generate-response')

    // Response is the final node
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
}): Promise<string> {
  const graph = getAgentGraph();

  const result = await graph.invoke({
    userId: input.userId,
    telegramId: input.telegramId,
    chatId: input.chatId,
    rawInput: input.rawInput,
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
  });

  return result.response || 'I processed your message but couldn\'t generate a response.';
}
