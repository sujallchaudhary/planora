import { IntentType } from '../config/defaults.js';
import type { ClassificationResult } from '../utils/zod-schemas.js';

/**
 * Deterministic classification for trivial, unambiguous commands. Saves one LLM round-trip
 * on the most frequent messages ("done", "show plan") without any accuracy risk: only exact
 * phrasings match, and anything carrying injected context goes to the model.
 */
export function fastClassify(rawInput: string, dates: { today: string; tomorrow: string }): ClassificationResult | null {
  if (/^\s*\[(Context|Replying)/i.test(rawInput)) return null;
  const text = rawInput.trim().toLowerCase().replace(/[\s.!?,🙂👍✅]+$/u, '').replace(/\s+/g, ' ');
  if (!text || text.length > 40) return null;

  const make = (intent: IntentType, extra: Partial<ClassificationResult> = {}, reasoning = 'fast:command'): ClassificationResult => ({
    intent,
    confidence: 1,
    tasks: [],
    memorySignals: [],
    userState: null,
    secondaryIntents: [],
    taskReference: null,
    memoryReference: null,
    replanContext: null,
    targetDate: null,
    reasoning,
    ...extra,
  });

  if (/^(done|finished|completed|all done|did it|done with it|finished it|i'?m done|that'?s done)$/.test(text)) {
    return make(IntentType.COMPLETE_TASK);
  }
  if (/^(skip|skip it|skip this|skip that|skip this one|not today)$/.test(text)) {
    return make(IntentType.SKIP_TASK);
  }
  if (/^((show|what'?s|whats|what is) (me )?(my |the )?(plan|schedule|day|agenda)( (for )?today)?|today'?s (plan|schedule)|(my )?(plan|schedule|agenda)( today)?)$/.test(text)) {
    return make(IntentType.SHOW_PLAN, { targetDate: dates.today });
  }
  if (/^((show|what'?s|whats|what is) (me )?(my |the )?(plan|schedule|day|agenda) (for )?tomorrow|tomorrow'?s (plan|schedule))$/.test(text)) {
    return make(IntentType.SHOW_PLAN, { targetDate: dates.tomorrow });
  }
  if (/^(replan|re-plan|reshuffle|(re)?plan (my )?(day|today)|(re)?plan today|reshuffle (my )?day)$/.test(text)) {
    return make(IntentType.REPLAN, { targetDate: dates.today, replanContext: 'user asked to replan' });
  }
  if (/^((re)?plan (my )?(day )?(for )?tomorrow|plan tomorrow)$/.test(text)) {
    return make(IntentType.REPLAN, { targetDate: dates.tomorrow, replanContext: 'plan tomorrow' });
  }
  if (/^(thanks|thank you|thx|ty|cheers|cool|great|nice|perfect|got it|ok|okay|k|👍)$/.test(text)) {
    return make(IntentType.GENERAL_CHAT, {}, 'fast:ack');
  }
  return null;
}

/** Canned replies for fast-path acknowledgements — no model call needed. */
export function ackReply(): string {
  const options = ['Anytime.', '👍', 'On it — I\'ll keep the day on track.', 'Good. Ping me when things change.'];
  return options[Math.floor(Math.random() * options.length)]!;
}
