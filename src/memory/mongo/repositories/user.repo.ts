import { User, type IUser } from '../models/user.model.js';
import type { UserSettings } from '../../../config/config-resolver.js';

export class UserRepository {
  async findByTelegramId(telegramId: number): Promise<IUser | null> {
    return User.findOne({ telegramId });
  }

  async createOrUpdate(telegramId: number, data: {
    firstName: string;
    lastName?: string;
    username?: string;
  }): Promise<IUser> {
    return User.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          ...data,
          lastInteraction: new Date(),
        },
        $setOnInsert: {
          telegramId,
          settings: {},
          isActive: true,
        },
      },
      { upsert: true, new: true }
    ) as unknown as IUser;
  }

  async updateSettings(telegramId: number, settings: Partial<UserSettings>): Promise<IUser | null> {
    const updateFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        updateFields[`settings.${key}`] = value;
      }
    }
    return User.findOneAndUpdate(
      { telegramId },
      { $set: updateFields },
      { new: true }
    );
  }

  async updateLastInteraction(telegramId: number): Promise<void> {
    await User.updateOne({ telegramId }, { $set: { lastInteraction: new Date() } });
  }

  async getAllActiveUsers(): Promise<IUser[]> {
    return User.find({ isActive: true });
  }
}

export const userRepo = new UserRepository();
