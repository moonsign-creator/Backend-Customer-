/* Load check: N concurrent live chat sessions (default 100) on one API instance.
 * Creates N customers + N practitioners directly in the DB, connects 2N sockets,
 * starts every session, exchanges messages, ends them, and reports latency. */
import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';
import 'dotenv/config';

const N = Number(process.env.N ?? 100);
const MSGS = Number(process.env.MSGS ?? 10);
const BASE = process.env.API_URL ?? 'http://localhost:3000';
const prisma = new PrismaClient();
const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

const connect = (token: string) =>
  new Promise<Socket>((res, rej) => {
    const s = io(`${BASE}/rt`, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.once('ready', () => res(s));
    s.once('connect_error', rej);
  });

async function main() {
  const tag = `load${Date.now() % 100000}`;
  const slot = new Date(Date.now() - 11 * 60_000);
  const pairs = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const user = await prisma.user.create({ data: { phone: `7${String(Date.now() % 1e6).padStart(6, '0')}${String(i).padStart(3, '0')}`, wallet: { create: { balance: 1000 } } } });
      const profile = await prisma.profile.create({ data: { userId: user.id, name: `Load ${i}`, relation: 'Self', dob: '1990-01-01', tob: '10:00', place: 'Pune' } });
      const pr = await prisma.practitioner.create({ data: { code: `${tag}_${i}`, name: `Load P ${i}`, service: 'astrology', gender: 'male', languages: ['Hindi'], experienceYears: 1, active: false } });
      const b = await prisma.booking.create({ data: { userId: user.id, profileId: profile.id, practitionerId: pr.id, service: 'astrology', mode: 'chat', slotStart: slot } });
      return {
        b: b.id,
        ct: jwt.sign({ sub: user.id, role: 'customer' }),
        pt: jwt.sign({ sub: pr.id, role: 'practitioner' }),
      };
    }),
  );
  console.log(`created ${N} bookings`);

  const t0 = Date.now();
  const socks = await Promise.all(pairs.map(async (p) => ({ ...p, c: await connect(p.ct), p: await connect(p.pt) })));
  console.log(`${2 * N} sockets connected in ${Date.now() - t0} ms`);

  await Promise.all(socks.map(async (s) => { await s.p.emitWithAck('session:join', { bookingId: s.b }); await s.c.emitWithAck('session:join', { bookingId: s.b }); }));
  const live = await prisma.booking.count({ where: { id: { in: pairs.map((p) => p.b) }, status: 'live' } });
  console.log(`${live}/${N} sessions live`);

  const lat: number[] = [];
  await Promise.all(socks.map(async (s) => {
    for (let k = 0; k < MSGS; k++) {
      const got = new Promise<void>((r) => s.p.once('chat:message', () => r()));
      const t = Date.now();
      await s.c.emitWithAck('chat:send', { bookingId: s.b, text: `question ${k}` });
      await got;
      lat.push(Date.now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  const pct = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  console.log(`${lat.length} messages delivered · p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · p99 ${pct(0.99)} ms`);

  await Promise.all(socks.map((s) => s.c.emitWithAck('session:end', { bookingId: s.b })));
  const done = await prisma.booking.count({ where: { id: { in: pairs.map((p) => p.b) }, status: 'completed' } });
  console.log(`${done}/${N} sessions ended (sub-second sessions are free: only attended time is charged)`);
  socks.forEach((s) => { s.c.disconnect(); s.p.disconnect(); });

  // clean up
  await prisma.booking.deleteMany({ where: { id: { in: pairs.map((p) => p.b) } } });
  await prisma.practitioner.deleteMany({ where: { code: { startsWith: tag } } });
  await prisma.$disconnect();
  process.exit(live === N && done === N ? 0 : 1);
}
main();
