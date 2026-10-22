#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = process.argv[3] || 'https://callsec.ru';

async function main() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: input.phone, password: input.password }),
  });
  const session = await login.json();
  if (!login.ok || !session.token) throw new Error(`Login returned ${login.status}`);
  const headers = { Authorization: `Bearer ${session.token}` };
  const results = await Promise.all(['/healthz', '/api/profiles/me', '/api/billing/me', '/api/integrations/me', '/api/admin/users']
    .map(async (endpoint) => {
      const response = await fetch(`${base}${endpoint}`, { headers });
      const body = await response.json();
      if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`);
      return [endpoint, body];
    }));
  const data = Object.fromEntries(results);
  console.log(JSON.stringify({
    login: true,
    apiHealthy: Boolean(data['/healthz'].ok),
    profileCount: Object.values(data['/api/profiles/me'].profiles).filter(Boolean).length,
    rubleBalance: data['/api/billing/me'].billing.rubleBalance,
    numberRented: Boolean(data['/api/billing/me'].billing.reservedNumber),
    googleStatus: data['/api/integrations/me'].integrations.google.status,
    telegramStatus: data['/api/integrations/me'].integrations.telegram.status,
    adminAccess: true,
  }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
