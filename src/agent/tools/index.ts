import { manageTaskTool } from './task.tool.js';
import { replanScheduleTool, getScheduleTool } from './schedule.tool.js';
import { storeMemoryTool, searchMemoryTool } from './memory.tool.js';

export const agentTools = [
  manageTaskTool,
  replanScheduleTool,
  getScheduleTool,
  storeMemoryTool,
  searchMemoryTool,
];
