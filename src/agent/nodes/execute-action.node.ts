import type { AgentState } from '../state.js';
import type { ActionResult } from '../../llm/provider.js';
import type { IntentPayload, ExtractedTask } from '../../utils/zod-schemas.js';
import type { IUser } from '../../memory/mongo/models/user.model.js';
import type { ITask } from '../../memory/mongo/models/task.model.js';
import { IntentType, PLANNING } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../../memory/mongo/models/habit.model.js';
import { Constraint } from '../../memory/mongo/models/constraint.model.js';
import { resolveUserConfig, type UserConfig } from '../../config/config-resolver.js';
import { replanDates, formatScheduleLines, describeUnscheduled } from '../../scheduler/replan-service.js';
import { completeTask, skipTaskToday, inferCurrentTask, nextUpcomingEntry } from '../../scheduler/task-actions.js';
import { taskEligibility } from '../../scheduler/planner.js';
import type { PlanningContext } from '../../scheduler/planning-context.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/index.js';
import { normalizeDays } from '../../memory/memory-utils.js';
import { setPendingAction } from '../../bot/pending-action.js';
import {
  planningDateString, tomorrowString, isValidDateString, dateStringToDate, formatDateString,
  daysBetween, parseTimeString, normalizeTimeString, formatDateHuman, formatTimeHuman, formatMinutes, formatTime,
} from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';
import { extractDateHints } from '../../utils/nl-dates.js';

const log = createChildLogger('node:execute');

interface Ctx {
  state: AgentState;
  user: IUser;
  config: UserConfig;
  tz: string;
  today: string;
  tomorrow: string;
  now: Date;
  replanDates: Set<string>;
  planningContext: PlanningContext;
  messages: string[];
  data: Record<string, unknown>;
  success: boolean;
  action: string;
  /** Which date's full timeline to hand back (REPLAN / SHOW_PLAN). */
  timelineDate?: string;
}

const dueLabel = (ctx: Ctx, task: ITask) => task.dueDate ? ` (due ${formatDateHuman(formatDateString(task.dueDate, ctx.tz))})` : '';

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function addTasks(ctx: Ctx, tasks: ExtractedTask[], announce = true): Promise<ITask[]> {
  const created: ITask[] = [];
  const dupes: string[] = [];
  // Deterministic date read of the message — only trusted when it is unambiguous (one hint, one task).
  const hints = extractDateHints(ctx.state.rawInput, ctx.now, ctx.tz);
  const hint = tasks.length === 1 && hints.length === 1 ? hints[0] : undefined;

  for (let t of tasks) {
    const title = t.title?.trim();
    if (!title) continue;

    let fixedStart = normalizeTimeString(t.fixedStartTime);
    let fixedEnd = normalizeTimeString(t.fixedEndTime);
    if (hint?.time && !fixedStart && !t.recurrence?.pattern && /\b(at|from|@)\b/i.test(hint.text)) {
      // The user gave a clock time the model dropped → treat it as a fixed slot.
      fixedStart = hint.time;
      fixedEnd = hint.endTime ?? null;
      if (!fixedEnd) {
        const mins = Math.max(15, t.estimatedMinutes ?? 30);
        const endDate = new Date(parseTimeString(fixedStart, ctx.today, ctx.tz).getTime() + mins * 60_000);
        fixedEnd = formatTime(endDate, ctx.tz);
      }
      t = { ...t, isFixed: true };
    }
    const isFixed = !!(t.isFixed && fixedStart && fixedEnd && fixedStart < fixedEnd);
    const recurrence = t.recurrence?.pattern ? { pattern: t.recurrence.pattern, days: normalizeDays(t.recurrence.days) } : undefined;

    let dueStr = isValidDateString(t.dueDate) ? t.dueDate : null;
    if (hint && !recurrence) {
      if (!dueStr && hint.date !== ctx.today) dueStr = hint.date;                 // model dropped the date
      else if (dueStr && dueStr < ctx.today && hint.date >= ctx.today) dueStr = hint.date; // model picked a past date
    }
    if (isFixed && !dueStr && !recurrence) {
      // "meeting at 3" with no date = today, or tomorrow if that time is already gone.
      dueStr = parseTimeString(fixedEnd!, ctx.today, ctx.tz) <= ctx.now ? ctx.tomorrow : ctx.today;
    }

    let estimatedMinutes = Math.max(5, t.estimatedMinutes ?? 30);
    if (isFixed) {
      const mins = (parseTimeString(fixedEnd!, ctx.today, ctx.tz).getTime() - parseTimeString(fixedStart!, ctx.today, ctx.tz).getTime()) / 60_000;
      if (mins > 0) estimatedMinutes = mins;
    }

    const { task, created: isNew } = await taskRepo.createIfNew({
      userId: ctx.user._id as any,
      telegramId: ctx.state.telegramId,
      title,
      description: t.description ?? undefined,
      priority: t.priority ?? undefined,
      cognitiveLoad: t.cognitiveLoad ?? undefined,
      estimatedMinutes,
      dueDate: dueStr ? dateStringToDate(dueStr, ctx.tz) : undefined,
      preferredTime: t.preferredTime ?? undefined,
      tags: t.tags ?? undefined,
      isFixed,
      fixedStartTime: isFixed ? fixedStart! : undefined,
      fixedEndTime: isFixed ? fixedEnd! : undefined,
      recurrence,
    });

    if (isNew) created.push(task); else dupes.push(task.title);

    ctx.replanDates.add(ctx.today);
    if (dueStr && dueStr > ctx.today && daysBetween(ctx.today, dueStr) <= PLANNING.LOOKAHEAD_DAYS) {
      ctx.replanDates.add(dueStr);
    }
  }

  if (announce) {
    if (created.length > 0) {
      ctx.messages.push(`Added: ${created.map(t => `"${t.title}"${dueLabel(ctx, t)}${t.isFixed && t.fixedStartTime ? ` at ${t.fixedStartTime}` : ''}`).join(', ')}.`);
    }
    if (dupes.length > 0) ctx.messages.push(`Already on the list: ${dupes.map(d => `"${d}"`).join(', ')}.`);
    if (created.length === 0 && dupes.length === 0) {
      ctx.success = false;
      ctx.messages.push("I couldn't work out what task to add.");
    }
  }
  ctx.data.tasks = created.map(t => ({ id: String(t._id), title: t.title, dueDate: t.dueDate ? formatDateString(t.dueDate, ctx.tz) : null }));
  return created;
}

