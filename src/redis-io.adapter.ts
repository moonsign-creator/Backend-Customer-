import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/** Socket.IO over Redis pub/sub so several API instances share rooms and emits. */
export class RedisIoAdapter extends IoAdapter {
  private adapter?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext, private readonly redisUrl: string, private readonly origins: string[] | true) {
    super(app);
  }

  async connect() {
    const pub = new Redis(this.redisUrl);
    const sub = pub.duplicate();
    this.adapter = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
      pingInterval: 10_000,
      pingTimeout: 8_000,
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 },
    });
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }
}
