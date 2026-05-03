import mongoose from 'mongoose';
import { Preference, type IPreference } from '../models/preference.model.js';

export class PreferenceRepository {
  async upsert(telegramId: number, userId: mongoose.Types.ObjectId, data: {
    key: string;
    value: string;
    confidence: number;
    source: 'explicit' | 'inferred';
  }): Promise<IPreference> {
    return Preference.findOneAndUpdate(
      { telegramId, key: data.key },
      {
        $set: {
          userId,
          value: data.value,
          confidence: data.confidence,
          source: data.source,
        },
        $inc: { dataPoints: 1 },
      },
      { upsert: true, new: true }
    ) as unknown as IPreference;
  }

  async findByTelegramId(telegramId: number): Promise<IPreference[]> {
    return Preference.find({ telegramId });
  }

  async findHighConfidence(telegramId: number, threshold: number): Promise<IPreference[]> {
    return Preference.find({ telegramId, confidence: { $gte: threshold } });
  }

  async adjustConfidence(telegramId: number, key: string, delta: number): Promise<IPreference | null> {
    return Preference.findOneAndUpdate(
      { telegramId, key },
      {
        $inc: { confidence: delta, dataPoints: 1 },
        $min: { confidence: 1 },
        $max: { confidence: 0 },
      },
      { new: true }
    );
  }
}

export const preferenceRepo = new PreferenceRepository();
