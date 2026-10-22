import fs from 'node:fs';
import { prisma } from '/app/apps/api/dist/lib/prisma.js';
import { hashPassword } from '/app/apps/api/dist/lib/auth.js';
import { createDefaultProfiles, createStartingBalanceGrant } from '/app/apps/api/dist/lib/account-provisioning.js';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!/^\+7\d{10}$/.test(input.phone || '') || !/^\d{6}$/.test(input.password || '')) {
  throw new Error('Expected owner phone and six-digit password through stdin.');
}
try {
  const password = await hashPassword(input.password);
  const result = await prisma.$transaction(async (tx) => {
    for (const [number, assigned] of [['+79952225212', true], ['+79952225213', false]]) {
      await tx.reservedPhoneNumber.upsert({
        where: { number },
        update: { providerDid: number.replace(/\D/g, '') },
        create: { number, providerDid: number.replace(/\D/g, ''), assigned },
      });
    }
    let owner = await tx.user.findUnique({ where: { phone: input.phone } });
    const created = !owner;
    if (!owner) {
      owner = await tx.user.create({
        data: { phone: input.phone, password, fullName: input.fullName || null, rubleBalance: 0, rubleBalanceKopecks: 0 },
      });
      await createDefaultProfiles(tx, owner.id, owner.phone);
      await createStartingBalanceGrant(tx, owner.id);
    }
    return { ownerCreated: created, profileCount: await tx.assistantProfile.count({ where: { userId: owner.id } }) };
  });
  console.log(JSON.stringify({ ...result, numberCount: await prisma.reservedPhoneNumber.count(), callCount: await prisma.callLog.count() }));
} finally {
  await prisma.$disconnect();
}
