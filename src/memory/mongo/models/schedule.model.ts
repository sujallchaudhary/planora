import mongoose, { Schema, Document } from 'mongoose';
import { ScheduleEntryStatus } from '../../../config/defaults.js';

export interface IScheduleEntry {
  taskId: mongoose.Types.ObjectId;
  title: string;
  description: string;
  startTime: Date;
  endTime: Date;
  status: string;
  priority: number;
  isFixed: boolean;
  flexibility: number;
}

export interface ISchedule extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  date: string;  // yyyy-MM-dd
  entries: IScheduleEntry[];
  version: number;
  lastReplanAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleEntrySchema = new Schema<IScheduleEntry>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: { type: String, enum: Object.values(ScheduleEntryStatus), default: ScheduleEntryStatus.SCHEDULED },
    priority: { type: Number, default: 2 },
    isFixed: { type: Boolean, default: false },
    flexibility: { type: Number, default: 0.5, min: 0, max: 1 },
  },
  { _id: true }
);

const scheduleSchema = new Schema<ISchedule>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    date: { type: String, required: true },
    entries: [scheduleEntrySchema],
    version: { type: Number, default: 1 },
    lastReplanAt: { type: Date },
  },
  { timestamps: true }
);

scheduleSchema.index({ telegramId: 1, date: 1 }, { unique: true });

export const Schedule = mongoose.model<ISchedule>('Schedule', scheduleSchema);
