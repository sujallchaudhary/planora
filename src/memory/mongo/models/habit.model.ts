import mongoose, { Schema, Document } from 'mongoose';

export interface IHabit extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  key: string;
  description: string;
  timeRange: {
    start: string;
    end: string;
  };
  days: string[];  // ['monday', 'tuesday', ...] or ['daily']
  frequency: string;  // daily, weekdays, weekly, etc.
  confidence: number;
  dataPoints: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const habitSchema = new Schema<IHabit>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    key: { type: String, required: true },
    description: { type: String, default: '' },
    timeRange: {
      start: { type: String, required: true },
      end: { type: String, required: true },
    },
    days: [{ type: String }],
    frequency: { type: String, default: 'daily' },
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    dataPoints: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

habitSchema.index({ telegramId: 1, key: 1 }, { unique: true });

export const Habit = mongoose.model<IHabit>('Habit', habitSchema);
