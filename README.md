# NamyaAstro – Customer Backend

API and real-time server for the NamyaAstro customer app (Expo / React Native).
Covers the customer journey from *Use Case Document V2* (UC-01 to UC-10): phone OTP login, family profiles, wallet with Razorpay top-ups, slot booking, live chat/voice consultations with server-side timer and slab billing, live tarot with a waiting room, reports, history, support and notifications, in English and Hindi.

**Stack:** Node.js 22 · NestJS 11 (TypeScript) · PostgreSQL 16 (Prisma ORM) · Redis 7 · Socket.IO (Redis adapter) · Razorpay · Agora (voice) · MSG91 (OTP SMS) · Firebase Cloud Messaging (push)

---

## Quick start (local)

Needs Node.js 22+ and Docker (or your own Postgres 16 + Redis 7).

```bash
git clone https://github.com/moonsign-creator/Backend-Customer-.git
cd Backend-Customer-
cp .env.example .env            # defaults work for local dev
docker compose up -d            # Postgres on 5432, Redis on 6379
npm install
npm run db:deploy               # create tables
npm run db:seed                 # 3 astrologers, 3 tarot readers, 5 report types
npm run start:dev               # http://localhost:3000
```

- API base: `http://localhost:3000/v1`
- Interactive API docs (Swagger): `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`
- Real-time: Socket.IO namespace `/rt`