async function askWhichTask(ctx: Ctx, verb: string, ref?: string | null): Promise<void> {
  const open = await taskRepo.findOpenTasksForDate(ctx.state.telegramId, ctx.today);
  const candidates = open.slice(0, 8).map(t => t.title);
  ctx.success = false;
  ctx.data.candidates = candidates;
  ctx.messages.push(ref
    ? `I couldn't find a task matching "${ref}" to ${verb}.${candidates.length ? ` Open tasks: ${candidates.join(', ')}.` : ''}`
    : `Which task should I ${verb}?${candidates.length ? ` Open tasks: ${candidates.join(', ')}.` : ' You have no open tasks.'}`);
  if (candidates.length > 0) {
    await setPendingAction(ctx.state.telegramId, { type: 'clarify_task', candidates }).catch(() => undefined);
  }
}

async function modifyTask(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const task = await taskRepo.resolveTask(ctx.state.telegramId, payload.taskReference);
  if (!task) return askWhichTask(ctx, 'change', payload.taskReference);

  const t = payload.tasks[0];
  const updates: Record<string, unknown> = {};
  let placementChanged = false;
  let newDueStr: string | null = null;

  if (t) {
    if (t.title && t.title.trim() && t.title.trim().toLowerCase() !== task.title.toLowerCase()) updates.title = t.title.trim();
    if (t.description) updates.description = t.description;
    if (t.priority) updates.priority = t.priority;
    if (t.cognitiveLoad) updates.cognitiveLoad = t.cognitiveLoad;
    if (t.estimatedMinutes && t.estimatedMinutes !== task.estimatedMinutes) { updates.estimatedMinutes = Math.max(5, t.estimatedMinutes); placementChanged = true; }
    if (t.preferredTime) { updates.preferredTime = t.preferredTime; placementChanged = true; }
    if (t.recurrence?.pattern) updates.recurrence = { pattern: t.recurrence.pattern, days: normalizeDays(t.recurrence.days) };

    const fixedStart = normalizeTimeString(t.fixedStartTime);
    const fixedEnd = normalizeTimeString(t.fixedEndTime);
    if (fixedStart && fixedEnd && fixedStart < fixedEnd) {
      updates.isFixed = true;
      updates.fixedStartTime = fixedStart;
      updates.fixedEndTime = fixedEnd;
      placementChanged = true;
      if (!isValidDateString(t.dueDate) && !task.dueDate) {
        newDueStr = parseTimeString(fixedEnd, ctx.today, ctx.tz) <= ctx.now ? ctx.tomorrow : ctx.today;
      }
    } else if (t.isFixed === false && task.isFixed) {
      updates.isFixed = false;
      placementChanged = true;
    }

    if (isValidDateString(t.dueDate)) newDueStr = t.dueDate;
  }

  if (newDueStr) {
    updates.dueDate = dateStringToDate(newDueStr, ctx.tz);
    // "Move X to Friday" means do it Friday, not "any time before Friday".
    updates.deferredUntil = newDueStr > ctx.today ? newDueStr : null;
    placementChanged = true;
  }

  if (Object.keys(updates).length === 0) {
    ctx.success = false;
    ctx.messages.push(`I found "${task.title}" but couldn't tell what to change.`);
    return;
  }

  await taskRepo.updateTask(String(task._id), updates);
  if (placementChanged) {
    const removedFrom = await scheduleRepo.removeTaskEntries(ctx.state.telegramId, String(task._id), ctx.today);
    removedFrom.forEach(d => ctx.replanDates.add(d));
  }
  ctx.replanDates.add(ctx.today);
  if (newDueStr && newDueStr > ctx.today && daysBetween(ctx.today, newDueStr) <= PLANNING.LOOKAHEAD_DAYS) ctx.replanDates.add(newDueStr);

  const what: string[] = [];
  if (newDueStr) what.push(`moved to ${formatDateHuman(newDueStr)}`);
  if (updates.fixedStartTime) what.push(`set to ${updates.fixedStartTime}–${updates.fixedEndTime}`);
  if (updates.estimatedMinutes) what.push(`now ${formatMinutes(updates.estimatedMinutes as number)}`);
  if (updates.priority) what.push(`priority ${updates.priority}`);
  if (updates.title) what.push(`renamed to "${updates.title}"`);
  if (updates.preferredTime) what.push(`preferred ${updates.preferredTime}`);
  ctx.messages.push(`Updated "${task.title}"${what.length ? ` — ${what.join(', ')}` : ''}.`);
}

