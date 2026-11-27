import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Booking } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { BusinessSettings, blockedReason, chargeFor, slabFor, slabPrice } from '../common/rules';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import { readyAt } from '../bookings/bookings.service';
import { Actor, RealtimeEvents } from './realtime.events';

export type EndedBy = 'customer' | 'practitioner' | 'auto' | 'dropped';
export type Phase = 'preread' | 'waiting' | 'live' | 'ended';

/** Seconds a party may be disconnected before the session is closed (UC-05 reconnect). */
export const RECONNECT_WINDOW_SEC = 180;

/**
 * The server owns the session clock (UC-05/06): it starts the timer when the
 * astrologer is ready and the customer has joined, sends slab warnings, ends at
 * the 20-minute maximum and charges the slab reached.
 */
@Injectable()
export class SessionsService {
  private readonly log = new Logger('Sessions');
  /** Set by TarotService to return a reader to the pool after a reading. */
  onSessionClosed?: (b: Booking) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly rt: RealtimeEvents,
  ) {}

  async authorize(bookingId: string, who: Actor, actorId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b) throw new NotFoundException('Session not found');
    const own = who === 'customer' ? b.userId === actorId : b.practitionerId === actorId;
    if (!own) throw new ForbiddenException('Not your session');
    return b;
  }

  async state(bookingId: string) {
    const s = await this.settings.get();
    const b = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { practitioner: { select: { id: true, name: true, gender: true, rating: true } }, profile: { select: { id: true, name: true } } },
    });
    return this.describe(b, s);
  }

  describe(b: Booking & Record<string, unknown>, s: BusinessSettings, now = Date.now()) {
    const ready = readyAt(b, s.prereadMin);
    const phase: Phase =
      b.status === 'live' ? 'live' : b.status === 'upcoming' ? (ready.getTime() > now ? 'preread' : 'waiting') : 'ended';
    const elapsedSec = b.startedAt ? Math.min(Math.floor(((b.endedAt?.getTime() ?? now) - b.startedAt.getTime()) / 1000), s.maxMinutes * 60) : 0;
    const slab = slabFor(s, elapsedSec);
    return {
      bookingId: b.id,
      status: b.status,
      phase,
      service: b.service,
      mode: b.mode,
      serverNow: new Date(now).toISOString(),
      slotStart: b.slotStart,
      readyAt: ready,
      prereadLeftSec: phase === 'preread' ? Math.ceil((ready.getTime() - now) / 1000) : 0,
      startedAt: b.startedAt,
      elapsedSec,
      maxSec: s.maxMinutes * 60,
      currentSlab: slab,
      currentCharge: chargeFor(s, b.service, b.mode, elapsedSec),
      slabs: s.slabs.map((m) => ({ minutes: m, price: slabPrice(s, b.service, b.mode, m) })),
      durationSec: b.durationSec,
      charged: b.charged,
      practitioner: b.practitioner,
      profile: b.profile,
    };
  }

  /** Customer opened the session screen. */
  async customerJoined(bookingId: string) {
    await this.prisma.booking.updateMany({ where: { id: bookingId, customerJoinedAt: null }, data: { customerJoinedAt: new Date() } });
    await this.maybeStart(bookingId);
  }

  /** Astrologer finished pre-reading early ("starts now"). */
  async practitionerReady(bookingId: string) {
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (b.status !== 'upcoming') return;
    if (Date.now() < b.slotStart.getTime() - 5 * 60_000) throw new BadRequestException('Too early: the slot has not started.');
    if (!b.practitionerReadyAt) {
      await this.prisma.booking.update({ where: { id: bookingId }, data: { practitionerReadyAt: new Date() } });
      const s = await this.settings.get();
      await this.notifications.notify(b.userId, 'session', 'practitioner_ready', { grace: s.noShowGraceMin }, { bookingId });
    }
    await this.maybeStart(bookingId);
  }

  /** Starts the clock once the astrologer is ready and both sides are connected. */
  async maybeStart(bookingId: string) {
    const s = await this.settings.get();
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (b.status !== 'upcoming') return this.rt.toBooking(bookingId, 'session:state', await this.state(bookingId));
    const ready = readyAt(b, s.prereadMin).getTime() <= Date.now();
    const both = (await this.rt.isPresent(bookingId, 'customer')) && (await this.rt.isPresent(bookingId, 'practitioner'));
    if (ready && both) {
      const started = await this.prisma.booking.updateMany({ where: { id: bookingId, status: 'upcoming' }, data: { status: 'live', startedAt: new Date() } });
      if (started.count) {
        await this.prisma.chatMessage.create({ data: { bookingId, sender: 'system', text: 'Session started. This conversation is securely stored.' } });
        this.log.log(`Session ${bookingId} started`);
      }
    }
    this.rt.toBooking(bookingId, 'session:state', await this.state(bookingId));
  }

  async sendMessage(bookingId: string, sender: Actor, text: string) {
    const clean = text.trim().slice(0, 2000);
    if (!clean) return { ok: false, reason: 'Empty message' };
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, mode: true } });
    if (b.status !== 'live') return { ok: false, reason: 'The session is not live.' };
    const reason = blockedReason(clean);
    if (reason) return { ok: false, blocked: true, reason };
    const m = await this.prisma.chatMessage.create({ data: { bookingId, sender, text: clean } });
    this.rt.toBooking(bookingId, 'chat:message', m);
    return { ok: true, message: m };
  }

  /** Ends a live session and charges the slab reached. Safe to call more than once. */
  async end(bookingId: string, endedBy: EndedBy, at = Date.now()) {
    const s = await this.settings.get();
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { profile: true } });
    if (b.status !== 'live' || !b.startedAt) return this.state(bookingId);
    const durationSec = Math.max(0, Math.min(Math.floor((at - b.startedAt.getTime()) / 1000), s.maxMinutes * 60));
    const charged = chargeFor(s, b.service, b.mode, durationSec);
    const status = endedBy === 'dropped' && (await this.rt.absentSince(bookingId, 'practitioner')) ? 'interrupted' : 'completed';

    const done = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.booking.updateMany({
        where: { id: bookingId, status: 'live' },
        data: { status, endedAt: new Date(at), endedBy, durationSec, charged },
      });
      if (!upd.count) return false;
      const minutes = Math.max(1, Math.ceil(durationSec / 60));
      const label = `${b.service === 'tarot' ? 'Tarot ' : ''}${b.mode} ${b.service === 'tarot' ? '' : 'consultation '}· ${minutes} min`;
      await this.wallet.debit(
        { userId: b.userId, amount: charged, reason: 'consultation', label: label[0].toUpperCase() + label.slice(1), reference: `consult:${bookingId}`, allowNegative: true },
        tx,
      );
      return true;
    });
    if (done) {
      this.log.log(`Session ${bookingId} ended by ${endedBy}: ${durationSec}s, ₹${charged}`);
      const extra = endedBy === 'auto' ? ` The session reached the ${s.maxMinutes}-minute maximum.` : '';
      await this.notifications.notify(b.userId, 'session', 'session_completed', { min: Math.ceil(durationSec / 60), charged, extra }, { bookingId });
      this.rt.toBooking(bookingId, 'session:ended', { bookingId, durationSec, charged, endedBy, status });
      await this.rt.clear(bookingId);
      const fresh = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      await this.onSessionClosed?.(fresh);
    }
    return this.state(bookingId);
  }

  /** UC-08: customer did not join within the grace period after the astrologer was ready. */
  async markNoShow(bookingId: string) {
    const s = await this.settings.get();
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { profile: true } });
    const done = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.booking.updateMany({
        where: { id: bookingId, status: 'upcoming', customerJoinedAt: null },
        data: { status: 'no_show', charged: s.noShowCharge, endedAt: new Date(), endedBy: 'no_show' },
      });
      if (!upd.count) return false;
      await this.wallet.debit(
        { userId: b.userId, amount: s.noShowCharge, reason: 'no_show', label: `No-show charge · ${b.profile.name}`, reference: `noshow:${bookingId}`, allowNegative: true },
        tx,
      );
      return true;
    });
    if (done) {
      await this.notifications.notify(b.userId, 'session', 'no_show', { name: b.profile.name, amount: s.noShowCharge }, { bookingId });
      this.rt.toBooking(bookingId, 'session:state', await this.state(bookingId));
      await this.rt.clear(bookingId);
    }
  }

  async setRemedies(bookingId: string, text: string) {
    await this.prisma.booking.update({ where: { id: bookingId }, data: { remedies: text.slice(0, 5000) } });
  }
}
