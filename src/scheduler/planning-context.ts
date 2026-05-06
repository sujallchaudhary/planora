export type ScheduleStability = 'preserve' | 'moderate' | 'free';

export interface PlanningContextSignal {
  type: 'energy' | 'delay' | 'location' | 'mood' | 'missed_habit' | 'availability';
  value: string;
  confidence: number;
}

export interface PlanningContext {
  trigger?: string;
  reason?: string;
  energyLevel?: number; // 1 = depleted, 5 = high energy
  recoveryMinutes?: number;
  avoidHighCognitiveUntil?: string;
  scheduleStability?: ScheduleStability;
  signals?: PlanningContextSignal[];
}

export function hasLowEnergy(context?: PlanningContext): boolean {
  return typeof context?.energyLevel === 'number' && context.energyLevel <= 2;
}
