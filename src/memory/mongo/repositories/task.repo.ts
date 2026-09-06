import mongoose from 'mongoose';
import { Task, type ITask, type ITaskRecurrence } from '../models/task.model.js';
import { TaskStatus, OPEN_TASK_STATUSES } from '../../../config/defaults.js';

export interface CreateTaskInput {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  title: string;
  description?: string;
  priority?: number;
  cognitiveLoad?: number;
  estimatedMinutes?: number;
  dueDate?: Date;
  preferredTime?: string;
  tags?: string[];
  isFixed?: boolean;
  fixedStartTime?: string;
  fixedEndTime?: string;
  recurrence?: ITaskRecurrence;
  deferredUntil?: string;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class TaskRepository {
  async create(data: CreateTaskInput): Promise<ITask> {
    return Task.create(data);
  }

  /**
   * Create a task unless an open task with the same normalized title already exists.
   * Returns the existing task and `created: false` in that case.
   */
  async createIfNew(data: CreateTaskInput): Promise<{ task: ITask; created: boolean }> {
    const open = await this.findOpenTasks(data.telegramId);
    const wanted = normalizeTitle(data.title);
    const dupe = open.find(t => normalizeTitle(t.title) === wanted && sameDay(t.dueDate, data.dueDate));
    if (dupe) return { task: dupe, created: false };
    return { task: await Task.create(data), created: true };
  }

  async findByTelegramId(telegramId: number, statuses?: string[]): Promise<ITask[]> {
    const query: Record<string, unknown> = { telegramId };
    if (statuses && statuses.length > 0) {
      query.status = { $in: statuses };
    }
    return Task.find(query).sort({ priority: -1, createdAt: 1 });
  }

  /** All tasks that still need doing (regardless of deferral). */
  async findOpenTasks(telegramId: number): Promise<ITask[]> {
    return Task.find({ telegramId, status: { $in: OPEN_TASK_STATUSES } }).sort({ priority: -1, createdAt: 1 });
  }

  /** @deprecated use findOpenTasks */
  async findPendingTasks(telegramId: number): Promise<ITask[]> {
    return this.findOpenTasks(telegramId);
  }

  /** Open tasks that are allowed to be scheduled on `dateStr` (honours deferredUntil). */
  async findOpenTasksForDate(telegramId: number, dateStr: string): Promise<ITask[]> {
    return Task.find({
      telegramId,
      status: { $in: OPEN_TASK_STATUSES },
      $or: [{ deferredUntil: { $exists: false } }, { deferredUntil: null }, { deferredUntil: { $lte: dateStr } }],
    }).sort({ priority: -1, createdAt: 1 });
  }

  async findById(taskId: string): Promise<ITask | null> {
    if (!mongoose.isValidObjectId(taskId)) return null;
    return Task.findById(taskId);
  }

  async findByTitle(telegramId: number, titleSearch: string): Promise<ITask[]> {
    const escaped = titleSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Task.find({
      telegramId,
      title: { $regex: escaped, $options: 'i' },
      status: { $in: OPEN_TASK_STATUSES },
    });
  }

  /**
   * Resolve a loose reference from the LLM (a Mongo id, an exact title, a fragment,
   * or a few keywords) to a single open task. Never throws on bad ids.
   */
  async resolveTask(telegramId: number, ref: string | null | undefined): Promise<ITask | null> {
    if (!ref) return null;
    const trimmed = ref.trim();
    if (!trimmed) return null;

    if (mongoose.isValidObjectId(trimmed)) {
      const byId = await Task.findOne({ _id: trimmed, telegramId });
      if (byId) return byId;
    }

    const open = await this.findOpenTasks(telegramId);
    if (open.length === 0) return null;

    const wanted = normalizeTitle(trimmed);
    const exact = open.find(t => normalizeTitle(t.title) === wanted);
    if (exact) return exact;

    const contains = open.filter(t => {
      const title = normalizeTitle(t.title);
      return title.includes(wanted) || wanted.includes(title);
    });
    if (contains.length === 1) return contains[0]!;
    if (contains.length > 1) {
      // Prefer the shortest title (most specific match)
      return contains.sort((a, b) => a.title.length - b.title.length)[0]!;
    }

    const tokens = wanted.split(' ').filter(w => w.length > 2);
    if (tokens.length === 0) return null;
    let best: ITask | null = null;
    let bestScore = 0;
    for (const t of open) {
      const title = normalizeTitle(t.title);
      const score = tokens.filter(w => title.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return bestScore > 0 ? best : null;
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<ITask | null> {
    return Task.findByIdAndUpdate(taskId, { $set: { status } }, { new: true });
  }

  async updateTask(taskId: string, updates: Record<string, unknown>): Promise<ITask | null> {
    return Task.findByIdAndUpdate(taskId, { $set: updates }, { new: true });
  }

  async markCompleted(taskId: string, actualMinutes?: number): Promise<ITask | null> {
    return Task.findByIdAndUpdate(
      taskId,
      { $set: { status: TaskStatus.COMPLETED, completedAt: new Date(), ...(actualMinutes ? { actualMinutes } : {}) }, $unset: { deferredUntil: 1 } },
      { new: true },
    );
  }

  /** Keep the task open but push it to `dateStr` (skip today, roll to tomorrow, ...). */
  async deferTask(taskId: string, dateStr: string): Promise<ITask | null> {
    return Task.findByIdAndUpdate(
      taskId,
      { $set: { status: TaskStatus.PENDING, deferredUntil: dateStr }, $inc: { deferCount: 1 } },
      { new: true },
    );
  }

  /** Task was missed: keep it open (no deferral) so it can be re-fitted later today. */
  async markMissedButOpen(taskId: string): Promise<ITask | null> {
    return Task.findByIdAndUpdate(
      taskId,
      { $set: { status: TaskStatus.PENDING }, $inc: { deferCount: 1 } },
      { new: true },
    );
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const result = await Task.findByIdAndDelete(taskId);
    return !!result;
  }

  async countPendingTasks(telegramId: number): Promise<number> {
    return Task.countDocuments({ telegramId, status: { $in: OPEN_TASK_STATUSES } });
  }

  async findCompletedBetween(telegramId: number, from: Date, to: Date): Promise<ITask[]> {
    return Task.find({ telegramId, status: TaskStatus.COMPLETED, completedAt: { $gte: from, $lt: to } });
  }
}

function sameDay(a?: Date | null, b?: Date | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) < 36 * 60 * 60 * 1000;
}

export const taskRepo = new TaskRepository();
