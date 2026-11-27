import { Injectable } from '@nestjs/common';
import { Service } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { HOUR, MINUTE, istHour, istHourStart } from '../common/time';

export interface Slot {
  start: string;
  available: boolean;
  freePractitioners: number;
  sameBlock: boolean;
}

/**
 * UC-03 step 5: hourly blocks over the next 24 h inside service hours. The
 * current block is offered only in its first 20 minutes. A block is available
 * while at least one practitioner who works that hour has no booking in it.
 */
@Injectable()
export class SlotsService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async next24h(service: Service, practitionerId?: string, now = Date.now()): Promise<Slot[]> {
    const s = await this.settings.get();
    const first = istHourStart(now);
    const practitioners = await this.prisma.practitioner.findMany({
      where: { service, active: true, ...(practitionerId ? { id: practitionerId } : {}) },
      select: { id: true, workingHours: true },
    });
    const busy = await this.prisma.booking.findMany({
      where: { service, status: { in: ['upcoming', 'live'] }, slotStart: { gte: new Date(first), lt: new Date(first + 25 * HOUR) } },
      select: { practitionerId: true, slotStart: true },
    });
    const busyKey = new Set(busy.map((b) => `${b.practitionerId}@${b.slotStart.getTime()}`));

    const out: Slot[] = [];
    for (let i = 0; i < 24; i++) {
      const start = first + i * HOUR;
      const hour = istHour(start);
      if (hour < s.serviceHours.from || hour > s.serviceHours.to) continue;
      if (i === 0 && now - start > s.sameBlockGraceMin * MINUTE) continue;
      const free = practitioners.filter((p) => p.workingHours.includes(hour) && !busyKey.has(`${p.id}@${start}`)).length;
      out.push({ start: new Date(start).toISOString(), available: free > 0, freePractitioners: free, sameBlock: i === 0 });
    }
    return out;
  }

  /** Least-loaded free practitioner for the block, assigned at confirmation (UC-03 step 6). */
  async pickPractitioner(service: Service, slotStart: Date, preferredId?: string, excludeBookingId?: string) {
    const hour = istHour(slotStart.getTime());
    const candidates = await this.prisma.practitioner.findMany({
      where: { service, active: true, ...(preferredId ? { id: preferredId } : {}) },
      select: { id: true, workingHours: true, rating: true },
    });
    const working = candidates.filter((p) => p.workingHours.includes(hour));
    if (!working.length) return null;
    const dayStart = new Date(slotStart.getTime() - 12 * HOUR);
    const dayEnd = new Date(slotStart.getTime() + 12 * HOUR);
    const bookings = await this.prisma.booking.findMany({
      where: {
        practitionerId: { in: working.map((p) => p.id) },
        status: { in: ['upcoming', 'live'] },
        slotStart: { gte: dayStart, lt: dayEnd },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
      select: { practitionerId: true, slotStart: true },
    });
    const taken = new Set(bookings.filter((b) => b.slotStart.getTime() === slotStart.getTime()).map((b) => b.practitionerId));
    const load = (id: string) => bookings.filter((b) => b.practitionerId === id).length;
    const free = working.filter((p) => !taken.has(p.id)).sort((a, b) => load(a.id) - load(b.id) || b.rating - a.rating);
    return free[0]?.id ?? null;
  }

  isBookableStart(slotStart: Date, now: number, sameBlockGraceMin: number, serviceHours: { from: number; to: number }) {
    const t = slotStart.getTime();
    if (t !== istHourStart(t)) return 'Slots start on the hour.';
    const h = istHour(t);
    if (h < serviceHours.from || h > serviceHours.to) return 'Outside service hours.';
    if (t > now + 24 * HOUR) return 'Bookings open 24 hours ahead.';
    if (now - t > sameBlockGraceMin * MINUTE) return 'This slot has already started.';
    return null;
  }
}
