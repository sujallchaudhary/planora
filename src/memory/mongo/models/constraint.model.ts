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
  /** yyyy-MM-dd — the constraint stops applying after this day (e.g. exam period). */
  expiresOn?: string;
  confidence: number;
  dataPoints: number;
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
    expiresOn: { type: String },
    confidence: { type: Number, default: 0.8, min: 0, max: 1 },
    dataPoints: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

constraintSchema.index({ telegramId: 1, key: 1 }, { unique: true });

export const Constraint = mongoose.model<IConstraint>('Constraint', constraintSchema);
