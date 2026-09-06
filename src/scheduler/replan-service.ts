import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import { HybridRetriever, EMPTY_MEMORY } from '../memory/hybrid-retriever.js';
import { SemanticMemory } from '../memory/qdrant/semantic-memory.js';
import { userRepo } from '../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig, type UserConfig } from '../config/config-resolver.js';
import { ScheduleEntryStatus } from '../config/defaults.js';
import { getLLMProvider } from '../llm/index.js';
import { syncReminders } from '../execution/job-manager.js';
import { replan } from './replanner.js';
import type { PlanningContext } from './planning-context.js';
import type { UnscheduledTask } from './planner.js';
import { formatTimeHuman } from '../utils/date.js';
import { md } from '../utils/markdown.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('replan-service');

// ─── Per-user serialization: a reminder job and a chat message must not replan at once ─

const locks = new Map<number, Promise<unknown>>();

export function withUserLock<T>(telegramId: number, fn: () => Promise<T>): Promise<T> {
  const tail = locks.get(telegramId) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  locks.set(telegramId, run.catch(() => undefined));
  return run;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

let retriever: HybridRetriever | null = null;

export function getRetriever(): HybridRetriever {
  if (!retriever) {
    const llm = getLLMProvider();
    retriever = new HybridRetriever(new SemanticMemory((t) => llm.getEmbedding(t)));
  }
  return retriever;
}

export async function loadPlanningMemory(telegramId: number, date: string, config: UserConfig): Promise<RetrievedMemory> {
  try {
    return await getRetriever().retrieve(telegramId, `Plan for ${date}`, config.memoryConfidenceThreshold, {
      asOfDate: date,
      skipSemantic: true,
    });
  } catch (error) {
    log.warn({ error, telegramId }, 'Memory unavailable for planning — using empty memory');
    return EMPTY_MEMORY;
  }
}

// ─── Replanning ───────────────────────────────────────────────────────────────

export interface ReplanOutcome {
  date: string;
  entries: IScheduleEntry[];
  /** Task entries still to do (scheduled or active) */
  scheduledTaskCount: number;
  unscheduled: UnscheduledTask[];
}

/**
 * Replan one day for a user: loads open tasks + memory, preserves what should be kept,
 * persists the schedule and re-syncs reminder jobs. Serialized per user.
 */
export async function replanDay(telegramId: number, date: string, planningContext: PlanningContext = {}): Promise<ReplanOutcome> {
  return withUserLock(telegramId, async () => {
    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) throw new Error(`User ${telegramId} not found`);
    const config = resolveUserConfig(user.settings);

    const [tasks, existing, memory] = await Promise.all([
      taskRepo.findOpenTasksForDate(telegramId, date),
      scheduleRepo.findByDate(telegramId, date),
      loadPlanningMemory(telegramId, date, config),
    ]);

    const result = await replan(tasks, existing?.entries ?? [], memory, config, date, planningContext);
    const saved = await scheduleRepo.createOrReplace(telegramId, user._id as any, date, result.entries);
    await syncReminders(telegramId, date, saved.entries).catch(err => log.error({ err }, 'Failed to sync reminders'));

    const scheduledTaskCount = saved.entries.filter(e => e.taskId && (e.status === ScheduleEntryStatus.SCHEDULED || e.status === ScheduleEntryStatus.ACTIVE)).length;
    log.info({ telegramId, date, entries: saved.entries.length, scheduledTaskCount, unscheduled: result.unscheduled.length }, 'Replanned day');

    return { date, entries: saved.entries, scheduledTaskCount, unscheduled: result.unscheduled };
  });
}

export async function replanDates(telegramId: number, dates: Iterable<string>, planningContext: PlanningContext = {}): Promise<ReplanOutcome[]> {
  const out: ReplanOutcome[] = [];
  for (const date of Array.from(new Set(dates)).sort()) {
    try {
      out.push(await replanDay(telegramId, date, planningContext));
    } catch (error) {
      log.error({ error, telegramId, date }, 'Failed to replan date');
    }
  }
  return out;
}

// ─── Formatting shared by chat, commands and workers ──────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  completed: '✅',
  skipped: '⏭',
  missed: '⚠️',
  active: '▶️',
  scheduled: '📋',
};

export function formatScheduleLines(entries: IScheduleEntry[], timezone: string, options: { escape?: boolean } = {}): string[] {
  const esc = options.escape === false ? (s: string) => s : md;
  return [...entries]
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .map(e => {
      const s = formatTimeHuman(new Date(e.startTime), timezone);
      const end = formatTimeHuman(new Date(e.endTime), timezone);
      const emoji = STATUS_EMOJI[e.status] ?? '📋';
      const suffix = e.status === 'missed' ? ' _(missed)_' : e.status === 'skipped' ? ' _(skipped)_' : '';
      return `${emoji} ${s} – ${end}: *${esc(e.title)}*${suffix}`;
    });
}

const REASON_TEXT: Record<UnscheduledTask['reason'], string> = {
  no_slot: 'no free slot long enough',
  overload: 'the day is already full',
  low_energy: 'held back while your energy is low',
  conflict: 'clashes with a fixed commitment',
  not_due_yet: 'not due yet, left for a lighter day',
  no_time_left: 'no working time left today',
};

/** Human summary of what could not be placed. Deferred-by-design items are grouped separately. */
export function describeUnscheduled(unscheduled: UnscheduledTask[], options: { escape?: boolean } = {}): string {
  if (unscheduled.length === 0) return '';
  const esc = options.escape === false ? (s: string) => s : md;
  const dropped = unscheduled.filter(u => u.reason !== 'not_due_yet');
  const later = unscheduled.filter(u => u.reason === 'not_due_yet');
  const parts: string[] = [];
  if (dropped.length > 0) {
    parts.push('Could not fit: ' + dropped.map(u => `${esc(u.title)} (${REASON_TEXT[u.reason]})`).join(', '));
  }
  if (later.length > 0) {
    parts.push(`Left for later days: ${later.map(u => esc(u.title)).join(', ')}`);
  }
  return parts.join('\n');
}
