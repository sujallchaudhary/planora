import mongoose from 'mongoose';
import { Schedule, type ISchedule } from '../models/schedule.model.js';
import type { IScheduleEntry } from '../models/schedule.model.js';
import { ScheduleEntryStatus } from '../../../config/defaults.js';

export class ScheduleRepository {
  async findByDate(telegramId: number, date: string): Promise<ISchedule | null> {
    return Schedule.findOne({ telegramId, date });
  }

  async findDatesFrom(telegramId: number, fromDate: string): Promise<ISchedule[]> {
    return Schedule.find({ telegramId, date: { $gte: fromDate } }).sort({ date: 1 });
  }

  async createOrReplace(telegramId: number, userId: mongoose.Types.ObjectId, date: string, entries: IScheduleEntry[]): Promise<ISchedule> {
    const existing = await this.findByDate(telegramId, date);
    const version = existing ? existing.version + 1 : 1;

    return Schedule.findOneAndUpdate(
      { telegramId, date },
      {
        $set: {
          userId,
          entries,
          version,
          lastReplanAt: new Date(),
        },
      },
      { upsert: true, new: true }
    ) as unknown as ISchedule;
  }

  async updateEntry(telegramId: number, date: string, entryId: string, updates: Partial<IScheduleEntry>): Promise<ISchedule | null> {
    const updateFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      updateFields[`entries.$.${key}`] = value;
    }
    return Schedule.findOneAndUpdate(
      { telegramId, date, 'entries._id': entryId },
      { $set: updateFields },
      { new: true }
    );
  }

  async updateEntryStatus(telegramId: number, date: string, entryId: string, status: string): Promise<ISchedule | null> {
    return this.updateEntry(telegramId, date, entryId, { status } as Partial<IScheduleEntry>);
  }

  /**
   * Set the status of every still-open entry for a task across ALL dates
   * (a task completed today must not ping tomorrow).
   */
  async updateTaskEntriesStatus(telegramId: number, taskId: mongoose.Types.ObjectId | string, status: ScheduleEntryStatus): Promise<void> {
    const id = typeof taskId === 'string' ? new mongoose.Types.ObjectId(taskId) : taskId;
    await Schedule.updateMany(
      { telegramId, 'entries.taskId': id },
      { $set: { 'entries.$[e].status': status } },
      { arrayFilters: [{ 'e.taskId': id, 'e.status': { $in: [ScheduleEntryStatus.SCHEDULED, ScheduleEntryStatus.ACTIVE] } }] },
    );
  }

  /** Remove every entry for a task from every schedule on or after `fromDate` (used on delete / reschedule). */
  async removeTaskEntries(telegramId: number, taskId: mongoose.Types.ObjectId | string, fromDate?: string): Promise<string[]> {
    const id = typeof taskId === 'string' ? new mongoose.Types.ObjectId(taskId) : taskId;
    const query: Record<string, unknown> = { telegramId, 'entries.taskId': id };
    if (fromDate) query.date = { $gte: fromDate };
    const affected = await Schedule.find(query, { date: 1 });
    await Schedule.updateMany(query, { $pull: { entries: { taskId: id } } });
    return affected.map(s => s.date);
  }

  async getLastReplanTime(telegramId: number, date: string): Promise<Date | null> {
    const schedule = await Schedule.findOne({ telegramId, date }, { lastReplanAt: 1 });
    return schedule?.lastReplanAt ?? null;
  }
}

export const scheduleRepo = new ScheduleRepository();
