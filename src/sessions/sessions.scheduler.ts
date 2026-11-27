import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { SettingsService } from '../common/settings.service';
import { slabPrice } from '../common/rules';
import { MINUTE } from '../common/time';
import { NotificationsService } from '../notifications/notifications.service';
import { readyAt } from '../bookings/bookings.service';
import { RealtimeEvents } from './realtime.events';
import { RECONNECT_WINDOW_SEC, SessionsService } from './sessions.service';

/**
 * Runs every 5 s on exactly one instance (Redis lock). With ~100 live sessions
 * this is two small indexed queries per tick.
 */
@Injectable()
export class SessionsScheduler {
  private readonly log = new Logger('SessionsScheduler');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionsService,
    private readonly notifications: NotificationsService,
    private readonly rt: RealtimeEvents,
  ) {}

  @Interval(5000)
  async tick() {
    await this.redis.withLock('sessions-tick', 4500, async () => {
      try {
        await this.liveSessions();
        await this.upcomingSessions();
      } catch (e) {
        this.log.error(e);
      }
    });
  }

  private async liveSessions() {
    const s = await this.settings.get();
    const now = Date.now();
    const live = await this.prisma.booking.findMany({ where: { status: 'live' } });
    for (const b of live) {
      if (!b.startedAt) continue;
      const elapsed = (now - b.startedAt.getTime()) / 1000;

      // 20-minute maximum
      if (elapsed >= s.maxMinutes * 60) {
        await this.sessions.end(b.id, 'auto', b.startedAt.getTime() + s.maxMinutes * 60_000);
        continue;
      }

      // Slab warnings: one minute before each next rate (UC-05)
      for (let i = 0; i < s.slabs.length - 1; i++) {
        const boundary = s.slabs[i] * 60;
        if (elapsed >= boundary - s.slabWarningLeadSec && elapsed < boundary && (await this.redis.once(`warn:${b.id}:${boundary}`, 3600))) {
          const next = s.slabs[i + 1];
          this.rt.toBooking(b.id, 'session:warning', {
            bookingId: b.id, atSec: boundary, nextSlab: next, nextPrice: slabPrice(s, b.service, b.mode, next),
            message: `In 1 minute this session moves to the ${next}-minute rate (₹${slabPrice(s, b.service, b.mode, next)}).`,
          });
        }
      }

      // Reconnect window: close the session if a party stays away too long; charge only attended time.
      for (const who of ['customer', 'practitioner'] as const) {
        const since = await this.rt.absentSince(b.id, who);
        if (since && now - since > RECONNECT_WINDOW_SEC * 1000) {
          await this.sessions.end(b.id, 'dropped', Math.max(since, b.startedAt.getTime()));
          break;
        }
      }
    }
  }

  private async upcomingSessions() {
    const s = await this.settings.get();
    const now = Date.now();
    const due = await this.prisma.booking.findMany({
      where: { status: 'upcoming', slotStart: { lte: new Date(now) } },
      include: { profile: { select: { name: true } }, practitioner: { select: { name: true } } },
    });
    for (const b of due) {
      const ready = readyAt(b, s.prereadMin).getTime();

      // Pre-read started: tell the customer (once).
      if (b.service === 'astrology' && now < ready && (await this.redis.once(`preread:${b.id}`, 86400))) {
        await this.notifications.notify(b.userId, 'session', 'preread_started', {
          practitioner: b.practitioner?.name ?? '', name: b.profile.name, min: Math.ceil((ready - now) / MINUTE),
        }, { bookingId: b.id });
      }

      // Astrologer is ready: ping the customer once and try to start.
      if (now >= ready) {
        if (!b.practitionerReadyAt && (await this.redis.once(`ready:${b.id}`, 86400))) {
          await this.notifications.notify(b.userId, 'session', 'practitioner_ready', { grace: s.noShowGraceMin }, { bookingId: b.id });
        }
        await this.sessions.maybeStart(b.id);
      }

      // No-show after the grace period
      if (now >= ready + s.noShowGraceMin * MINUTE && !b.customerJoinedAt) {
        if (b.service === 'astrology') await this.sessions.markNoShow(b.id);
        else await this.cancelTarot(b.id);
      }
      // Both never met (e.g. astrologer absent) long after the slot: close without charge.
      if (now >= ready + 30 * MINUTE) {
        await this.prisma.booking.updateMany({ where: { id: b.id, status: 'upcoming' }, data: { status: 'cancelled', endedBy: 'system' } });
      }
    }
  }

  private async cancelTarot(id: string) {
    const upd = await this.prisma.booking.updateMany({ where: { id, status: 'upcoming' }, data: { status: 'cancelled', endedBy: 'customer_absent' } });
    if (upd.count) {
      const b = await this.prisma.booking.findUniqueOrThrow({ where: { id } });
      await this.sessions.onSessionClosed?.(b);
    }
  }
}
