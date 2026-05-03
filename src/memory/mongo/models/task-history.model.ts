import mongoose, { Schema, Document } from 'mongoose';
import { TaskOutcome } from '../../../config/defaults.js';

export interface ITaskHistory extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  taskId: mongoose.Types.ObjectId;
  title: string;
  scheduledDate: string;
  scheduledStartTime: Date;
  scheduledEndTime: Date;
  outcome: string;
  completedAt?: Date;
  delayMinutes?: number;
  notes?: string;
  createdAt: Date;
}

const taskHistorySchema = new Schema<ITaskHistory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    title: { type: String, required: true },
    scheduledDate: { type: String, required: true },
    scheduledStartTime: { type: Date, required: true },
    scheduledEndTime: { type: Date, required: true },
    outcome: { type: String, enum: Object.values(TaskOutcome), required: true },
    completedAt: { type: Date },
    delayMinutes: { type: Number },
    notes: { type: String },
  },
  { timestamps: true }
);

taskHistorySchema.index({ telegramId: 1, scheduledDate: 1 });
taskHistorySchema.index({ telegramId: 1, outcome: 1 });

export const TaskHistory = mongoose.model<ITaskHistory>('TaskHistory', taskHistorySchema);
