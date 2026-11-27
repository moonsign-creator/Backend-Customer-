import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Booking, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { canReschedule, maxPrice } from '../common/rules';
import { istDayRange } from '../common/time';
import { fmtWhen } from '../common/i18n';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilesService } from '../profiles/profiles.module';
import { WalletService } from '../wallet/wallet.service';
import { CreateBookingDto } from './bookings.dto';
import { SlotsService } from './slots.service';

const PUBLIC_PRACTITIONER = { select: { id: true, code: true, name: true, gender: true, languages: true, experienceYears: true, rating: true } } as const;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly slots: SlotsService,
    private readonly wallet: WalletService,
    private readonly profiles: ProfilesService,
    private readonly notifications: NotificationsService,
  ) {}

  /** UC-03: book an astrology consultation in an hourly slot. */
  async create(userId: string, dto: CreateBookingDto, now = Date.now()) {
    const s = await this.settings.get();
    const profile = await this.profiles.own(userId, dto.profileId);
    const slotStart = new Date(dto.slotStart);
    const bad = this.slots.isBookableStart(slotStart, now, s.sameBlockGraceMin, s.serviceHours);
    if (bad) throw new BadRequestException(bad);

    // One consultation per profile per day (IST).
    if (await this.hasConsultationOnDay(profile.id, slotStart)) {
      throw new ConflictException('This profile already has a consultation on that day. Please pick another day.');
    }

    // Wallet must cover the maximum 20-minute price, on top of other open bookings.
    const need = maxPrice(s, 'astrology', dto.mode);
    const { available } = await this.wallet.available(userId);
    if (available < need) {
      throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: `Please add money. You need ₹${need} available for this consultation.`, required: need, available, shortBy: need - available });
    }

    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 3 && !booking; attempt++) {
      const practitionerId = await this.slots.pickPractitioner('astrology', slotStart, dto.practitionerId);
      if (!practitionerId) throw new ConflictException('This slot is full. Please choose another time.');
      try {
        booking = await this.prisma.booking.create({
          data: {
            userId, profileId: profile.id, practitionerId, service: 'astrology', mode: dto.mode, slotStart,
            category: dto.category, questions: dto.questions ?? [], note: dto.note,
          },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // someone took this practitioner's slot a moment ago; retry
      }
    }
    if (!booking) throw new ConflictException('This slot was just taken. Please choose another time.');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { lang: true } });
    await this.notifications.notify(userId, 'booking', 'booking_confirmed', {
      mode: dto.mode === 'chat' ? (user.lang === 'hi' ? 'चैट' : 'Chat') : user.lang === 'hi' ? 'वॉइस' : 'Voice',
      name: profile.name,
      when: fmtWhen(slotStart, user.lang),
    }, { bookingId: booking.id });
    return this.get(userId, booking.id);
  }

  async hasConsultationOnDay(profileId: string, day: Date, excludeId?: string) {
    const [from, to] = istDayRange(day.getTime());
    const n = await this.prisma.booking.count({
      where: {
        profileId, service: 'astrology', status: { in: ['upcoming', 'live', 'completed'] },
        slotStart: { gte: new Date(from), lt: new Date(to) },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return n > 0;
  }

  list(userId: string, filter: 'upcoming' | 'past' | 'all' = 'all', profileId?: string) {
    const status: Prisma.BookingWhereInput =
      filter === 'upcoming' ? { status: { in: ['upcoming', 'live'] } } : filter === 'past' ? { status: { notIn: ['upcoming', 'live'] } } : {};
    return this.prisma.booking.findMany({
      where: { userId, ...status, ...(profileId ? { profileId } : {}) },
      include: { profile: { select: { id: true, name: true, relation: true } }, practitioner: PUBLIC_PRACTITIONER },
      orderBy: { slotStart: filter === 'upcoming' ? 'asc' : 'desc' },
      take: 100,
    });
  }

  async get(userId: string, id: string) {
    const b = await this.prisma.booking.findFirst({
      where: { id, userId },
      include: { profile: true, practitioner: PUBLIC_PRACTITIONER },
    });
    if (!b) throw new NotFoundException('Booking not found');
    const s = await this.settings.get();
    return { ...b, reschedule: canReschedule(s, b), readyAt: readyAt(b, s.prereadMin) };
  }

  async rescheduleCheck(userId: string, id: string) {
    const b = await this.get(userId, id);
    return b.reschedule;
  }

  /** UC-07: move to a new slot; the old one is released. */
  async reschedule(userId: string, id: string, newStart: string, now = Date.now()) {
    const s = await this.settings.get();
    const b = await this.prisma.booking.findFirst({ where: { id, userId } });
    if (!b) throw new NotFoundException('Booking not found');
    const rule = canReschedule(s, b, now);
    if (!rule.ok) throw new BadRequestException(rule.reason);
    const slotStart = new Date(newStart);
    const bad = this.slots.isBookableStart(slotStart, now, s.sameBlockGraceMin, s.serviceHours);
    if (bad) throw new BadRequestException(bad);
    if (await this.hasConsultationOnDay(b.profileId, slotStart, b.id)) {
      throw new ConflictException('This profile already has a consultation on that day.');
    }
    // Keep the same astrologer if they are free, otherwise reassign.
    const practitionerId =
      (await this.slots.pickPractitioner('astrology', slotStart, b.practitionerId ?? undefined, b.id)) ??
      (await this.slots.pickPractitioner('astrology', slotStart, undefined, b.id));
    if (!practitionerId) throw new ConflictException('This slot is full. Please choose another time.');
    try {
      await this.prisma.booking.update({
        where: { id },
        data: { slotStart, practitionerId, rescheduleCount: { increment: 1 }, lastRescheduledAt: new Date(now) },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('This slot was just taken. Please choose another time.');
      throw e;
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { lang: true } });
    await this.notifications.notify(userId, 'booking', 'booking_rescheduled', { when: fmtWhen(slotStart, user.lang) }, { bookingId: id });
    return this.get(userId, id);
  }

  async rate(userId: string, id: string, rating: number, feedback?: string) {
    const b = await this.prisma.booking.findFirst({ where: { id, userId } });
    if (!b) throw new NotFoundException('Booking not found');
    if (b.status !== 'completed' && b.status !== 'interrupted') throw new BadRequestException('Only finished sessions can be rated.');
    return this.prisma.booking.update({ where: { id }, data: { rating, feedback }, select: { id: true, rating: true, feedback: true } });
  }

  /** Per-profile history with transcripts and remedies (UC-10). */
  history(userId: string, profileId?: string) {
    return this.prisma.booking.findMany({
      where: { userId, status: { in: ['completed', 'no_show', 'interrupted'] }, ...(profileId ? { profileId } : {}) },
      include: { profile: { select: { id: true, name: true, relation: true } }, practitioner: PUBLIC_PRACTITIONER },
      orderBy: { slotStart: 'desc' },
      take: 100,
    });
  }

  async historyItem(userId: string, id: string) {
    const b = await this.prisma.booking.findFirst({
      where: { id, userId },
      include: {
        profile: true,
        practitioner: PUBLIC_PRACTITIONER,
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, sender: true, text: true, createdAt: true } },
      },
    });
    if (!b) throw new NotFoundException('Session not found');
    return b;
  }
}

/** When the astrologer finishes pre-reading and the customer should join. */
export function readyAt(b: { service: string; slotStart: Date; practitionerReadyAt: Date | null }, prereadMin: number) {
  if (b.practitionerReadyAt) return b.practitionerReadyAt;
  if (b.service === 'tarot') return b.slotStart;
  return new Date(b.slotStart.getTime() + prereadMin * 60_000);
}

export function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
