import mongoose from 'mongoose';
import { TaskHistory, type ITaskHistory } from '../models/task-history.model.js';
import { hourInTimezone } from '../../../utils/date.js';

export type TimeBlockName = 'morning' | 'afternoon' | 'evening' | 'night';

export interface BlockStats { total: number; completed: number; rate: number }

export function blockForHour(hour: number): TimeBlockName {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

export class TaskHistoryRepository {
  async record(data: {
    userId: mongoose.Types.ObjectId;
    telegramId: number;
    taskId: mongoose.Types.ObjectId;
    title: string;
    scheduledDate: string;
    scheduledStartTime: Date;
    scheduledEndTime: Date;
    outcome: string;
    completedAt?: Date;
    delayMinutes?: number;
    notes?: string;
  }): Promise<ITaskHistory> {
    return TaskHistory.create(data);
  }

  async findByDateRange(telegramId: number, startDate: string, endDate: string): Promise<ITaskHistory[]> {
    return TaskHistory.find({
      telegramId,
      scheduledDate: { $gte: startDate, $lte: endDate },
    }).sort({ scheduledStartTime: 1 });
  }

  async findByDate(telegramId: number, date: string): Promise<ITaskHistory[]> {
    return TaskHistory.find({ telegramId, scheduledDate: date }).sort({ scheduledStartTime: 1 });
  }

  async findRecentHistory(telegramId: number, days: number): Promise<ITaskHistory[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return TaskHistory.find({
      telegramId,
      createdAt: { $gte: cutoff },
    }).sort({ createdAt: -1 });
  }

  async getOutcomeStats(telegramId: number, days: number): Promise<Record<string, number>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const results = await TaskHistory.aggregate([
      { $match: { telegramId, createdAt: { $gte: cutoff } } },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
    ]);
    const stats: Record<string, number> = {};
    for (const r of results) {
      stats[r._id] = r.count;
    }
    return stats;
  }

  async getMorningCompletionRate(telegramId: number, days: number, timezone: string): Promise<number> {
    const blocks = await this.getCompletionRatesByTimeBlock(telegramId, days, timezone);
    return blocks.morning.total > 0 ? blocks.morning.rate : 0;
  }

  /** Completion rates bucketed by the user's wall-clock time block. */
  async getCompletionRatesByTimeBlock(telegramId: number, days: number, timezone: string): Promise<Record<TimeBlockName, BlockStats>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const histories = await TaskHistory.find({ telegramId, createdAt: { $gte: cutoff } });

    const blocks: Record<TimeBlockName, BlockStats> = {
      morning: { total: 0, completed: 0, rate: 0 },
      afternoon: { total: 0, completed: 0, rate: 0 },
      evening: { total: 0, completed: 0, rate: 0 },
      night: { total: 0, completed: 0, rate: 0 },
    };

    for (const history of histories) {
      const block = blockForHour(hourInTimezone(history.scheduledStartTime, timezone));
      blocks[block].total += 1;
      if (history.outcome === 'completed' || history.outcome === 'completed_late') {
        blocks[block].completed += 1;
      }
    }

    for (const block of Object.values(blocks)) {
      block.rate = block.total > 0 ? block.completed / block.total : 0;
    }

    return blocks;
  }

  /**
   * How much longer completed tasks took versus their planned slot.
   * Returns the average ratio (1.0 = on time, 1.3 = 30% over) and the sample size.
   */
  async getOverrunStats(telegramId: number, days: number): Promise<{ ratio: number; samples: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const done = await TaskHistory.find({
      telegramId,
      createdAt: { $gte: cutoff },
      outcome: { $in: ['completed', 'completed_late'] },
      completedAt: { $exists: true },
    });

    let sum = 0;
    let n = 0;
    for (const h of done) {
      const planned = (h.scheduledEndTime.getTime() - h.scheduledStartTime.getTime()) / 60_000;
      if (planned <= 0 || !h.completedAt) continue;
      const actual = (h.completedAt.getTime() - h.scheduledStartTime.getTime()) / 60_000;
      // Ignore tasks completed far ahead of the slot (user did it earlier) or wildly late (forgot to tap)
      if (actual < planned * 0.3 || actual > planned * 3) continue;
      sum += actual / planned;
      n += 1;
    }
    return { ratio: n > 0 ? sum / n : 1, samples: n };
  }

  /** Tasks that were skipped/missed repeatedly in the window (procrastination signal). */
  async getRepeatedlyDeferred(telegramId: number, days: number, minTimes = 2): Promise<Array<{ taskId: string; title: string; times: number }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const rows = await TaskHistory.aggregate([
      { $match: { telegramId, createdAt: { $gte: cutoff }, outcome: { $in: ['skipped', 'missed', 'deferred'] } } },
      { $group: { _id: '$taskId', title: { $first: '$title' }, times: { $sum: 1 } } },
      { $match: { times: { $gte: minTimes } } },
      { $sort: { times: -1 } },
    ]);
    return rows.map(r => ({ taskId: String(r._id), title: r.title, times: r.times }));
  }
}

export const taskHistoryRepo = new TaskHistoryRepository();