async function deleteTask(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const task = await taskRepo.resolveTask(ctx.state.telegramId, payload.taskReference);
  if (!task) return askWhichTask(ctx, 'delete', payload.taskReference);
  await taskRepo.deleteTask(String(task._id));
  const removedFrom = await scheduleRepo.removeTaskEntries(ctx.state.telegramId, String(task._id), ctx.today);
  removedFrom.forEach(d => ctx.replanDates.add(d));
  ctx.replanDates.add(ctx.today);
  ctx.messages.push(`Deleted "${task.title}".`);
}

async function completeTaskHandler(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const ref = payload.taskReference;
  let task = await taskRepo.resolveTask(ctx.state.telegramId, ref);
  if (!task && !ref) task = await inferCurrentTask(ctx.state.telegramId, ctx.today, ctx.tz, ctx.now);
  if (!task) return askWhichTask(ctx, 'mark as done', ref);

  const result = await completeTask(ctx.user, ctx.config, task, ctx.today, ctx.now);
  ctx.replanDates.add(ctx.today);
  let msg = `Marked "${task.title}" done${result.late ? ' (a little after its slot — no problem)' : ''}.`;
  if (result.next?.dueDate) msg += ` Next one is queued for ${formatDateHuman(formatDateString(result.next.dueDate, ctx.tz))}.`;
  ctx.messages.push(msg);
}

async function skipTaskHandler(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const ref = payload.taskReference;
  let task = await taskRepo.resolveTask(ctx.state.telegramId, ref);
  if (!task && !ref) task = await inferCurrentTask(ctx.state.telegramId, ctx.today, ctx.tz, ctx.now);
  if (!task) return askWhichTask(ctx, 'skip', ref);

  const result = await skipTaskToday(ctx.user, task, ctx.today);
  ctx.replanDates.add(ctx.today);
  ctx.messages.push(`Skipped "${task.title}" for today; it's back on the list for ${formatDateHuman(result.deferredUntil)}.`);
}

