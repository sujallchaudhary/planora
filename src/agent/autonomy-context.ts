import type { PlanningContext, PlanningContextSignal } from '../scheduler/planning-context.js';

export interface AutonomyContext {
  shouldReplan: boolean;
  confidence: number;
  summary: string;
  planningContext: PlanningContext;
  signals: PlanningContextSignal[];
}

export const EMPTY_AUTONOMY_CONTEXT: AutonomyContext = {
  shouldReplan: false,
  confidence: 0,
  summary: '',
  planningContext: {},
  signals: [],
};

interface PatternRule {
  regex: RegExp;
  signal: PlanningContextSignal;
  reason: string;
  energyLevel?: number;
  recoveryMinutes?: number;
  shouldReplan?: boolean;
  scheduleStability?: PlanningContext['scheduleStability'];
}

const RULES: PatternRule[] = [
  {
    regex: /\b(exhausted|burnt out|burned out|drained|no energy|dead tired|wiped out)\b/i,
    signal: { type: 'energy', value: 'depleted', confidence: 0.9 },
    reason: 'User reports depleted energy',
    energyLevel: 1,
    recoveryMinutes: 45,
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(tired|sleepy|fatigued|low energy|not feeling energetic)\b/i,
    signal: { type: 'energy', value: 'low', confidence: 0.78 },
    reason: 'User reports low energy',
    energyLevel: 2,
    recoveryMinutes: 25,
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(overwhelmed|stressed|anxious|panic|too much)\b/i,
    signal: { type: 'mood', value: 'overloaded', confidence: 0.78 },
    reason: 'User reports overload or stress',
    energyLevel: 2,
    recoveryMinutes: 20,
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(overslept|woke up late|slept through|running late|delayed|behind schedule)\b/i,
    signal: { type: 'delay', value: 'time_lost', confidence: 0.86 },
    reason: 'User lost planned time',
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(outside|out right now|not at home|travelling|traveling|commuting|on the way|in transit)\b/i,
    signal: { type: 'location', value: 'away_from_primary_workspace', confidence: 0.74 },
    reason: 'User is away from their normal work context',
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(skipped gym|missed gym|skipped workout|missed workout|skipped class|missed class)\b/i,
    signal: { type: 'missed_habit', value: 'routine_disrupted', confidence: 0.82 },
    reason: 'User missed a routine anchor',
    shouldReplan: true,
    scheduleStability: 'preserve',
  },
  {
    regex: /\b(energized|fresh|locked in|focused|in flow|high energy)\b/i,
    signal: { type: 'energy', value: 'high', confidence: 0.76 },
    reason: 'User reports high energy',
    energyLevel: 5,
    shouldReplan: false,
    scheduleStability: 'moderate',
  },
];

export function detectAutonomyContext(input: string, explicitReplan: boolean): AutonomyContext {
  const signals: PlanningContextSignal[] = [];
  const reasons: string[] = [];
  let shouldReplan = explicitReplan;
  let confidence = explicitReplan ? 0.7 : 0;
  let energyLevel: number | undefined;
  let recoveryMinutes = 0;
  let scheduleStability: PlanningContext['scheduleStability'] = explicitReplan ? 'moderate' : undefined;

  for (const rule of RULES) {
    if (!rule.regex.test(input)) continue;

    signals.push(rule.signal);
    reasons.push(rule.reason);
    shouldReplan = shouldReplan || rule.shouldReplan === true;
    confidence = Math.max(confidence, rule.signal.confidence);

    if (typeof rule.energyLevel === 'number') {
      energyLevel = energyLevel === undefined
        ? rule.energyLevel
        : Math.min(energyLevel, rule.energyLevel);
    }
    if (rule.recoveryMinutes) {
      recoveryMinutes = Math.max(recoveryMinutes, rule.recoveryMinutes);
    }
    if (rule.scheduleStability) {
      scheduleStability = rule.scheduleStability;
    }
  }

  const summary = reasons.length > 0
    ? reasons.join('; ')
    : explicitReplan
      ? 'User requested schedule replanning'
      : '';

  const planningContext: PlanningContext = {
    trigger: explicitReplan ? 'explicit_replan' : signals.length > 0 ? 'context_event' : undefined,
    reason: summary || undefined,
    energyLevel,
    recoveryMinutes: recoveryMinutes > 0 ? recoveryMinutes : undefined,
    scheduleStability,
    signals,
  };

  return {
    shouldReplan,
    confidence,
    summary,
    planningContext,
    signals,
  };
}
