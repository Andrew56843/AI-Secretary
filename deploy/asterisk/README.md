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
Novofon's TLS connection also requires SRTP with SDES keys inside the encrypted
SDP. The endpoint uses `media_encryption=sdes`, and `modules.conf` explicitly
loads `res_srtp.so`. No optimistic plaintext media fallback is enabled.
Endpoint, registration and AoR outbound proxies explicitly choose TLS, so the
voice engine's existing `sip:number@sip.novofon.ru` destination also uses TLS.
PJSIP reuses an existing connection to the same destination. Keep
AudioSocket 9019, metadata 9020 and API 14000 bound to loopback. Both DIDs must
route to this SIP account in Novofon. The endpoint's `from_user` is the SIP
login required by Novofon, not a rented DID. Call files keep the selected
account's DID in `CALLERID`; Asterisk sends it in P-Asserted-Identity and
Remote-Party-ID. Novofon's outgoing-number policy must also permit that DID;
these headers alone do not guarantee which number the provider presents.
Incoming requests can use
`did_79952225212` / `did_79952225213`, the bare DID, or a called-number SIP
header containing the configured DID. Calls to unknown numbers are rejected.
The DID 79952225212 is also used for registration/recovery confirmation and
can be rented normally. The API intercepts only incoming calls from callers
with a matching unexpired pending verification request. All other calls use
the DID owner's AI scenario.

For providers or networks that require it, explicit `sipTransport: "udp"`
defaults to remote/local UDP 5060, and `sipTransport: "tcp"` defaults to remote
TCP 5065 and local TCP 5071. Override `sipPort` and `sipBindPort` together when
necessary. These UDP/TCP configurations use `media_encryption=no`; SDES keys
must not be exposed over unencrypted SIP. Some cloud providers block traffic
involving SIP port 5060; use
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

## Dedicated Outbound Lines

Each enabled rented DID must use a separate Novofon SIP identity with that DID
configured as its fixed outgoing number in Novofon. The application never falls
back to the shared legacy endpoint. Generated endpoint names are bound to their
DID, for example `callsec-sip-79952225213`. Authentication passwords are exported
only through the private configuration endpoint; ordinary voice profiles contain
the safe endpoint and revision, not credentials.

Provision the encrypted database records first, then create root-only
`/etc/callsec/sip-sync.env` with `SIP_CONFIG_API_URL` set to
`http://127.0.0.1:14000/internal/voice/sip-lines/config` and a separate
`SIP_CONFIG_TOKEN` matching the API. Do not put this token in `voice.env`.
Production voice uses its systemd environment, not repository dotenv files.

```bash
bash deploy/asterisk/install-sip-sync.sh
systemctl start callsec-sip-sync.service
systemctl start callsec-sip-sync.timer
journalctl -u callsec-sip-sync.service --no-pager -n 20
```

The installer copies root-executed modules outside the writable checkout to
`/usr/local/lib/callsec`. The root timer writes protected generated files under
`/etc/asterisk` and reloads PJSIP only when channels and outgoing/staging queues
are empty. A kernel lock serializes service and manual helper runs. It does not
restart Asterisk. New route revisions become usable only after registration;
disabled or rotated routes are revoked while a reload is deferred. A sync
failure cannot activate a new route, and validation errors retain existing
configuration. The generated configuration is readable by the trusted local
`asterisk` group; it is not a separate host-user secret boundary.

Reusing the legacy SIP identity requires an explicit controlled transition.
The timer refuses to load it while `novofon-registration` still uses it in the
base configuration or remains active in Asterisk. During a quiescent deployment,
back up the configuration, explicitly unregister that legacy registration and
verify `Unregistered`, then retire only its registration block. Keep the legacy
endpoint/auth/identify definitions for inbound compatibility. Set
`legacyRegistrationEnabled: false` in the private restoration JSON so a future
render does not recreate the duplicate registration. This flag defaults to
`true` for existing restores; neither the timer nor installer migrates it.

When incoming DIDs move to dedicated registrations, their Novofon incoming
routes must point to the matching SIP identity. AGI verifies the registered
endpoint's DID and rejects conflicting destination headers. Test incoming,
outgoing and transferred calls for each DID after the controlled transition.

## Checks

```bash
asterisk -rx 'module show like audiosocket'
asterisk -rx 'module show like res_srtp'
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
Novofon's [TLS/SRTP setup](https://novofon.com/instructions/calls/freepbx1415-voip/)
requires SRTP via in-SDP keys, configured by Asterisk's
[`media_encryption=sdes`](https://docs.asterisk.org/Asterisk_20_Documentation/API_Documentation/Module_Configuration/res_pjsip/#media_encryption).
`max_retries=0` disables retry attempts; this configuration uses a high explicit
retry count and temporary handling of authentication rejection.
