import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway,
} from '@nestjs/websockets';
import { IsBoolean, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Namespace, Socket } from 'socket.io';
import { AuthUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { TarotService } from '../tarot/tarot.service';
import { Actor, RealtimeEvents } from './realtime.events';
import { SessionsService } from './sessions.service';

class BookingRef {
  @IsUUID() bookingId: string;
}
class ChatSend extends BookingRef {
  @IsString() @MaxLength(2000) text: string;
}
class Typing extends BookingRef {
  @IsBoolean() typing: boolean;
}
class Remedies extends BookingRef {
  @IsString() @MaxLength(5000) text: string;
}

interface SocketData {
  user: AuthUser;
  bookings: Set<string>;
}

/**
 * Socket.IO namespace `/rt`. Connect with `auth: { token: <access token> }`.
 * Customers use the customer access token; practitioners use a practitioner
 * token from the practitioner web app (see /dev/practitioner-token in dev).
 */
@UsePipes(new ValidationPipe({ whitelist: true }))
@WebSocketGateway({ namespace: '/rt', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('Realtime');

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly rt: RealtimeEvents,
    private readonly sessions: SessionsService,
    private readonly tarot: TarotService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(ns: Namespace) {
    this.rt.ns = ns;
  }

  async handleConnection(socket: Socket) {
    try {
      const token = (socket.handshake.auth?.token as string) || String(socket.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
      const user = this.jwt.verify<AuthUser>(token, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
      (socket.data as SocketData) = { user, bookings: new Set() };
      await socket.join(user.role === 'customer' ? `user:${user.sub}` : `practitioner:${user.sub}`);
      if (user.role === 'practitioner') {
        const p = await this.prisma.practitioner.findUnique({ where: { id: user.sub } });
        if (p?.service === 'tarot') await this.tarot.readerOnline(p.id);
      }
      socket.emit('ready', { role: user.role, id: user.sub, serverNow: new Date().toISOString() });
    } catch {
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket) {
    const data = socket.data as SocketData | undefined;
    if (!data?.user) return;
    const who: Actor = data.user.role;
    for (const bookingId of data.bookings) {
      await this.rt.leave(bookingId, who, socket.id);
      if (!(await this.rt.isPresent(bookingId, who))) this.rt.toBooking(bookingId, 'presence', { bookingId, who, online: false });
    }
    if (who === 'practitioner') {
      const left = await this.rt.ns?.in(`practitioner:${data.user.sub}`).fetchSockets();
      if (!left?.length) await this.tarot.readerOffline(data.user.sub);
    }
  }

  private me(socket: Socket) {
    return (socket.data as SocketData).user;
  }

  /** Open the session screen. Returns the server's session state (timer, slab, phase). */
  @SubscribeMessage('session:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: BookingRef) {
    const u = this.me(socket);
    try {
      await this.sessions.authorize(body.bookingId, u.role, u.sub);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    await socket.join(`booking:${body.bookingId}`);
    (socket.data as SocketData).bookings.add(body.bookingId);
    await this.rt.join(body.bookingId, u.role, socket.id);
    this.rt.toBooking(body.bookingId, 'presence', { bookingId: body.bookingId, who: u.role, online: true });
    if (u.role === 'customer') await this.sessions.customerJoined(body.bookingId);
    else await this.sessions.maybeStart(body.bookingId);
    const messages = await this.prisma.chatMessage.findMany({ where: { bookingId: body.bookingId }, orderBy: { createdAt: 'asc' } });
    const other: Actor = u.role === 'customer' ? 'practitioner' : 'customer';
    return { ok: true, state: await this.sessions.state(body.bookingId), messages, otherOnline: await this.rt.isPresent(body.bookingId, other) };
  }

  @SubscribeMessage('session:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: BookingRef) {
    const u = this.me(socket);
    await socket.leave(`booking:${body.bookingId}`);
    (socket.data as SocketData).bookings.delete(body.bookingId);
    await this.rt.leave(body.bookingId, u.role, socket.id);
    this.rt.toBooking(body.bookingId, 'presence', { bookingId: body.bookingId, who: u.role, online: false });
    return { ok: true };
  }

  /** Send a chat message. Phone numbers and payment details are refused (ack.blocked). */
  @SubscribeMessage('chat:send')
  async chat(@ConnectedSocket() socket: Socket, @MessageBody() body: ChatSend) {
    const u = this.me(socket);
    if (!(socket.data as SocketData).bookings.has(body.bookingId)) return { ok: false, reason: 'Join the session first' };
    return this.sessions.sendMessage(body.bookingId, u.role, body.text);
  }

  @SubscribeMessage('chat:typing')
  typing(@ConnectedSocket() socket: Socket, @MessageBody() body: Typing) {
    const u = this.me(socket);
    if (!(socket.data as SocketData).bookings.has(body.bookingId)) return;
    socket.to(`booking:${body.bookingId}`).emit('chat:typing', { bookingId: body.bookingId, who: u.role, typing: body.typing });
  }

  @SubscribeMessage('session:end')
  async end(@ConnectedSocket() socket: Socket, @MessageBody() body: BookingRef) {
    const u = this.me(socket);
    await this.sessions.authorize(body.bookingId, u.role, u.sub);
    return { ok: true, state: await this.sessions.end(body.bookingId, u.role) };
  }

  // ----- practitioner-only events -----
  @SubscribeMessage('practitioner:ready')
  async ready(@ConnectedSocket() socket: Socket, @MessageBody() body: BookingRef) {
    const u = this.me(socket);
    if (u.role !== 'practitioner') return { ok: false, reason: 'Practitioners only' };
    await this.sessions.authorize(body.bookingId, 'practitioner', u.sub);
    await this.sessions.practitionerReady(body.bookingId);
    return { ok: true };
  }

  @SubscribeMessage('practitioner:remedies')
  async remedies(@ConnectedSocket() socket: Socket, @MessageBody() body: Remedies) {
    const u = this.me(socket);
    if (u.role !== 'practitioner') return { ok: false, reason: 'Practitioners only' };
    await this.sessions.authorize(body.bookingId, 'practitioner', u.sub);
    await this.sessions.setRemedies(body.bookingId, body.text);
    return { ok: true };
  }
}
