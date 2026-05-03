import mongoose, { Schema, Document } from 'mongoose';

export interface IPreference extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  key: string;
  value: string;
  confidence: number;
  source: 'explicit' | 'inferred';
  dataPoints: number;
  createdAt: Date;
  updatedAt: Date;
}

const preferenceSchema = new Schema<IPreference>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String, required: true },
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    source: { type: String, enum: ['explicit', 'inferred'], default: 'explicit' },
    dataPoints: { type: Number, default: 1 },
  },
  { timestamps: true }
);

preferenceSchema.index({ telegramId: 1, key: 1 }, { unique: true });

export const Preference = mongoose.model<IPreference>('Preference', preferenceSchema);
