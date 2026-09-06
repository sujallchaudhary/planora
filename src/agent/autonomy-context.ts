import type { PlanningContext, PlanningContextSignal } from '../scheduler/planning-context.js';
import type { UserState } from '../utils/zod-schemas.js';

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
}

/**
 * Regex backstop for the LLM's userState. Patterns are first-person on purpose:
 * "add: go outside for a walk" must not count as "the user is outside".
 */
const RULES: PatternRule[] = [
  {
    regex: /\b(i'?m|i am|feeling|feel|so|totally|completely|absolutely)\s+(exhausted|burnt out|burned out|drained|dead tired|wiped out|wrecked)\b|\b(no energy|zero energy)\b/i,
    signal: { type: 'energy', value: 'depleted', confidence: 0.9 },
    reason: 'user reports depleted energy',
    energyLevel: 1,
    recoveryMinutes: 45,
    shouldReplan: true,
  },
  {
    regex: /\b(i'?m|i am|feeling|feel|so|really|a bit|bit|little|kinda|kind of)\s+(tired|sleepy|fatigued|low on energy|low energy|sluggish)\b/i,
    signal: { type: 'energy', value: 'low', confidence: 0.78 },
    reason: 'user reports low energy',
    energyLevel: 2,
    recoveryMinutes: 25,
    shouldReplan: true,
  },
  {
    regex: /\b(i'?m|i am|feeling|feel|so|really)\s+(overwhelmed|stressed|anxious|swamped|burnt)\b|\btoo much (on my plate|going on|to do)\b/i,
    signal: { type: 'mood', value: 'overloaded', confidence: 0.78 },
    reason: 'user reports overload or stress',
    energyLevel: 2,
    recoveryMinutes: 20,
    shouldReplan: true,
  },
  {
    regex: /\b(overslept|woke up late|slept in|slept through|running late|i'?m late|behind schedule|got delayed|everything'?s delayed)\b/i,
    signal: { type: 'delay', value: 'time_lost', confidence: 0.86 },
    reason: 'user lost planned time',
    shouldReplan: true,
  },
  {
    regex: /\b(i'?m|i am)\s+(outside|out right now|out of the house|not at home|not home|travelling|traveling|commuting|on the way|in transit|at the hospital|at the doctor|stuck in traffic)\b/i,
    signal: { type: 'location', value: 'away_from_primary_workspace', confidence: 0.74 },
    reason: 'user is away from their normal work context',
    shouldReplan: true,
  },
  {
    regex: /\b(skipped|missed|skipping|bailed on)\s+(the\s+|my\s+)?(gym|workout|class|lecture|run|nap)\b/i,
    signal: { type: 'missed_habit', value: 'routine_disrupted', confidence: 0.82 },
    reason: 'user missed a routine anchor',
    shouldReplan: true,
  },
  {
    regex: /\b(i'?m|i am|feeling|feel)\s+(energized|energised|fresh|locked in|focused|in flow|full of energy|on fire|sharp)\b/i,
    signal: { type: 'energy', value: 'high', confidence: 0.76 },
    reason: 'user reports high energy',
    energyLevel: 5,
    shouldReplan: false,
  },
];

const ENERGY_LEVEL: Record<string, number> = { depleted: 1, low: 2, normal: 3, high: 5 };
const RECOVERY: Record<string, number> = { depleted: 45, low: 25 };

/**
 * Merge the LLM's structured read of the user's state with regex signals into a
 * PlanningContext. The LLM is primary; regexes only add what it missed.
 */
export function detectAutonomyContext(
  input: string,
  explicitReplan: boolean,
  llmState?: UserState | null,
  resolveUnavailableUntil?: (value: string) => Date | undefined,
): AutonomyContext {
  const signals: PlanningContextSignal[] = [];
  const reasons: string[] = [];
  let shouldReplan = explicitReplan;
  let confidence = explicitReplan ? 0.7 : 0;
  let energyLevel: number | undefined;
  let recoveryMinutes = 0;
  let unavailableUntil: Date | undefined;

  if (llmState?.energy && llmState.energy !== 'normal') {
    energyLevel = ENERGY_LEVEL[llmState.energy];
    recoveryMinutes = RECOVERY[llmState.energy] ?? 0;
    signals.push({ type: 'energy', value: llmState.energy, confidence: 0.85 });
    reasons.push(`energy ${llmState.energy}`);
    if (llmState.energy !== 'high') shouldReplan = true;
    confidence = Math.max(confidence, 0.85);
  }
  if (llmState?.mood && /stress|overwhelm|anxious|panic|burn/i.test(llmState.mood)) {
    signals.push({ type: 'mood', value: 'overloaded', confidence: 0.8 });
    reasons.push(`mood: ${llmState.mood}`);
    energyLevel = Math.min(energyLevel ?? 2, 2);
    recoveryMinutes = Math.max(recoveryMinutes, 20);
    shouldReplan = true;
    confidence = Math.max(confidence, 0.8);
  }
  if (llmState?.unavailableUntil && resolveUnavailableUntil) {
    const until = resolveUnavailableUntil(llmState.unavailableUntil);
    if (until && until > new Date()) {
      unavailableUntil = until;
      signals.push({ type: 'availability', value: `unavailable until ${llmState.unavailableUntil}`, confidence: 0.85 });
      reasons.push(`away until ${llmState.unavailableUntil}`);
      shouldReplan = true;
      confidence = Math.max(confidence, 0.85);
    }
  } else if (llmState?.availability && /away|outside|travel|commut|out of|not at|hospital|doctor/i.test(llmState.availability)) {
    signals.push({ type: 'location', value: llmState.availability, confidence: 0.75 });
    reasons.push(llmState.availability);
    shouldReplan = true;
    confidence = Math.max(confidence, 0.75);
  }
  if (llmState?.note && /late|overslept|delay/i.test(llmState.note)) {
    signals.push({ type: 'delay', value: 'time_lost', confidence: 0.8 });
    reasons.push(llmState.note);
    shouldReplan = true;
  }

  for (const rule of RULES) {
    if (!rule.regex.test(input)) continue;
    if (signals.some(s => s.type === rule.signal.type)) continue; // LLM already covered it
    signals.push(rule.signal);
    reasons.push(rule.reason);
    shouldReplan = shouldReplan || rule.shouldReplan === true;
    confidence = Math.max(confidence, rule.signal.confidence);
    if (typeof rule.energyLevel === 'number') {
      energyLevel = energyLevel === undefined ? rule.energyLevel : Math.min(energyLevel, rule.energyLevel);
    }
    if (rule.recoveryMinutes) recoveryMinutes = Math.max(recoveryMinutes, rule.recoveryMinutes);
  }

  const summary = reasons.length > 0 ? reasons.join('; ') : explicitReplan ? 'user requested a replan' : '';

  const planningContext: PlanningContext = {
    trigger: explicitReplan ? 'explicit_replan' : signals.length > 0 ? 'context_event' : undefined,
    reason: summary || undefined,
    energyLevel,
    recoveryMinutes: recoveryMinutes > 0 ? recoveryMinutes : undefined,
    unavailableUntil,
    scheduleStability: explicitReplan && signals.length === 0 ? 'moderate' : signals.length > 0 ? 'preserve' : undefined,
    signals,
  };

  return { shouldReplan, confidence, summary, planningContext, signals };
}
