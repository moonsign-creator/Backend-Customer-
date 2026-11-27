/* End-to-end smoke test against a running API (npm run start), with a seeded DB.
 * Covers: OTP login, profile, wallet top-up (mock gateway), slots, booking,
 * live chat session over Socket.IO with moderation and billing, tarot match,
 * reports, and concurrent bookings for the same slot.
 * Uses Prisma directly only to move a booking's slot into the past (time travel). */
import { PrismaClient } from '@prisma/client';
import { io, Socket } from 'socket.io-client';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const prisma = new PrismaClient();
let failures = 0;

function check(cond: unknown, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/rt`, { auth: { token }, transports: ['websocket'] });
    s.once('ready', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(phone: string) {
  await prisma.user.deleteMany({ where: { phone } });
  await redisDel(phone);
  const r1 = await api('/auth/otp/request', { body: { phone } });
  const bad = await api('/auth/otp/verify', { body: { phone, code: '000000' } });
  const r2 = await api('/auth/otp/verify', { body: { phone, code: '123456', lang: 'en' } });
  return { r1, bad, r2, token: r2.json.accessToken as string };
}
async function redisDel(phone: string) {
  const Redis = (await import('ioredis')).default;
  const r = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  await r.del(`otp:${phone}`, `otp-sends:${phone}`);
  await r.quit();
}

async function setupCustomer(phone: string, topup = 2000) {
  const { token } = await login(phone);
  const prof = await api('/profiles', { token, body: { name: 'Rahul Verma', relation: 'Self', dob: '1990-08-14', tob: '06:45', place: 'Lucknow, Uttar Pradesh' } });
  const order = await api('/wallet/topups', { token, body: { amount: topup } });
  await api('/wallet/topups/verify', { token, body: { orderId: order.json.orderId, paymentId: 'pay_mock', signature: 'mock_success', method: 'upi' } });
  return { token, profileId: prof.json.id as string };
}

async function main() {
  // ---------- Auth ----------
  const { r1, bad, r2, token } = await login('9000000001');
  check(r1.status === 200 && r1.json.resendAfterSec === 30, 'OTP requested, 30s resend');
  check(bad.status === 400 && bad.json.attemptsLeft === 2, 'wrong OTP rejected, 2 attempts left');
  check(r2.status === 200 && r2.json.needsProfile === true && !!token, 'OTP verified, new user needs profile');
  const resend = await api('/auth/otp/request', { body: { phone: '9000000001' } });
  check(resend.status === 200, 'OTP can be requested again after login');
  const tooSoon = await api('/auth/otp/request', { body: { phone: '9000000001' } });
  check(tooSoon.status === 429, 'resend within 30s refused');
  const refreshed = await api('/auth/refresh', { body: { refreshToken: r2.json.refreshToken } });
  check(refreshed.status === 200 && !!refreshed.json.accessToken, 'refresh token rotates');
  const reused = await api('/auth/refresh', { body: { refreshToken: r2.json.refreshToken } });
  check(reused.status === 401, 'old refresh token cannot be reused');
  check((await api('/me')).status === 401, 'protected route needs a token');

  // ---------- Profile, consent, catalog ----------
  const prof = await api('/profiles', { token, body: { name: 'Rahul Verma', relation: 'Self', dob: '1990-08-14', tob: '06:45', place: 'Lucknow, Uttar Pradesh' } });
  check(prof.status === 201, 'profile created');
  const profileId = prof.json.id;
  await api('/me', { method: 'PATCH', token, body: { recordingConsent: true, lang: 'hi' } });
  const me = await api('/me', { token });
  check(me.json.recordingConsent === true && me.json.lang === 'hi' && me.json.balance === 0, 'consent + Hindi saved, wallet starts at ₹0');
  const cats = await api(`/catalog/categories?profileId=${profileId}`, { token });
  check(cats.json.default === 'Finance' && cats.json.categories[0].questions.length === 3, 'age-based categories with common questions');
  const horo = await api(`/horoscope/${profileId}`, { token });
  check(!!horo.json.moonSign?.nameHi && !!horo.json.numerology?.title, 'horoscope + personal day');

  // ---------- Wallet ----------
  const slots = await api('/bookings/slots?service=astrology', { token });
  check(Array.isArray(slots.json) && slots.json.length > 0, `slots listed (${slots.json.length})`);
  const slot = slots.json.find((x: { available: boolean; sameBlock: boolean }) => x.available && !x.sameBlock) ?? slots.json[0];
  const noMoney = await api('/bookings', { token, body: { profileId, mode: 'chat', slotStart: slot.start } });
  check(noMoney.status === 400 && noMoney.json.code === 'INSUFFICIENT_BALANCE', 'booking refused with ₹0 wallet (needs 20-min price)');
  const small = await api('/wallet/topups', { token, body: { amount: 100 } });
  check(small.status === 400, 'top-up below minimum refused');
  const order = await api('/wallet/topups', { token, body: { amount: 1000 } });
  check(order.status === 201 && order.json.mock === true, 'top-up order created (mock gateway)');
  const failed = await api('/wallet/topups', { token, body: { amount: 500 } });
  const failRes = await api('/wallet/topups/verify', { token, body: { orderId: failed.json.orderId, paymentId: 'p', signature: 'mock_failure' } });
  check(failRes.json.status === 'failed' && failRes.json.balance === 0, 'failed payment credits nothing');
  const ok1 = await api('/wallet/topups/verify', { token, body: { orderId: order.json.orderId, paymentId: 'pay_1', signature: 'mock_success', method: 'upi' } });
  const ok2 = await api('/wallet/topups/verify', { token, body: { orderId: order.json.orderId, paymentId: 'pay_1', signature: 'mock_success', method: 'upi' } });
  check(ok1.json.status === 'success' && ok2.json.balance === 1000, 'top-up credited exactly once (₹1000)');

  // ---------- Booking ----------
  const booking = await api('/bookings', { token, body: { profileId, mode: 'chat', slotStart: slot.start, category: 'Finance', questions: ['Is this a good period to invest?'] } });
  check(booking.status === 201 && booking.json.practitioner?.name, `booked with ${booking.json.practitioner?.name}`);
  const bookingId = booking.json.id;
  const second = await api('/bookings', { token, body: { profileId, mode: 'chat', slotStart: slot.start } });
  check(second.status === 409, 'second consultation same day for same profile refused');
  const w = await api('/wallet', { token });
  check(w.json.held === 499 && w.json.available === 501, 'wallet shows ₹499 held for the open booking');
  const rc = await api(`/bookings/${bookingId}/reschedule-check`, { token });
  check(typeof rc.json.ok === 'boolean', `reschedule check: ${rc.json.reason}`);

  // ---------- Live session ----------
  // Time travel: the slot started 11 minutes ago, so pre-read is over and the astrologer is ready.
  await prisma.booking.update({ where: { id: bookingId }, data: { slotStart: new Date(Date.now() - 11 * 60_000) } });
  const pr = await api('/dev/practitioner-token', { body: { code: booking.json.practitioner.code } });
  const ps = await connect(pr.json.accessToken);
  const cs = await connect(token);
  const events: Record<string, unknown[]> = {};
  for (const ev of ['session:state', 'chat:message', 'session:ended', 'presence']) cs.on(ev, (d) => (events[ev] ??= []).push(d));

  const pj = await ps.emitWithAck('session:join', { bookingId });
  check(pj.ok && pj.state.phase === 'waiting', 'practitioner joined; waiting for customer');
  const cj = await cs.emitWithAck('session:join', { bookingId });
  check(cj.ok, 'customer joined');
  await wait(300);
  const st = await api(`/sessions/${bookingId}`, { token });
  check(st.json.phase === 'live' && st.json.status === 'live', 'session went live with server timer');

  const blocked = await cs.emitWithAck('chat:send', { bookingId, text: 'my number is 98765 43210' });
  check(blocked.ok === false && blocked.blocked, 'phone number blocked in chat');
  const sent = await cs.emitWithAck('chat:send', { bookingId, text: 'Should I invest this year?' });
  const reply = await ps.emitWithAck('chat:send', { bookingId, text: 'After mid-January looks favourable.' });
  await wait(300);
  check(sent.ok && reply.ok && (events['chat:message']?.length ?? 0) >= 2, 'chat messages delivered both ways');
  await ps.emitWithAck('practitioner:remedies', { bookingId, text: 'Offer water to the Sun every morning.' });

  // Pretend 12 minutes passed, then customer ends: charge = 15-minute slab (₹399).
  await prisma.booking.update({ where: { id: bookingId }, data: { startedAt: new Date(Date.now() - 12 * 60_000) } });
  const end = await cs.emitWithAck('session:end', { bookingId });
  await wait(300);
  check(end.ok && end.state.status === 'completed' && end.state.charged === 399, `session ended, charged ₹${end.state.charged} for ~12 min`);
  check((events['session:ended']?.length ?? 0) === 1, 'session:ended pushed to customer');
  const again = await cs.emitWithAck('session:end', { bookingId });
  const w2 = await api('/wallet', { token });
  check(again.state.charged === 399 && w2.json.balance === 601, 'ending twice charges once (balance ₹601)');
  const hist = await api(`/history/${bookingId}`, { token });
  check(hist.json.messages.length >= 3 && !!hist.json.remedies, 'history has transcript and remedies');
  const rate = await api(`/bookings/${bookingId}/rating`, { token, body: { rating: 5, feedback: 'Very clear' } });
  check(rate.status === 201, 'session rated');
  ps.disconnect();

  // ---------- No-show ----------
  const prof2 = await api('/profiles', { token, body: { name: 'Priya Verma', relation: 'Spouse', dob: '1993-02-03', tob: '21:10', place: 'Jaipur, Rajasthan' } });
  const b2 = await api('/bookings', { token, body: { profileId: prof2.json.id, mode: 'chat', slotStart: slot.start } });
  check(b2.status === 201, 'second profile can book the same day');
  await prisma.booking.update({ where: { id: b2.json.id }, data: { slotStart: new Date(Date.now() - 15 * 60_000) } });
  await wait(6000); // scheduler tick
  const b2s = await api(`/bookings/${b2.json.id}`, { token });
  check(b2s.json.status === 'no_show' && b2s.json.charged === 149, 'scheduler marked no-show and charged ₹149');

  // ---------- Tarot ----------
  const tr = await api('/dev/practitioner-token', { body: { code: 't1' } });
  const ts = await connect(tr.json.accessToken);
  await wait(300);
  const sum = await api('/tarot/summary', { token });
  check(sum.json.readersAvailable >= 1, `tarot readers available: ${sum.json.readersAvailable}`);
  const matched = new Promise((r) => cs.once('tarot:matched', r));
  const tq = await api('/tarot/queue', { token, body: { profileId, mode: 'chat', gender: 'female' } });
  const m = (await Promise.race([matched, wait(3000)])) as { bookingId?: string } | undefined;
  check(tq.json.status === 'matched' && m?.bookingId, 'tarot matched straight away with a female reader');
  ts.disconnect();
  cs.disconnect();

  // ---------- Reports & support ----------
  const more = await api('/wallet/topups', { token, body: { amount: 1000 } });
  await api('/wallet/topups/verify', { token, body: { orderId: more.json.orderId, paymentId: 'pay_2', signature: 'mock_success', method: 'card' } });
  const rep = await api('/reports', { token, body: { reportTypeId: 'r4', profileId } });
  check(rep.status === 201 && rep.json.status === 'ordered', 'monthly report ordered from wallet');
  const tk = await api('/support/tickets', { token, body: { subject: 'Charged twice?', category: 'Billing', message: 'Please check my last session.' } });
  check(tk.status === 201, 'support ticket created');
  const notes = await api('/notifications', { token });
  check(notes.json.items.some((n: { title: string }) => /[ऀ-ॿ]/.test(n.title)), 'notifications in Hindi for a Hindi user');
  const txns = await api('/wallet/transactions', { token });
  check(txns.json.items.length >= 4, `wallet ledger has ${txns.json.items.length} entries`);

  // ---------- Concurrency: 5 customers race for one slot with 3 astrologers ----------
  const fresh = (await api('/bookings/slots?service=astrology', { token })).json.find((x: { freePractitioners: number; sameBlock: boolean }) => x.freePractitioners === 3 && !x.sameBlock);
  if (fresh) {
    const customers = await Promise.all([1, 2, 3, 4, 5].map((i) => setupCustomer(`900000010${i}`)));
    const results = await Promise.all(customers.map((c) => api('/bookings', { token: c.token, body: { profileId: c.profileId, mode: 'voice', slotStart: fresh.start } })));
    if (results.some((r) => ![201, 409].includes(r.status))) console.log(results.map((r) => [r.status, r.json.message]));
    const okCount = results.filter((r) => r.status === 201).length;
    check(okCount === 3 && results.filter((r) => r.status === 409).length === 2, `slot race: ${okCount} booked, rest told the slot is full`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
