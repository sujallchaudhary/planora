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
}

export const taskHistoryRepo = new TaskHistoryRepository();
