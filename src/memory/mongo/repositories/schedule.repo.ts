import mongoose from 'mongoose';
import { Schedule, type ISchedule } from '../models/schedule.model.js';
import type { IScheduleEntry } from '../models/schedule.model.js';

export class ScheduleRepository {
  async findByDate(telegramId: number, date: string): Promise<ISchedule | null> {
    return Schedule.findOne({ telegramId, date });
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

  async getLastReplanTime(telegramId: number, date: string): Promise<Date | null> {
    const schedule = await Schedule.findOne({ telegramId, date }, { lastReplanAt: 1 });
    return schedule?.lastReplanAt ?? null;
  }
}

export const scheduleRepo = new ScheduleRepository();
