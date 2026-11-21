[global]
type=global
user_agent=Callsec
endpoint_identifier_order=ip,username,anonymous

#include callsec-sip-lines.conf

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
media_encryption=@@MEDIA_ENCRYPTION@@
aors=novofon-aor
outbound_auth=novofon-auth
outbound_proxy=@@SIP_OUTBOUND_PROXY@@
from_domain=@@SIP_HOST@@
from_user=@@SIP_USERNAME@@
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

@@LEGACY_REGISTRATION@@
