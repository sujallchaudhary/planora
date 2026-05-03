import mongoose, { Schema, Document } from 'mongoose';
import type { UserSettings } from '../../../config/config-resolver.js';

export interface IUser extends Document {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  settings: UserSettings;
  isActive: boolean;
  lastInteraction: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    firstName: { type: String, required: true },
    lastName: { type: String },
    username: { type: String },
    settings: {
      timezone: { type: String },
      workingHours: {
        start: { type: String },
        end: { type: String },
      },
      bufferMinutes: { type: Number },
      reminderLeadMinutes: { type: Number },
      slackPercentage: { type: Number },
      maxReplanFrequencyMinutes: { type: Number },
      dailyPlanTime: { type: String },
      analyticsTime: { type: String },
      snoozeMinutes: { type: Number },
      memoryConfidenceThreshold: { type: Number },
      memoryMinDataPoints: { type: Number },
    },
    isActive: { type: Boolean, default: true },
    lastInteraction: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
