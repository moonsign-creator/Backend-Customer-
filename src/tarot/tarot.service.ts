import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Booking, Gender, Mode } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { SettingsService } from '../common/settings.service';
import { maxPrice } from '../common/rules';
import { istDay, istHour } from '../common/time';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilesService } from '../profiles/profiles.module';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeEvents } from '../sessions/realtime.events';
import { SessionsService } from '../sessions/sessions.service';

const Q = 'tarot:queue'; // ZSET userId -> joinedAt
const REQ = (u: string) => `tarot:req:${u}`; // HASH request details
const ONLINE = 'tarot:online'; // SET practitionerIds connected
const AVAILABLE = 'tarot:available'; // SET practitionerIds connected and free

export type GenderPref = Gender | 'any';

/** UC-06/UC-21: live tarot, first come first served, with gender preference. */
@Injectable()
export class TarotService implements OnModuleInit {
  private readonly log = new Logger('Tarot');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly profiles: ProfilesService,
    private readonly notifications: NotificationsService,
    private readonly rt: RealtimeEvents,
    private readonly sessions: SessionsService,
  ) {}

  onModuleInit() {
    // A reader goes back to the pool when their reading ends.
    this.sessions.onSessionClosed = async (b: Booking) => {
      if (b.service !== 'tarot' || !b.practitionerId) return;
      if (await this.redis.client.sismember(ONLINE, b.practitionerId)) {
        await this.redis.client.sadd(AVAILABLE, b.practitionerId);
        await this.match();
      }
    };
  }

  async summary() {
    const [online, available, queue] = await Promise.all([
      this.redis.client.scard(ONLINE), this.redis.client.scard(AVAILABLE), this.redis.client.zcard(Q),
    ]);
    const ids = await this.redis.client.smembers(AVAILABLE);
    const genders = ids.length
      ? await this.prisma.practitioner.groupBy({ by: ['gender'], where: { id: { in: ids } }, _count: true })
      : [];
    return { readersOnline: online, readersAvailable: available, waiting: queue, availableByGender: Object.fromEntries(genders.map((g) => [g.gender, g._count])) };
  }

  async join(userId: string, profileId: string, mode: Mode, gender: GenderPref) {
    const s = await this.settings.get();
    await this.profiles.own(userId, profileId);
    const open = await this.prisma.booking.findFirst({ where: { userId, service: 'tarot', status: { in: ['upcoming', 'live'] } } });
    if (open) return { status: 'matched', bookingId: open.id };
    const need = maxPrice(s, 'tarot', mode);
    const { available } = await this.wallet.available(userId);
    if (available < need) {
      throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: `Please add money. You need ₹${need} available for a tarot reading.`, required: need, available, shortBy: need - available });
    }
    const r = this.redis.client;
    await r.hset(REQ(userId), { profileId, mode, gender, joinedAt: Date.now() });
    await r.zadd(Q, 'NX', Date.now(), userId);
    await this.prisma.user.update({ where: { id: userId }, data: { tarotWaitlistOptOutAt: null } });
    await this.match();
    return this.status(userId);
  }

  async status(userId: string) {
    const s = await this.settings.get();
    const open = await this.prisma.booking.findFirst({ where: { userId, service: 'tarot', status: { in: ['upcoming', 'live'] } }, orderBy: { createdAt: 'desc' } });
    if (open) return { status: 'matched', bookingId: open.id };
    const rank = await this.redis.client.zrank(Q, userId);
    if (rank === null) return { status: 'idle' };
    const online = Math.max(1, await this.redis.client.scard(ONLINE));
    const position = rank + 1;
    return { status: 'waiting', position, etaMin: Math.ceil(position / online) * s.tarotAvgSessionMin };
  }

  /** Leaving the waiting room opts the user into a daily reminder (UC-21). */
  async leave(userId: string) {
    const removed = await this.redis.client.zrem(Q, userId);
    await this.redis.client.del(REQ(userId));
    if (removed) {
      await this.prisma.user.update({ where: { id: userId }, data: { tarotWaitlistOptOutAt: new Date() } });
      await this.notifications.notify(userId, 'tarot', 'tarot_optout');
      await this.broadcastPositions();
    }
    return { status: 'idle' };
  }

  // ----- practitioner presence (from the socket gateway) -----
  async readerOnline(practitionerId: string) {
    await this.redis.client.sadd(ONLINE, practitionerId);
    const busy = await this.prisma.booking.count({ where: { practitionerId, status: { in: ['upcoming', 'live'] }, service: 'tarot' } });
    if (!busy) await this.redis.client.sadd(AVAILABLE, practitionerId);
    await this.match();
  }
  async readerOffline(practitionerId: string) {
    await this.redis.client.srem(ONLINE, practitionerId);
    await this.redis.client.srem(AVAILABLE, practitionerId);
  }

  /** Pair waiting customers with free readers, oldest first. */
  async match() {
    await this.redis.withLock('tarot-match', 5000, async () => {
      const r = this.redis.client;
      const waiting = await r.zrange(Q, 0, -1);
      let matched = false;
      for (const userId of waiting) {
        const free = await r.smembers(AVAILABLE);
        if (!free.length) break;
        const req = await r.hgetall(REQ(userId));
        if (!req.profileId) { await r.zrem(Q, userId); continue; }
        const readers = await this.prisma.practitioner.findMany({
          where: { id: { in: free }, active: true, service: 'tarot', ...(req.gender !== 'any' ? { gender: req.gender as Gender } : {}) },
          orderBy: { rating: 'desc' },
        });
        const reader = readers[0];
        if (!reader) continue; // nobody of the preferred gender free; keep their place
        await r.srem(AVAILABLE, reader.id);
        const now = new Date();
        const b = await this.prisma.booking.create({
          data: { userId, profileId: req.profileId, practitionerId: reader.id, service: 'tarot', mode: req.mode as Mode, slotStart: now, practitionerReadyAt: now },
        });
        await r.zrem(Q, userId);
        await r.del(REQ(userId));
        matched = true;
        this.log.log(`Tarot match ${userId} -> ${reader.code} (${b.id})`);
        this.rt.toUser(userId, 'tarot:matched', { bookingId: b.id, practitioner: { id: reader.id, name: reader.name, gender: reader.gender } });
        this.rt.toPractitioner(reader.id, 'tarot:assigned', { bookingId: b.id });
        await this.notifications.notify(userId, 'tarot', 'tarot_matched', { practitioner: reader.name }, { bookingId: b.id });
      }
      if (matched || waiting.length) await this.broadcastPositions();
    });
  }

  private async broadcastPositions() {
    const waiting = await this.redis.client.zrange(Q, 0, -1);
    for (const userId of waiting) this.rt.toUser(userId, 'tarot:queue', await this.status(userId));
  }

  /** Daily reminder for users who left the waiting room, sent when readers are online (10 AM - 8 PM IST). */
  @Cron('0 */30 * * * *')
  async dailyReminders() {
    const h = istHour(Date.now());
    if (h < 10 || h > 20) return;
    const count = await this.redis.client.scard(AVAILABLE);
    if (!count) return;
    await this.redis.withLock('tarot-reminders', 60_000, async () => {
      const users = await this.prisma.user.findMany({ where: { tarotWaitlistOptOutAt: { not: null } }, select: { id: true } });
      const today = istDay(Date.now());
      for (const u of users) {
        if (await this.redis.once(`tarot-remind:${u.id}:${today}`, 86400)) {
          await this.notifications.notify(u.id, 'tarot', 'tarot_reminder', { count });
        }
      }
    });
  }
}
