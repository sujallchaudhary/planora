import mongoose, { Schema, Document } from 'mongoose';
import { TaskStatus, Priority, CognitiveLoad } from '../../../config/defaults.js';

export interface ITaskRecurrence {
  pattern: 'daily' | 'weekdays' | 'weekly';
  days?: string[];
}

export interface ITask extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  title: string;
  description: string;
  priority: number;
  cognitiveLoad: number;
  estimatedMinutes: number;
  dueDate?: Date;
  preferredTime?: string;
  tags: string[];
  status: string;
  isFixed: boolean;
  fixedStartTime?: string;
  fixedEndTime?: string;
  recurrence?: ITaskRecurrence;
  /** yyyy-MM-dd — the task is not eligible for scheduling before this date (skip / roll-over). */
  deferredUntil?: string;
  /** Count of times the task was skipped or missed — used for procrastination detection. */
  deferCount: number;
  completedAt?: Date;
  actualMinutes?: number;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<ITask>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    priority: { type: Number, default: Priority.MEDIUM, min: 1, max: 5 },
    cognitiveLoad: { type: Number, default: CognitiveLoad.MEDIUM, min: 1, max: 3 },
    estimatedMinutes: { type: Number, default: 30, min: 5 },
    dueDate: { type: Date },
    preferredTime: { type: String },
    tags: [{ type: String }],
    status: { type: String, enum: Object.values(TaskStatus), default: TaskStatus.PENDING },
    isFixed: { type: Boolean, default: false },
    fixedStartTime: { type: String },
    fixedEndTime: { type: String },
    recurrence: {
      pattern: { type: String },
      days: [{ type: String }],
    },
    deferredUntil: { type: String },
    deferCount: { type: Number, default: 0 },
    completedAt: { type: Date },
    actualMinutes: { type: Number },
  },
  { timestamps: true }
);

taskSchema.index({ telegramId: 1, status: 1 });
taskSchema.index({ telegramId: 1, dueDate: 1 });

export const Task = mongoose.model<ITask>('Task', taskSchema);