In dev mode no external accounts are needed:
- **OTP** is logged to the console and is always `123456` (same as the app's demo).
- **Razorpay** runs a mock gateway: verify with signature `mock_success`, `mock_failure` or `mock_pending`.
- **Agora** returns a placeholder token. **Push** notifications are logged instead of sent.

### Checks

```bash
npm test          # unit tests for billing, reschedule, moderation rules
npm run smoke     # end-to-end test against a running server (41 checks)
npm run load      # 100 concurrent live chat sessions on one instance
```

The smoke test drives the whole journey: login, profile, wallet top-up, booking, a live chat over Socket.IO (with blocked phone numbers and correct slab charge), a no-show, a tarot match, reports, support, Hindi notifications, and five customers racing for a slot that has three astrologers. Run the server with `THROTTLE_DISABLED=true` for it, since it logs in many users from one IP.

Load test result on a single instance (laptop-class container): 200 sockets connected in ~250 ms, 100/100 sessions live, 1,000 chat messages delivered with p50 ≈ 50 ms and p99 ≈ 75 ms.

---

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis for OTPs, presence, tarot queue, Socket.IO adapter, job locks |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **Set long random values in production** |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL_DAYS` | Access token life (default 15m) / refresh token life (default 30 days, rotated on use) |
| `OTP_PROVIDER` | `console` (dev) or `msg91`, plus `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Leave empty for the mock gateway |
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | Voice consultations |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to a Firebase service-account JSON for FCM push |
| `CORS_ORIGINS` | Comma-separated origins, `*` in dev |
| `TRUST_PROXY` | Number of proxies in front (so rate limits see the real IP) |

### Going live checklist
1. Postgres and Redis managed instances (e.g. AWS RDS + ElastiCache, or any provider in the Mumbai region).
2. Set real JWT secrets, `NODE_ENV=production` (this also turns off the `/v1/dev/*` helpers).
3. MSG91: create an OTP flow template with an `otp` variable; set `OTP_PROVIDER=msg91`.
4. Razorpay: add keys; add a webhook to `https://<api>/v1/webhooks/razorpay` for `payment.captured`, `order.paid`, `payment.failed` with the webhook secret.
5. Agora: create a project with App Certificate enabled.
6. Firebase: download a service-account key; the app registers device tokens with `POST /v1/me/devices`.
7. Deploy with the `Dockerfile` (runs migrations on start). For more than one instance, put them behind a load balancer with WebSocket support; Socket.IO events and scheduled jobs are already coordinated through Redis.

---

## How the app's screens map to the API

All routes are under `/v1` and need `Authorization: Bearer <accessToken>` unless marked public.

| App screen | Endpoints |
|---|---|
| Language, phone, OTP (30 s resend, 3 attempts) | `POST /auth/otp/request`, `POST /auth/otp/verify` (public) · `POST /auth/refresh`, `POST /auth/logout` |
| First profile + recording consent, language | `POST /profiles` · `PATCH /me { lang, recordingConsent }` · `GET /me` |
| Home: horoscope, Personal Day | `GET /horoscope/:profileId` |
| Wallet, add money | `GET /wallet` (balance, held, available) · `GET /wallet/transactions` · `POST /wallet/topups` → Razorpay Checkout → `POST /wallet/topups/verify` · `GET /wallet/topups/:orderId` (pending / delayed confirmation) |
| Booking wizard | `GET /catalog/config` (prices, slabs, rules) · `GET /catalog/categories?profileId=` · `GET /bookings/slots` · `GET /bookings/day-check` · `POST /bookings` |
| Consult tab, booking detail | `GET /bookings?filter=upcoming|past` · `GET /bookings/:id` · `GET /catalog/practitioners` |
| Reschedule | `GET /bookings/:id/reschedule-check` · `POST /bookings/:id/reschedule` |
| Live session | Socket `/rt` (below) · `GET /sessions/:id` · `GET /sessions/:id/rtc-token` (voice) · `POST /sessions/:id/end` |
| Summary + rating | `POST /bookings/:id/rating` |
| Live tarot, waiting room | `GET /tarot/summary` · `POST /tarot/queue` · `GET /tarot/queue` · `POST /tarot/queue/leave` |
| Reports | `GET /catalog/report-types` · `POST /reports` · `GET /reports` · `GET /reports/:id` |
| History with transcripts and remedies | `GET /history?profileId=` · `GET /history/:id` |
| Support | `GET/POST /support/tickets` · `GET /support/tickets/:id` |
| Notifications | `GET /notifications` · `POST /notifications/read-all` · `POST /me/devices` (FCM token) |
| Birth place suggestions | `GET /catalog/places?q=` |

Errors the app should handle specially: `400 { code: "INSUFFICIENT_BALANCE", required, available, shortBy }` (open Add money with `shortBy` pre-filled), `409` (slot full / profile already booked that day), `429` (OTP resend too soon, with `retryAfterSec`).

### Real-time (Socket.IO)

```ts
import { io } from 'socket.io-client';
const socket = io('https://<api>/rt', { auth: { token: accessToken }, transports: ['websocket'] });

const { state, messages, otherOnline } = await socket.emitWithAck('session:join', { bookingId });
socket.on('session:state', (s) => { /* phase: preread | waiting | live | ended, elapsedSec, currentSlab, currentCharge, serverNow */ });
socket.on('session:warning', (w) => { /* "In 1 minute this session moves to the 15-minute rate (₹399)" */ });
socket.on('chat:message', (m) => {});
socket.on('chat:typing', (t) => {});
socket.on('presence', (p) => { /* other side dropped / reconnected */ });
socket.on('session:ended', (e) => { /* durationSec, charged, endedBy -> summary screen */ });
socket.on('tarot:matched', ({ bookingId }) => {});
socket.on('tarot:queue', ({ position, etaMin }) => {});

const ack = await socket.emitWithAck('chat:send', { bookingId, text });   // ack.blocked + ack.reason if phone/payment details
socket.emit('chat:typing', { bookingId, typing: true });
await socket.emitWithAck('session:end', { bookingId });
```

The timer is owned by the server. The app should show `elapsedSec` from `session:state` and count locally from `serverNow`, re-syncing on every state event and after reconnecting.

---

## Business rules implemented

Values are admin-controlled: defaults are in `src/common/rules.ts` and any key can be overridden by a row in the `Setting` table (picked up within 30 s).

- **Slab billing:** ₹ price of the slab reached (10 / 15 / 20 min), only for time actually attended. Max 20 minutes, then the session ends automatically. Warning one minute before each next slab.
- **Wallet check:** a booking needs the 20-minute price *available*, i.e. balance minus the maximum of the customer's other open bookings. The actual charge is taken when the session ends.
- **Wallet ledger:** every credit/debit is a row with `balanceAfter` and a unique `reference`, written in one transaction with a row lock, so a payment or session charge can never be applied twice.
- **Slots:** hourly IST blocks over the next 24 h within service hours (7 AM – 11 PM). The current block is bookable only in its first 20 minutes. A block is full when no astrologer working that hour is free. The astrologer is assigned at confirmation (least booked that day), and a database constraint stops two bookings landing on the same astrologer and slot.
- **One consultation per profile per day** (IST).
- **Pre-read:** the astrologer reads the chart for 10 minutes from the slot start (or marks ready earlier). The customer is notified when pre-reading starts and when the astrologer is ready.
- **No-show:** if the customer has not joined 4 minutes after the astrologer is ready, the booking is marked no-show and ₹149 is charged.
- **Reschedule:** first reschedule free if ≥ 30 min before; another only if ≥ 12 h before. Same astrologer kept when free.
- **Reconnect:** if either side is disconnected for more than 3 minutes during a live session, it closes and charges only up to the drop. If the astrologer dropped, it is marked *interrupted*.
- **Chat moderation:** phone numbers and payment details (UPI ids, card/bank words) are refused.
- **Tarot:** first come, first served, with Female / Male / Any preference. Leaving the waiting room opts the customer into one reminder a day (10 AM – 8 PM IST) when readers are online.
- **Language:** notifications and pushes go out in the user's language (English / Hindi).

---

## Project layout

```
prisma/              schema, migrations, seed
src/common/          Prisma, Redis, auth guard, settings, business rules, IST time, i18n
src/auth/            OTP login, JWT access + rotating refresh tokens
src/users/ profiles/ account, consent, devices, family profiles
src/catalog/         config, practitioners, categories & questions, places, report types
src/wallet/          ledger, Razorpay top-ups and webhook
src/bookings/        slots, booking, reschedule, rating, history
src/sessions/        live session service, Socket.IO gateway, scheduler, Agora tokens
src/tarot/           readers online, waiting room, matching, reminders
src/reports/ support/ notifications/ horoscope/
src/dev/             dev-only helpers (practitioner token, mark report ready)
scripts/             smoke and load tests
```

## Not in this repo yet

- **Practitioner web app and admin website** (UC-20 – UC-34). The socket already accepts practitioner tokens and handles `practitioner:ready`, chat, `practitioner:remedies` and ending a session; the practitioner login and admin endpoints (pricing, report fulfilment, ticket replies, practitioner schedules) belong to those projects. `POST /v1/dev/practitioner-token` stands in for practitioner login during development.
- **Real horoscope / moon sign calculation.** The moon sign and daily text use the same placeholder as the app; plug in an ephemeris service.
- **Monthly report renewals** (recurring charge each month) and **wallet withdrawal**, which the use-case document still lists as to be confirmed.
- **Voice-to-text and remedy audio conversion.**
