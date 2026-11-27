import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, TxnReason } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { maxPrice } from '../common/rules';

type Tx = Prisma.TransactionClient;

export interface LedgerEntry {
  userId: string;
  amount: number;
  reason: TxnReason;
  label: string;
  /** Unique per money movement (e.g. `consult:<bookingId>`). Replays are ignored. */
  reference: string;
  method?: string;
}

/**
 * Wallet = append-only ledger + cached balance. Every credit/debit runs in a DB
 * transaction with a row lock on the wallet, and is idempotent by `reference`.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async getWallet(userId: string) {
    return this.prisma.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  /**
   * Balance minus the maximum possible charge of every upcoming/live consultation.
   * A new booking needs this to cover its own maximum (UC-03 "20-minute wallet check").
   */
  async available(userId: string, excludeBookingId?: string) {
    const s = await this.settings.get();
    const [wallet, open] = await Promise.all([
      this.getWallet(userId),
      this.prisma.booking.findMany({
        where: { userId, status: { in: ['upcoming', 'live'] }, ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}) },
        select: { service: true, mode: true },
      }),
    ]);
    const held = open.reduce((sum, b) => sum + maxPrice(s, b.service, b.mode), 0);
    return { balance: wallet.balance, held, available: wallet.balance - held };
  }

  credit(e: LedgerEntry, tx?: Tx) {
    return this.move('credit', e, tx);
  }

  /** Debits; `allowNegative` is used for post-session charges that were pre-checked at booking. */
  debit(e: LedgerEntry & { allowNegative?: boolean }, tx?: Tx) {
    return this.move('debit', e, tx);
  }

  private async move(type: 'credit' | 'debit', e: LedgerEntry & { allowNegative?: boolean }, tx?: Tx) {
    if (e.amount <= 0) return null;
    const run = async (db: Tx) => {
      const dup = await db.walletTransaction.findUnique({ where: { reference: e.reference } });
      if (dup) return dup;
      await db.wallet.upsert({ where: { userId: e.userId }, create: { userId: e.userId }, update: {} });
      const [w] = await db.$queryRaw<{ id: string; balance: number }[]>`
        SELECT id, balance FROM "Wallet" WHERE "userId" = ${e.userId} FOR UPDATE`;
      const next = type === 'credit' ? w.balance + e.amount : w.balance - e.amount;
      if (type === 'debit' && next < 0 && !e.allowNegative) throw new BadRequestException('Insufficient wallet balance');
      await db.wallet.update({ where: { id: w.id }, data: { balance: next } });
      return db.walletTransaction.create({
        data: { walletId: w.id, type, reason: e.reason, amount: e.amount, balanceAfter: next, label: e.label, method: e.method, reference: e.reference },
      });
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  async transactions(userId: string, cursor?: string, take = 30) {
    const w = await this.getWallet(userId);
    const items = await this.prisma.walletTransaction.findMany({
      where: { walletId: w.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > take;
    return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
  }
}
