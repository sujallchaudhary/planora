import mongoose from 'mongoose';
import { TaskHistory, type ITaskHistory } from '../models/task-history.model.js';

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

  async getMorningCompletionRate(telegramId: number, days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const morningTasks = await TaskHistory.find({
      telegramId,
      createdAt: { $gte: cutoff },
    });
    // Filter for tasks scheduled before noon
    const morning = morningTasks.filter(t => t.scheduledStartTime.getHours() < 12);
    if (morning.length === 0) return 0;
    const completed = morning.filter(t => t.outcome === 'completed' || t.outcome === 'completed_late');
    return completed.length / morning.length;
  }

  async getCompletionRatesByTimeBlock(telegramId: number, days: number): Promise<Record<string, { total: number; completed: number; rate: number }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const histories = await TaskHistory.find({
      telegramId,
      createdAt: { $gte: cutoff },
    });

    const blocks: Record<string, { total: number; completed: number; rate: number }> = {
      morning: { total: 0, completed: 0, rate: 0 },
      afternoon: { total: 0, completed: 0, rate: 0 },
      evening: { total: 0, completed: 0, rate: 0 },
      night: { total: 0, completed: 0, rate: 0 },
    };

    for (const history of histories) {
      const hour = history.scheduledStartTime.getHours();
      const block = hour < 12
        ? 'morning'
        : hour < 17
          ? 'afternoon'
          : hour < 21
            ? 'evening'
            : 'night';

      blocks[block]!.total += 1;
      if (history.outcome === 'completed' || history.outcome === 'completed_late') {
        blocks[block]!.completed += 1;
      }
    }

    for (const block of Object.values(blocks)) {
      block.rate = block.total > 0 ? block.completed / block.total : 0;
    }

    return blocks;
  }
}

export const taskHistoryRepo = new TaskHistoryRepository();
