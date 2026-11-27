-- A practitioner can hold only one open booking per slot. Prisma cannot express
-- partial indexes in the schema, so it lives here. Concurrent bookings for the
-- same practitioner+slot fail with a unique violation and the API retries.
CREATE UNIQUE INDEX "Booking_practitioner_slot_open_key"
  ON "Booking" ("practitionerId", "slotStart")
  WHERE status IN ('upcoming', 'live');

-- Wallet balance can only go negative through post-session charges that were
-- pre-checked at booking; guard against anything larger by mistake.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_floor" CHECK (balance > -100000);
