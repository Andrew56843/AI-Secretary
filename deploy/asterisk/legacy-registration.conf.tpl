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
