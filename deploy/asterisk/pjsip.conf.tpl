[global]
type=global
user_agent=Callsec
endpoint_identifier_order=ip,username,anonymous

[callsec-udp]
type=transport
protocol=udp
bind=0.0.0.0:@@SIP_BIND_PORT@@
external_signaling_address=@@PUBLIC_IP@@
external_media_address=@@PUBLIC_IP@@
local_net=127.0.0.0/8

[novofon-auth]
type=auth
auth_type=userpass
username=@@SIP_USERNAME@@
password=@@SIP_PASSWORD@@

[novofon-aor]
type=aor
contact=sip:@@SIP_HOST@@:@@SIP_PORT@@
qualify_frequency=60

[novofon-endpoint]
type=endpoint
transport=callsec-udp
context=from-novofon
disallow=all
allow=alaw,ulaw
aors=novofon-aor
outbound_auth=novofon-auth
from_domain=@@SIP_HOST@@
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc4733
send_pai=yes
send_rpid=yes
trust_id_inbound=yes
allow_subscribe=no
timers=yes
rtp_timeout=60
rtp_timeout_hold=300

[novofon-identify]
type=identify
endpoint=novofon-endpoint
match=@@SIP_HOST@@
srv_lookups=yes

[novofon-registration]
type=registration
transport=callsec-udp
outbound_auth=novofon-auth
server_uri=sip:@@SIP_HOST@@:@@SIP_PORT@@
client_uri=sip:@@SIP_USERNAME@@@@@SIP_HOST@@
contact_user=@@SIP_USERNAME@@
expiration=300
retry_interval=60
forbidden_retry_interval=300
fatal_retry_interval=300
auth_rejection_permanent=no
; Asterisk treats zero as no retries, not unlimited retries.
max_retries=1000000
line=yes
endpoint=novofon-endpoint
