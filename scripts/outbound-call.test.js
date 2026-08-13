'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildOutboundCallFile, getOutboundCallerId } = require('../outbound-call');

const baseCall = {
  uuid: '2f374ebc-2a10-47b3-a012-3456789abcde',
  phone: '+7 (905) 417-62-85',
  job: { id: 'contact-1' },
  outboundTrunk: 'PJSIP/novofon-endpoint/sip',
  outboundContext: 'ai-outbound',
  outboundExtension: 's',
  outboundWaitTimeSec: 45,
};

test('uses the client reserved number as outbound caller ID and DID', () => {
  const profile = {
    clientName: 'Callsec client',
    clientId: 'client-1',
    assistantProfileId: 'profile-1',
    direction: 'OUTBOUND',
    outboundCallerId: '+7 995 222-52-12',
  };

  const content = buildOutboundCallFile({ ...baseCall, profile });

  assert.match(content, /^CallerID: "Callsec client" <79952225212>$/m);
  assert.match(content, /^Setvar: AI_DID=79952225212$/m);
  assert.match(content, /^Setvar: AI_CALLER=79054176285$/m);
  assert.doesNotMatch(content, /^CallerID: .*<79054176285>$/m);
});

test('falls back only to a reserved number from the same profile', () => {
  assert.equal(getOutboundCallerId({ reservedNumber: { number: '+7 999 000-00-01' } }), '79990000001');
  assert.equal(getOutboundCallerId({}), '');
});

test('refuses to create an outbound call without a client number', () => {
  assert.throws(
      () => buildOutboundCallFile({ ...baseCall, profile: { clientName: 'No number' } }),
      /Client reserved number is required/
  );
});
