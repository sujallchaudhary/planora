import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getLLMProvider } from '../llm/openai-compatible.provider.js';
import { agentTools } from './tools/index.js';
import { createChildLogger } from '../utils/logger.js';
import { userRepo } from '../memory/mongo/repositories/user.repo.js';
import { buildReActSystemPrompt } from './prompts/react-agent.js';
import { resolveUserConfig } from '../config/config-resolver.js';
import { formatTimeHuman, formatDateString, planningDateString, tomorrowString } from '../utils/date.js';

const log = createChildLogger('agent-graph');

let compiledGraph: any = null;

export function getAgentGraph(): any {
  if (!compiledGraph) {
    const llmProvider = getLLMProvider();
    const llm = llmProvider.getLangChainModel();
    
    // Create the ReAct agent
    compiledGraph = createReactAgent({
      llm,
      tools: agentTools,
    });
    log.info('ReAct Agent graph compiled');
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
  const llmProvider = getLLMProvider();

  let finalInputText = input.rawInput;

  // Process image before starting the ReAct loop
  if (input.imageBase64 && input.imageMimeType) {
    log.info('Extracting image context before ReAct loop');
    const imageResult = await llmProvider.extractImageContent(input.imageBase64, input.imageMimeType);
    
    let imageInfo = `\n[System: The user also attached an image. Extracted context: "${imageResult.content}"]`;
    if (imageResult.tasks && imageResult.tasks.length > 0) {
      imageInfo += `\nExtracted tasks from image: ${JSON.stringify(imageResult.tasks)}`;
    }
    finalInputText += imageInfo;
  }

  const user = await userRepo.findByTelegramId(input.telegramId);
  const userName = user ? user.firstName : 'User';

  const config = resolveUserConfig(user?.settings);
  const tz = config.timezone;
  const now = new Date();

  const promptText = buildReActSystemPrompt({
    userName,
    currentTime: formatTimeHuman(now, tz),
    currentDate: formatDateString(now, tz),
    timezone: tz,
    planningDate: planningDateString(tz, config.lateNightThresholdHour),
    tomorrowDate: tomorrowString(tz, config.lateNightThresholdHour),
  });

  const systemMessage = new SystemMessage(promptText);

  const userMessage = new HumanMessage(finalInputText);

  // Invoke the graph
  const result = await graph.invoke(
    {
      messages: [systemMessage, userMessage],
    },
    {
      configurable: {
        telegramId: input.telegramId,
      },
    }
  );

  const messages = result.messages;
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.content) {
    return lastMessage.content as string;
  }

  return 'I processed your message but couldn\'t generate a response.';
}
