[general]
static=yes
writeprotect=yes
clearglobalvars=no

[default]
exten => _.,1,Hangup()
exten => s,1,Hangup()

[from-novofon]
exten => _.,1,NoOp(Callsec incoming call)
 same => n,Set(AI_DID=${EXTEN})
 same => n,Set(AI_CALLER=${CALLERID(num)})
 same => n,Set(AI_DIRECTION=INBOUND)
 same => n,Goto(callsec-audio,s,1)
exten => s,1,Set(AI_CALLER=${CALLERID(num)})
 same => n,Set(AI_DIRECTION=INBOUND)
 same => n,Goto(callsec-audio,s,1)

; Call files in outbound-call.js supply AI_UUID, DID and profile identifiers.
[ai-outbound]
exten => s,1,NoOp(Callsec answered outgoing call)
 same => n,Goto(callsec-audio,s,1)

[callsec-audio]
exten => s,1,AGI(/var/lib/asterisk/agi-bin/callsec-metadata.agi.cjs)
 same => n,GotoIf($["${AI_METADATA_ACTION}" != "OK"]?denied)
 same => n,Answer()
 same => n,AudioSocket(${AI_UUID},127.0.0.1:9019)
 same => n,Hangup()
 same => n(denied),Hangup()

; Only the authenticated internal voice service can redirect into this context.
[from-ai-forward]
exten => _X.,1,NoOp(Callsec owner transfer)
 same => n,Set(CALLERID(num)=${AI_DID})
 same => n,Dial(PJSIP/novofon-endpoint/sip:${FILTER(0-9,${EXTEN})}@@@SIP_HOST@@,45)
 same => n,Hangup()
