'use strict';

function callFileValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeDialPhone(value) {
  return String(value || '').replace(/\D+/g, '').slice(0, 20);
}

function getQueuedCallDirection(profile) {
  return String(profile?.direction || 'OUTBOUND').toUpperCase() === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
}

function getOutboundCallerId(profile) {
  return normalizeDialPhone(profile?.outboundCallerId || profile?.reservedNumber?.number || '');
}

function buildOutboundCallFile({
  uuid,
  phone,
  profile,
  job,
  outboundTrunk,
  outboundContext,
  outboundExtension,
  outboundWaitTimeSec,
}) {
  const normalizedPhone = normalizeDialPhone(phone);
  const callerId = getOutboundCallerId(profile);
  if (!normalizedPhone) throw new Error('Outbound destination phone is required');
  if (!callerId) throw new Error('Client reserved number is required for outbound calls');

  const direction = getQueuedCallDirection(profile);
  const channel = `${outboundTrunk}:${normalizedPhone}@sip.novofon.ru`;
  const callerIdLine = `"${callFileValue(profile.clientName || 'AI Secretary')}" <${callerId}>`;

  return [
    `Channel: ${channel}`,
    `CallerID: ${callerIdLine}`,
    'MaxRetries: 0',
    'RetryTime: 60',
    `WaitTime: ${Math.max(10, outboundWaitTimeSec)}`,
    `Context: ${outboundContext}`,
    `Extension: ${outboundExtension}`,
    'Priority: 1',
    'Archive: yes',
    `Setvar: AI_UUID=${uuid}`,
    `Setvar: AI_DID=${callerId}`,
    `Setvar: AI_CALLER=${normalizedPhone}`,
    `Setvar: AI_DIRECTION=${direction}`,
    `Setvar: AI_OUTBOUND_CONTACT_ID=${callFileValue(job.id)}`,
    `Setvar: AI_ASSISTANT_PROFILE_ID=${callFileValue(profile.assistantProfileId || '')}`,
    `Setvar: AI_CLIENT_ID=${callFileValue(profile.clientId || '')}`,
    '',
  ].join('\n');
}

module.exports = {
  buildOutboundCallFile,
  getOutboundCallerId,
  getQueuedCallDirection,
  normalizeDialPhone,
};