async function memoryHandler(ctx: Ctx, payload: IntentPayload): Promise<void> {
  // The signals themselves were stored by extract-memory. Only one-off events become tasks.
  const oneOffs = payload.tasks.filter(t => isValidDateString(t.dueDate));
  if (oneOffs.length > 0) {
    await addTasks(ctx, oneOffs);
  } else {
    ctx.messages.push("Noted — I'll plan around that from now on.");
  }
  ctx.replanDates.add(ctx.today);
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'over', 'stop', 'stopped', 'more', 'anymore', 'going', 'doing'].includes(w));
}

async function removeMemoryHandler(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const ref = payload.memoryReference ?? payload.taskReference ?? ctx.state.rawInput;
  const words = tokens(ref);
  const telegramId = ctx.state.telegramId;

  const [habits, constraints, prefs] = await Promise.all([
    Habit.find({ telegramId, isActive: true }),
    Constraint.find({ telegramId, isActive: true }),
    preferenceRepo.findByTelegramId(telegramId),
  ]);

  type Cand = { kind: 'habit' | 'constraint' | 'preference'; key: string; label: string; score: number; doc: any };
  const score = (hay: string) => { const h = hay.toLowerCase(); return words.filter(w => h.includes(w)).length; };
  const cands: Cand[] = [
    ...habits.map(h => ({ kind: 'habit' as const, key: h.key, label: `${h.key.replace(/_/g, ' ')} (habit)`, score: score(`${h.key} ${h.description}`), doc: h })),
    ...constraints.map(c => ({ kind: 'constraint' as const, key: c.key, label: `${c.key.replace(/_/g, ' ')} (commitment)`, score: score(`${c.key} ${c.description}`), doc: c })),
    ...prefs.map(p => ({ kind: 'preference' as const, key: p.key, label: `${p.key.replace(/_/g, ' ')}: ${p.value} (preference)`, score: score(`${p.key} ${p.value}`), doc: p })),
  ].sort((a, b) => b.score - a.score);

  const best = cands[0];
  if (!best || best.score === 0) {
    ctx.success = false;
    const known = cands.slice(0, 8).map(c => c.label);
    ctx.messages.push(`I couldn't tell which of your routines or commitments to drop.${known.length ? ` I currently know: ${known.join('; ')}.` : ''}`);
    ctx.data.candidates = known;
    return;
  }

  if (best.kind === 'habit') await Habit.updateOne({ _id: best.doc._id }, { $set: { isActive: false } });
  else if (best.kind === 'constraint') await Constraint.updateOne({ _id: best.doc._id }, { $set: { isActive: false } });
  else await preferenceRepo.remove(telegramId, best.key);

  try {
    const llm = getLLMProvider();
    await new SemanticMemory((t) => llm.getEmbedding(t)).deleteByKey(telegramId, best.key);
  } catch (err) {
    log.debug({ err }, 'Vector memory delete skipped');
  }

  ctx.replanDates.add(ctx.today);
  ctx.messages.push(`Dropped ${best.label}. I won't plan around it anymore.`);
}

function replanHandler(ctx: Ctx, payload: IntentPayload): void {
  const date = isValidDateString(payload.targetDate) && payload.targetDate >= ctx.today ? payload.targetDate : ctx.today;
  ctx.replanDates.add(date);
  ctx.timelineDate = date;
  if (payload.replanContext && !ctx.planningContext.reason) ctx.planningContext.reason = payload.replanContext;
  if (!ctx.planningContext.trigger) ctx.planningContext.trigger = 'explicit_replan';
  if (!ctx.planningContext.scheduleStability) ctx.planningContext.scheduleStability = 'moderate';
}

