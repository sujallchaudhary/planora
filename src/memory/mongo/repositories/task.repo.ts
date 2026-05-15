import mongoose from 'mongoose';
import { Task, type ITask } from '../models/task.model.js';
import { TaskStatus } from '../../../config/defaults.js';

export class TaskRepository {
  async create(data: {
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
  }): Promise<ITask> {
    return Task.create(data);
  }

  async findByTelegramId(telegramId: number, statuses?: string[]): Promise<ITask[]> {
    const query: Record<string, unknown> = { telegramId };
    if (statuses && statuses.length > 0) {
      query.status = { $in: statuses };
    }
    return Task.find(query).sort({ priority: -1, createdAt: 1 });
  }

  async findPendingTasks(telegramId: number): Promise<ITask[]> {
    return Task.find({
      telegramId,
      status: { $in: [TaskStatus.PENDING, TaskStatus.SCHEDULED, TaskStatus.ACTIVE] },
    }).sort({ priority: -1, createdAt: 1 });
  }

  async findById(taskId: string): Promise<ITask | null> {
    return Task.findById(taskId);
  }

  async findByTitle(telegramId: number, titleSearch: string): Promise<ITask[]> {
    return Task.find({
      telegramId,
      title: { $regex: titleSearch, $options: 'i' },
      status: { $nin: [TaskStatus.COMPLETED, TaskStatus.SKIPPED] },
    });
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<ITask | null> {
    return Task.findByIdAndUpdate(taskId, { $set: { status } }, { new: true });
  }

  async updateTask(taskId: string, updates: Partial<ITask>): Promise<ITask | null> {
    return Task.findByIdAndUpdate(taskId, { $set: updates }, { new: true });
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const result = await Task.findByIdAndDelete(taskId);
    return !!result;
  }

  async countPendingTasks(telegramId: number): Promise<number> {
    return Task.countDocuments({
      telegramId,
      status: { $in: [TaskStatus.PENDING, TaskStatus.SCHEDULED, TaskStatus.ACTIVE] },
    });
  }
}

export const taskRepo = new TaskRepository();
