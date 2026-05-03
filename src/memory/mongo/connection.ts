import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('mongodb');

export async function connectMongoDB(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI);
    log.info('Connected to MongoDB');
  } catch (error) {
    log.error({ error }, 'Failed to connect to MongoDB');
    throw error;
  }

  mongoose.connection.on('error', (err) => {
    log.error({ err }, 'MongoDB connection error');
  });

  mongoose.connection.on('disconnected', () => {
    log.warn('MongoDB disconnected');
  });
}

export async function disconnectMongoDB(): Promise<void> {
  await mongoose.disconnect();
  log.info('Disconnected from MongoDB');
}
