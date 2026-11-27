import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Shared Redis connection: OTPs, presence, tarot queue, scheduler locks. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
      maxRetriesPerRequest: 3,
    });
  }

  /** Best-effort distributed lock so only one API instance runs a periodic job. */
  async withLock(key: string, ttlMs: number, fn: () => Promise<void>) {
    const token = Math.random().toString(36).slice(2);
    const ok = await this.client.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    if (!ok) return;
    try {
      await fn();
    } finally {
      const cur = await this.client.get(`lock:${key}`);
      if (cur === token) await this.client.del(`lock:${key}`);
    }
  }

  /** Returns true the first time it is called for `key` (within ttl). */
  async once(key: string, ttlSec: number) {
    return (await this.client.set(`once:${key}`, '1', 'EX', ttlSec, 'NX')) === 'OK';
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
