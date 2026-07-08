#!/usr/bin/env bash
set -euo pipefail

TO="${1:-${TO:-79054176285}}"
TEXT="${2:-${TEXT:-Callsec SMS test via Asterisk}}"
FROM="${FROM:-79952225212}"
ENDPOINT="${ENDPOINT:-novofon-endpoint}"
DOMAIN="${DOMAIN:-sip.novofon.ru}"
ASTERISK="${ASTERISK:-/usr/sbin/asterisk}"
CTX="callsec-test-sms-$$"
GLOBAL_STATUS="CALLSEC_SMS_STATUS_$$"

normalize_digits() {
  printf '%s' "$1" | tr -cd '0-9'
}

asterisk_rx() {
  sudo "$ASTERISK" -rx "$1"
}

cleanup() {
  asterisk_rx "dialplan remove context $CTX" >/dev/null 2>&1 || true
}
trap cleanup EXIT

TO_DIGITS="$(normalize_digits "$TO")"
FROM_DIGITS="$(normalize_digits "$FROM")"

if [[ -z "$TO_DIGITS" || -z "$FROM_DIGITS" ]]; then
  echo "TO and FROM must contain phone digits" >&2
  exit 2
fi

if [[ ${#TEXT} -gt 500 ]]; then
  echo "TEXT is too long for this quick SIP MESSAGE test" >&2
  exit 2
fi

# The dynamic Asterisk CLI command parser treats spaces and some punctuation in
# app data poorly. Keep this smoke test simple and deterministic.
DIALPLAN_TEXT="$(printf '%s' "$TEXT" | tr ' ,;()[]{}' '_________' | cut -c 1-160)"

echo "SMS test via Asterisk SIP MESSAGE"
echo "to=+$TO_DIGITS"
echo "from=+$FROM_DIGITS"
echo "endpoint=$ENDPOINT"
echo "domain=$DOMAIN"
echo "text=$TEXT"
echo "text_on_wire=$DIALPLAN_TEXT"
echo

asterisk_rx "dialplan remove context $CTX" >/dev/null 2>&1 || true

asterisk_rx "dialplan add extension s,1,Answer() into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,2,NoOp(CallsecSMS) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,3,Set(MESSAGE(body)=$DIALPLAN_TEXT) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,4,Set(MESSAGE(from)=sip:$FROM_DIGITS@$DOMAIN) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,5,Set(MESSAGE(to)=sip:$TO_DIGITS@$DOMAIN) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,6,Set(GLOBAL($GLOBAL_STATUS)=BEFORE) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,7,TryExec(MessageSend(pjsip:PJSIP/$TO_DIGITS@$ENDPOINT,sip:$FROM_DIGITS@$DOMAIN,sip:$TO_DIGITS@$DOMAIN)) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,8,Set(GLOBAL($GLOBAL_STATUS)=\${TRYSTATUS}:\${MESSAGE_SEND_STATUS}) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,9,NoOp(CallsecSMSStatus_\${TRYSTATUS}_\${MESSAGE_SEND_STATUS}) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,10,Wait(1) into $CTX" >/dev/null
asterisk_rx "dialplan add extension s,11,Hangup() into $CTX" >/dev/null

echo "Created temporary dialplan context: $CTX"
asterisk_rx "dialplan show $CTX" | sed -n '1,80p'
echo

echo "Originating Local/s@$CTX..."
asterisk_rx "channel originate Local/s@$CTX application Wait 5" || true
sleep 5

STATUS="$(asterisk_rx 'dialplan show globals' | awk -F= -v key="$GLOBAL_STATUS" '{gsub(/^[ \t]+|[ \t]+$/, "", $1); if ($1 == key) print $2}' | tail -n 1 | tr -d '\r' || true)"
if [[ -z "$STATUS" ]]; then
  STATUS="UNKNOWN"
fi

echo
echo "MESSAGE_SEND_STATUS=$STATUS"
echo
echo "Recent Asterisk log lines:"
sudo tail -n 80 /var/log/asterisk/full 2>/dev/null | grep -E "Callsec SMS|MESSAGE|MessageSend|$CTX|$GLOBAL_STATUS|$TO_DIGITS" || true

case "$STATUS" in
  SUCCESS:SUCCESS|*:SUCCESS)
    echo
    echo "Asterisk accepted the SIP MESSAGE for delivery. This does not guarantee that Novofon converted it to a real SMS."
    ;;
  *)
    echo
    echo "Asterisk did not report SUCCESS. Novofon may not support outbound SMS/SIP MESSAGE on this trunk."
    exit 1
    ;;
esac
