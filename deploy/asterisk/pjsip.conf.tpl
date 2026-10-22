[global]
type=global
user_agent=Callsec
endpoint_identifier_order=ip,username,anonymous

[callsec-@@SIP_TRANSPORT@@]
type=transport
protocol=@@SIP_TRANSPORT@@
bind=0.0.0.0:@@SIP_BIND_PORT@@
external_signaling_address=@@PUBLIC_IP@@
external_media_address=@@PUBLIC_IP@@
local_net=127.0.0.0/8
@@TLS_OPTIONS@@

[novofon-auth]
type=auth
auth_type=userpass
username=@@SIP_USERNAME@@
password=@@SIP_PASSWORD@@

[novofon-aor]
type=aor
contact=@@SIP_SERVER_URI@@
outbound_proxy=@@SIP_OUTBOUND_PROXY@@
qualify_frequency=60

[novofon-endpoint]
type=endpoint
transport=callsec-@@SIP_TRANSPORT@@
context=from-novofon
disallow=all
allow=alaw,ulaw
aors=novofon-aor
outbound_auth=novofon-auth
outbound_proxy=@@SIP_OUTBOUND_PROXY@@
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
transport=callsec-@@SIP_TRANSPORT@@
outbound_auth=novofon-auth
outbound_proxy=@@SIP_OUTBOUND_PROXY@@
server_uri=@@SIP_SERVER_URI@@
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
