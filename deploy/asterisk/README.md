# Host telephone service

These files restore the host Asterisk and AudioSocket service on Ubuntu 24.04.
The Git checkout is `/opt/callsec`; recordings remain in
`/home/andrew/ai/records`. Node.js 24 must be available as
`/usr/local/bin/node`. The website and API run in Docker independently.

## Configuration

Prepare a root-readable JSON file outside the checkout with these fields:

```json
{
  "publicIp": "83.217.203.61",
  "sipHost": "sip.novofon.ru",
  "sipTransport": "tls",
  "sipPort": 5061,
  "sipBindPort": 5071,
  "sipUsername": "SIP_LOGIN",
  "sipPassword": "SIP_PASSWORD",
  "metadataToken": "GENERATED_URL_SAFE_TOKEN_AT_LEAST_32_CHARACTERS",
  "dids": ["79952225212", "79952225213"]
}
```

The metadata token must match `METADATA_TOKEN` in `/etc/callsec/voice.env`.
`VOICE_SERVICE_TOKEN` must match the API deployment. Install that environment
file with root ownership and mode 0600; systemd supplies it to the voice
process. Never commit the filled JSON or environment file.

Run as root from the checkout:

```bash
bash deploy/asterisk/install-host.sh /root/callsec-asterisk.json
npm ci --omit=dev --workspaces=false
systemctl restart asterisk
systemctl start callsec-voice
```

The installer configures SIP over TLS to Novofon TCP 5061, with a local TCP
listener on 5071, and RTP on UDP 10000-10199. TLS verifies the provider's
certificate against Ubuntu's CA bundle and allows valid wildcard certificates.
Endpoint, registration and AoR outbound proxies explicitly choose TLS, so the
voice engine's existing `sip:number@sip.novofon.ru` destination also uses TLS.
PJSIP reuses an existing connection to the same destination. Keep
AudioSocket 9019, metadata 9020 and API 14000 bound to loopback. Both DIDs must
route to this SIP account in Novofon. Incoming requests can use
`did_79952225212` / `did_79952225213`, the bare DID, or a called-number SIP
header containing the configured DID. Calls to unknown numbers are rejected.
The DID 79952225212 is also used for registration/recovery confirmation and
can be rented normally. The API intercepts only incoming calls from callers
with a matching unexpired pending verification request. All other calls use
the DID owner's AI scenario.

For providers or networks that require it, explicit `sipTransport: "udp"`
defaults to remote/local UDP 5060, and `sipTransport: "tcp"` defaults to remote
TCP 5065 and local TCP 5071. Override `sipPort` and `sipBindPort` together when
necessary. Some cloud providers block traffic involving SIP port 5060; use
TLS rather than disabling certificate verification. Changing the transport
requires an Asterisk restart; a dialplan or PJSIP reload is insufficient.

The AGI helper sends structured JSON to the metadata service before answering.
If metadata is unavailable or it returns `HANGUP`, the dialplan ends the call.
It preserves outgoing UUID, profile and contact IDs, plus the actual Asterisk
channel needed for transfers and hangup. SIP credentials never enter shell
arguments or the dialplan.

The systemd unit runs the voice process as `andrew`. Its sudo rules allow only
the existing voice engine's specific Asterisk control and call-file operations.
Verify the installed policy with `visudo -c`; do not replace it with unrestricted
passwordless sudo.

## Checks

```bash
asterisk -rx 'module show like audiosocket'
asterisk -rx 'core show application AudioSocket'
asterisk -rx 'pjsip show registrations'
asterisk -rx 'dialplan show callsec-audio'
asterisk -rx 'dialplan show ai-outbound'
curl --fail http://127.0.0.1:9020/healthz
systemctl is-active asterisk callsec-voice
```

`pjsip show registrations` must report `Registered`. Do not enable verbose SIP
packet logging in shared diagnostics. New deployments update voice source with
the same Git checkout used to build web/API, then restart `callsec-voice` after
existing calls finish. A Git pull alone does not reload a running Node process.

Official references: [AudioSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/)
and [outbound registration](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Configuring-Outbound-Registrations/).
`max_retries=0` disables retry attempts; this configuration uses a high explicit
retry count and temporary handling of authentication rejection.