async function showPlanHandler(ctx: Ctx, payload: IntentPayload): Promise<void> {
  const date = isValidDateString(payload.targetDate) ? payload.targetDate : ctx.today;
  const schedule = await scheduleRepo.findByDate(ctx.state.telegramId, date);
  const openTasks = await taskRepo.findOpenTasksForDate(ctx.state.telegramId, date);
  const label = date === ctx.today ? 'today' : date === ctx.tomorrow ? 'tomorrow' : formatDateHuman(date);
  const eligible = openTasks.filter(t => taskEligibility(t, date, ctx.tz).eligible);

  ctx.data.targetDate = date;
  ctx.data.pendingTasks = eligible.map(t => ({ title: t.title, estimatedMinutes: t.estimatedMinutes, dueDate: t.dueDate ? formatDateString(t.dueDate, ctx.tz) : null }));

  if (!schedule || schedule.entries.length === 0) {
    if (date >= ctx.today && eligible.length > 0) {
      // A manager wouldn't say "no plan" — they'd make one.
      ctx.replanDates.add(date);
      ctx.timelineDate = date;
      ctx.messages.push(`There was no plan for ${label} yet, so I built one.`);
    } else {
      ctx.messages.push(`Nothing planned for ${label}${eligible.length === 0 ? ' and no open tasks for it' : ''}.`);
      ctx.data.scheduleSummary = 'empty';
    }
    return;
  }

  ctx.timelineDate = date;
  ctx.data.scheduleText = `📅 *${label === 'today' ? "Today's plan" : `Plan for ${label}`}*\n` + formatScheduleLines(schedule.entries, ctx.tz).join('\n');
  ctx.data.scheduleSummary = schedule.entries.map(e => `${formatTimeHuman(new Date(e.startTime), ctx.tz)} ${e.title} [${e.status}]`).join('; ');
  const remaining = schedule.entries.filter(e => e.taskId && (e.status === 'scheduled' || e.status === 'active')).length;
  ctx.messages.push(`Plan for ${label}: ${schedule.entries.length} blocks, ${remaining} task blocks still to do.`);
}

