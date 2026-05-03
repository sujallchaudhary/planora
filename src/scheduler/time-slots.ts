import { addMinutes } from 'date-fns';

export interface TimeSlot {
  start: Date;
  end: Date;
}

/**
 * Check if two time slots overlap.
 */
export function slotsOverlap(a: TimeSlot, b: TimeSlot): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Find available gaps between occupied slots within working hours.
 */
export function findAvailableSlots(
  occupiedSlots: TimeSlot[],
  workingStart: Date,
  workingEnd: Date,
  minDurationMinutes: number = 15,
): TimeSlot[] {
  // Sort occupied slots by start time
  const sorted = [...occupiedSlots].sort((a, b) => a.start.getTime() - b.start.getTime());
  const available: TimeSlot[] = [];

  let cursor = workingStart;

  for (const slot of sorted) {
    if (cursor < slot.start) {
      const gap: TimeSlot = { start: new Date(cursor), end: new Date(slot.start) };
      const durationMs = gap.end.getTime() - gap.start.getTime();
      if (durationMs >= minDurationMinutes * 60 * 1000) {
        available.push(gap);
      }
    }
    if (slot.end > cursor) {
      cursor = slot.end;
    }
  }

  // Check gap after last occupied slot
  if (cursor < workingEnd) {
    const gap: TimeSlot = { start: new Date(cursor), end: new Date(workingEnd) };
    const durationMs = gap.end.getTime() - gap.start.getTime();
    if (durationMs >= minDurationMinutes * 60 * 1000) {
      available.push(gap);
    }
  }

  return available;
}

/**
 * Add buffer time between slots.
 */
export function addBufferToSlots(slots: TimeSlot[], bufferMinutes: number): TimeSlot[] {
  return slots.map(slot => ({
    start: slot.start,
    end: addMinutes(slot.end, bufferMinutes),
  }));
}

/**
 * Check if a task of given duration fits in a slot.
 */
export function fitsInSlot(slot: TimeSlot, durationMinutes: number): boolean {
  const slotDuration = (slot.end.getTime() - slot.start.getTime()) / (60 * 1000);
  return slotDuration >= durationMinutes;
}

/**
 * Calculate total available minutes in slots.
 */
export function totalAvailableMinutes(slots: TimeSlot[]): number {
  return slots.reduce((sum, slot) => {
    return sum + (slot.end.getTime() - slot.start.getTime()) / (60 * 1000);
  }, 0);
}
