// Pure business rules shared by REST, sockets and the scheduler.
// Mirrors src/lib/data.ts in the customer app so both sides agree.
import { Mode, Service } from '@prisma/client';

export type Slab = 10 | 15 | 20;
export type Pricing = Record<Service, Record<Mode, Record<Slab, number>>>;

export interface BusinessSettings {
  pricing: Pricing;
  slabs: Slab[];
  maxMinutes: number;
  minTopup: number;
  noShowCharge: number;
  noShowGraceMin: number;
  prereadMin: number;
  freeRescheduleCutoffMin: number;
  secondRescheduleCutoffHours: number;
  sameBlockGraceMin: number;
  serviceHours: { from: number; to: number }; // IST, inclusive start hours
  slabWarningLeadSec: number;
  tarotAvgSessionMin: number;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  pricing: {
    astrology: { chat: { 10: 299, 15: 399, 20: 499 }, voice: { 10: 399, 15: 549, 20: 699 } },
    tarot: { chat: { 10: 199, 15: 279, 20: 349 }, voice: { 10: 249, 15: 349, 20: 449 } },
  },
  slabs: [10, 15, 20],
  maxMinutes: 20,
  minTopup: 200,
  noShowCharge: 149,
  noShowGraceMin: 4,
  prereadMin: 10,
  freeRescheduleCutoffMin: 30,
  secondRescheduleCutoffHours: 12,
  sameBlockGraceMin: 20,
  serviceHours: { from: 7, to: 22 },
  slabWarningLeadSec: 60,
  tarotAvgSessionMin: 12,
};

export function slabPrice(s: BusinessSettings, service: Service, mode: Mode, slab: Slab) {
  return s.pricing[service][mode][slab];
}

/** Highest price a session can reach. The wallet must cover this before booking. */
export function maxPrice(s: BusinessSettings, service: Service, mode: Mode) {
  return slabPrice(s, service, mode, s.slabs[s.slabs.length - 1]);
}

/** Slab the conversation is in after `sec` seconds. */
export function slabFor(s: BusinessSettings, sec: number): Slab {
  const m = sec / 60;
  for (const slab of s.slabs) if (m <= slab) return slab;
  return s.slabs[s.slabs.length - 1];
}

/** Only time actually attended is charged: the price of the slab reached. */
export function chargeFor(s: BusinessSettings, service: Service, mode: Mode, sec: number) {
  if (sec <= 0) return 0;
  return slabPrice(s, service, mode, slabFor(s, sec));
}

export interface RescheduleInput {
  status: string;
  service: Service;
  slotStart: Date;
  rescheduleCount: number;
}

/** UC-07: first reschedule free if >= 30 min before; another only if >= 12 h before. */
export function canReschedule(s: BusinessSettings, b: RescheduleInput, now = Date.now()) {
  if (b.status !== 'upcoming' || b.service !== 'astrology') {
    return { ok: false, reason: 'Only upcoming consultations can be rescheduled.' };
  }
  const minsLeft = (b.slotStart.getTime() - now) / 60000;
  if (b.rescheduleCount === 0) {
    if (minsLeft >= s.freeRescheduleCutoffMin) return { ok: true, reason: 'First reschedule is free.' };
    return { ok: false, reason: `Rescheduling closes ${s.freeRescheduleCutoffMin} minutes before the session.` };
  }
  if (minsLeft >= s.secondRescheduleCutoffHours * 60) {
    return { ok: true, reason: `Allowed because the session is more than ${s.secondRescheduleCutoffHours} hours away.` };
  }
  return {
    ok: false,
    reason: `This booking was already rescheduled once. Another reschedule is only possible more than ${s.secondRescheduleCutoffHours} hours before the session.`,
  };
}

export function ageFrom(dob: string, now = new Date()) {
  const d = new Date(dob);
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/** UC-03 step 4: question categories offered depend on the profile's age. */
export function categoriesForAge(age: number): { list: string[]; def: string } {
  if (age < 21) return { list: ['Relationship', 'Career', 'Health', 'Others'], def: 'Relationship' };
  if (age < 30) return { list: ['Career', 'Marriage / Relationship', 'Health', 'Others'], def: 'Career' };
  if (age < 40) return { list: ['Finance', 'Health', 'Marriage / Relationship', 'Children', 'Others'], def: 'Finance' };
  return { list: ['Finance', 'Health', 'Relationship', 'Others'], def: 'Finance' };
}

// UC-23 step 4: phone numbers and payment details are blocked in chat.
const PHONE_RE = /(\+?\d[\d\s-]{8,}\d)/;
const PAY_RE =
  /\b(upi|gpay|google pay|phonepe|paytm|bank account|ifsc|account no|card number|cvv)\b|[\w.-]+@(ok\w+|ybl|paytm|upi|axl|ibl)\b/i;
export function blockedReason(text: string): string | null {
  if (PHONE_RE.test(text)) return 'Phone numbers cannot be shared in chat.';
  if (PAY_RE.test(text)) return 'Payment details cannot be shared in chat.';
  return null;
}

export function reduceNum(n: number): number {
  while (n > 9) n = String(n).split('').reduce((sum, c) => sum + Number(c), 0);
  return n;
}

/** UC-10 step 2: numerology personal year / month / day. */
export function personalDay(dob: string, today = new Date()) {
  const d = new Date(dob);
  const py = reduceNum(reduceNum(d.getMonth() + 1) + reduceNum(d.getDate()) + reduceNum(today.getFullYear()));
  const pm = reduceNum(py + today.getMonth() + 1);
  const pd = reduceNum(pm + today.getDate());
  return { py, pm, pd };
}