async function handle(ctx: Ctx, payload: IntentPayload): Promise<void> {
  switch (payload.intent) {
    case IntentType.ADD_TASK: {
      const fromImage = payload.tasks.length === 0 && ctx.state.imageContext?.tasks?.length
        ? ctx.state.imageContext.tasks.map(t => ({ ...t, cognitiveLoad: 2 as const, preferredTime: null, tags: [] as string[], recurrence: null }))
        : [];
      await addTasks(ctx, [...payload.tasks, ...fromImage]);
      return;
    }
    case IntentType.MODIFY_TASK: return modifyTask(ctx, payload);
    case IntentType.DELETE_TASK: return deleteTask(ctx, payload);
    case IntentType.COMPLETE_TASK: return completeTaskHandler(ctx, payload);
    case IntentType.SKIP_TASK: return skipTaskHandler(ctx, payload);
    case IntentType.ADD_PREFERENCE:
    case IntentType.ADD_CONSTRAINT:
    case IntentType.ADD_HABIT: return memoryHandler(ctx, payload);
    case IntentType.REMOVE_MEMORY: return removeMemoryHandler(ctx, payload);
    case IntentType.REPLAN: return replanHandler(ctx, payload);
    case IntentType.SHOW_PLAN: return showPlanHandler(ctx, payload);
    case IntentType.IMAGE_CONTEXT: {
      const imgTasks = ctx.state.imageContext?.tasks ?? [];
      if (payload.tasks.length > 0 || imgTasks.length > 0) {
        await addTasks(ctx, payload.tasks.length > 0 ? payload.tasks : imgTasks.map(t => ({ ...t, cognitiveLoad: 2 as const, preferredTime: null, tags: [] as string[], recurrence: null })));
      } else {
        ctx.messages.push(ctx.state.imageContext ? `I read the image but found no tasks in it: ${ctx.state.imageContext.content.slice(0, 200)}` : 'No image found.');
      }
      ctx.data.imageContent = ctx.state.imageContext?.content;
      return;
    }
    default:
      return;
  }
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export async function executeActionNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.intent) {
    return { actionResult: { success: false, action: 'none', message: 'No intent classified' } };
  }

  const user = await userRepo.findByTelegramId(state.telegramId);
  if (!user) {
    return { actionResult: { success: false, action: 'none', message: 'User not found. Please send /start first.' } };
  }

  const config = resolveUserConfig(user.settings);
  const ctx: Ctx = {
    state,
    user,
    config,
    tz: config.timezone,
    today: planningDateString(config.timezone, config.lateNightThresholdHour),
    tomorrow: tomorrowString(config.timezone, config.lateNightThresholdHour),
    now: new Date(),
    replanDates: new Set<string>(),
    planningContext: { ...(state.autonomyContext?.planningContext ?? {}) },
    messages: [],
    data: {},
    success: true,
    action: state.intent.intent.toLowerCase(),
  };

  const primaryIntent = state.intent.intent === IntentType.GENERAL_CHAT && state.autonomyContext?.shouldReplan
    ? IntentType.REPLAN
    : state.intent.intent;

  const primary: IntentPayload = {
    intent: primaryIntent,
    tasks: state.intent.tasks,
    taskReference: state.intent.taskReference,
    memoryReference: state.intent.memoryReference,
    replanContext: state.intent.replanContext ?? state.autonomyContext?.summary,
    targetDate: state.intent.targetDate,
  };

  try {
    await handle(ctx, primary);
  } catch (error) {
    log.error({ error, intent: primary.intent }, 'Primary intent failed');
    ctx.success = false;
    ctx.messages.push('Something went wrong while doing that.');
  }

  for (const secondary of state.intent.secondaryIntents) {
    try {
      await handle(ctx, secondary);
    } catch (error) {
      log.error({ error, intent: secondary.intent }, 'Secondary intent failed');
    }
  }

  if (state.memoryChanged && primaryIntent === IntentType.GENERAL_CHAT) {
    ctx.replanDates.add(ctx.today);
    if (ctx.messages.length === 0) ctx.messages.push('Noted that routine — I folded it into today.');
  }

  // ─── Replans (one per affected date, serialized per user) ───────────────────
  if (ctx.replanDates.size > 0) {
    const outcomes = await replanDates(state.telegramId, ctx.replanDates, ctx.planningContext);
    const focusDate = ctx.timelineDate ?? ctx.today;
    const focus = outcomes.find(o => o.date === focusDate) ?? outcomes.find(o => o.date === ctx.today);

    if (focus) {
      const label = focus.date === ctx.today ? 'today' : focus.date === ctx.tomorrow ? 'tomorrow' : formatDateHuman(focus.date);
      const upcoming = focus.entries.filter(e => e.status === 'scheduled' && new Date(e.endTime) > ctx.now);
      ctx.data.scheduledCount = focus.scheduledTaskCount;
      ctx.data.targetDate = focus.date;

      if (ctx.timelineDate) {
        ctx.data.scheduleText = `📅 *${label === 'today' ? "Today's plan" : `Plan for ${label}`}*\n` + formatScheduleLines(focus.entries, ctx.tz).join('\n');
        ctx.data.scheduleSummary = upcoming.map(e => `${formatTimeHuman(new Date(e.startTime), ctx.tz)} ${e.title}`).join('; ') || 'nothing left to schedule';
        ctx.messages.push(`Planned ${label}: ${focus.scheduledTaskCount} task block${focus.scheduledTaskCount === 1 ? '' : 's'}.`);
      } else if (focus.date === ctx.today) {
        const next = upcoming[0];
        if (next) ctx.data.nextUp = `${next.title} at ${formatTimeHuman(new Date(next.startTime), ctx.tz)}`;
        ctx.messages.push(`Today now has ${focus.scheduledTaskCount} task block${focus.scheduledTaskCount === 1 ? '' : 's'} left${next ? `; next up is ${next.title} at ${formatTimeHuman(new Date(next.startTime), ctx.tz)}` : ''}.`);
      }

      const leftovers = describeUnscheduled(focus.unscheduled, { escape: false });
      if (leftovers) {
        ctx.data.unscheduledSummary = leftovers;
        ctx.messages.push(leftovers);
      }
    }
  } else if (ctx.success && !ctx.timelineDate && primaryIntent !== IntentType.SHOW_PLAN) {
    const next = await nextUpcomingEntry(state.telegramId, ctx.today, ctx.now);
    if (next) ctx.data.nextUp = `${next.title} at ${formatTimeHuman(new Date(next.startTime), ctx.tz)}`;
  }

  const result: ActionResult = {
    success: ctx.success,
    action: ctx.action,
    message: ctx.messages.join(' ') || (primaryIntent === IntentType.GENERAL_CHAT ? 'Just chatting.' : 'Done.'),
    data: ctx.data,
  };
  return { actionResult: result };
}
