import mongoose, { Schema, Document } from 'mongoose';

export interface IConstraint extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: number;
  key: string;
  description: string;
  timeRange: {
    start: string;
    end: string;
  };
  days: string[];  // ['monday', 'wednesday'] or ['daily']
  isRecurring: boolean;
  specificDate?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const constraintSchema = new Schema<IConstraint>(
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
    isRecurring: { type: Boolean, default: true },
    specificDate: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

constraintSchema.index({ telegramId: 1, key: 1 }, { unique: true });

export const Constraint = mongoose.model<IConstraint>('Constraint', constraintSchema);
