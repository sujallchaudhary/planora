import mongoose from 'mongoose';
import { Preference, type IPreference } from '../models/preference.model.js';

export class PreferenceRepository {
  /**
   * Upsert a preference. Repeated explicit evidence *reinforces* confidence instead of
   * overwriting it; a contradicting value resets to the new evidence's confidence.
   */
  async upsert(telegramId: number, userId: mongoose.Types.ObjectId, data: {
    key: string;
    value: string;
    confidence: number;
    source: 'explicit' | 'inferred';
  }): Promise<IPreference> {
    const existing = await Preference.findOne({ telegramId, key: data.key });
    let confidence = data.confidence;
    if (existing) {
      const sameValue = existing.value.trim().toLowerCase() === data.value.trim().toLowerCase();
      if (sameValue) {
        confidence = Math.min(0.98, Math.max(existing.confidence, data.confidence) + 0.04);
      } else if (data.source === 'inferred' && existing.source === 'explicit') {
        // Never let a statistical guess silently override what the user told us.
        confidence = Math.min(data.confidence, existing.confidence - 0.05);
        if (confidence < 0.5) return existing;
      }
    }

    return Preference.findOneAndUpdate(
      { telegramId, key: data.key },
      {
        $set: { userId, value: data.value, confidence, source: data.source },
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

  async findByKey(telegramId: number, key: string): Promise<IPreference | null> {
    return Preference.findOne({ telegramId, key });
  }

  async adjustConfidence(telegramId: number, key: string, delta: number): Promise<IPreference | null> {
    const pref = await Preference.findOne({ telegramId, key });
    if (!pref) return null;
    pref.confidence = Math.max(0, Math.min(1, pref.confidence + delta));
    pref.dataPoints += 1;
    return pref.save();
  }

  async remove(telegramId: number, key: string): Promise<boolean> {
    const res = await Preference.deleteOne({ telegramId, key });
    return res.deletedCount > 0;
  }
}

export const preferenceRepo = new PreferenceRepository();
