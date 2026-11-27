import { Global, Injectable, Module } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { RedisService } from '../common/redis.service';

export type Actor = 'customer' | 'practitioner';

/**
 * Thin wrapper the services use to push events. Rooms:
 *   booking:<id>        both parties of a session
 *   user:<id>           all sockets of a customer (tarot match, wallet refresh)
 *   practitioner:<id>   all sockets of a practitioner
 * With the Redis adapter these emits reach sockets on every API instance.
 */
@Injectable()
export class RealtimeEvents {
  ns?: Namespace;

  constructor(private readonly redis: RedisService) {}

  toBooking(bookingId: string, event: string, data: unknown) {
    this.ns?.to(`booking:${bookingId}`).emit(event, data);
  }
  toUser(userId: string, event: string, data: unknown) {
    this.ns?.to(`user:${userId}`).emit(event, data);
  }
  toPractitioner(id: string, event: string, data: unknown) {
    this.ns?.to(`practitioner:${id}`).emit(event, data);
  }

  // ----- presence (Redis sets of socket ids, so it works across instances) -----
  private key(bookingId: string, who: Actor) {
    return `presence:${bookingId}:${who}`;
  }
  async join(bookingId: string, who: Actor, socketId: string) {
    await this.redis.client.multi().sadd(this.key(bookingId, who), socketId).expire(this.key(bookingId, who), 86400).exec();
    await this.redis.client.hdel(`absent:${bookingId}`, who);
  }
  async leave(bookingId: string, who: Actor, socketId: string) {
    await this.redis.client.srem(this.key(bookingId, who), socketId);
    if (!(await this.isPresent(bookingId, who))) {
      await this.redis.client.hsetnx(`absent:${bookingId}`, who, String(Date.now()));
    }
  }
  async isPresent(bookingId: string, who: Actor) {
    return (await this.redis.client.scard(this.key(bookingId, who))) > 0;
  }
  /** When the party dropped (epoch ms), or null if connected / never dropped. */
  async absentSince(bookingId: string, who: Actor) {
    const v = await this.redis.client.hget(`absent:${bookingId}`, who);
    return v ? Number(v) : null;
  }
  async clear(bookingId: string) {
    await this.redis.client.del(this.key(bookingId, 'customer'), this.key(bookingId, 'practitioner'), `absent:${bookingId}`);
  }
}

@Global()
@Module({ providers: [RealtimeEvents], exports: [RealtimeEvents] })
export class RealtimeModule {}
