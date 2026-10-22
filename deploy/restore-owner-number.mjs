import fs from 'node:fs';
import { prisma } from '/app/apps/api/dist/lib/prisma.js';
import { createBalanceLedgerEntry, lockUserLedger } from '/app/apps/api/dist/lib/balance-ledger.js';
import { addNumberRentDays, NUMBER_RENT_PERIOD_DAYS } from '/app/apps/api/dist/lib/number-rental.js';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!/^\+7\d{10}$/.test(input.phone || '')) throw new Error('Owner phone required through stdin.');
const targetNumber = '+79952225212';
try {
  const result = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.findUniqueOrThrow({ where: { phone: input.phone } });
    await lockUserLedger(tx, owner.id);
    const inbound = await tx.assistantProfile.findUniqueOrThrow({
      where: { userId_mode: { userId: owner.id, mode: 'INBOUND' } },
    });
    const number = await tx.reservedPhoneNumber.findUniqueOrThrow({
      where: { number: targetNumber }, include: { profiles: { select: { userId: true } } },
    });
    if (number.profiles.some((profile) => profile.userId !== owner.id)) {
      throw new Error('Requested number is assigned to another account.');
    }
    const now = new Date();
    const currentPeriodValid = owner.numberRentExpiresAt && owner.numberRentExpiresAt > now;
    const expiresAt = currentPeriodValid ? owner.numberRentExpiresAt : addNumberRentDays(now, NUMBER_RENT_PERIOD_DAYS);
    const changed = inbound.reservedNumberId !== number.id || !currentPeriodValid;
    await tx.reservedPhoneNumber.update({ where: { id: number.id }, data: { assigned: true } });
    await tx.assistantProfile.update({ where: { id: inbound.id }, data: { reservedNumberId: number.id } });
    await tx.user.update({
      where: { id: owner.id },
      data: { numberPurchasedAt: owner.numberPurchasedAt || now, numberRentExpiresAt: expiresAt },
    });
    if (inbound.reservedNumberId && inbound.reservedNumberId !== number.id) {
      const links = await tx.assistantProfile.count({ where: { reservedNumberId: inbound.reservedNumberId } });
      if (!links) await tx.reservedPhoneNumber.update({ where: { id: inbound.reservedNumberId }, data: { assigned: false } });
    }
    if (changed) {
      await createBalanceLedgerEntry(tx, {
        userId: owner.id, type: 'NUMBER_PURCHASE', amountKopecks: 0,
        note: `Восстановлено закрепление номера ${targetNumber} при переносе сервиса; без повторного списания.`,
      });
    }
    const balance = await tx.billingTransaction.aggregate({ where: { userId: owner.id }, _sum: { amountKopecks: true } });
    return { restored: changed, number: targetNumber, expiresAt, chargedKopecks: 0, balanceKopecks: balance._sum.amountKopecks || 0 };
  }, { isolationLevel: 'Serializable' });
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
