# Private slot-2 SMS ingress

This change is explicitly requested by Merouane for the Algeria prototype. It
extends the existing Pi 3 receiver; it does not start a second GoIP UDP listener
or require each worker to join Telegram. Slot 2 is reserved for Khallasli. API configuration cannot disable the privacy
hook: without it slot 2 stays unarmed and private.

The hook runs before legacy parsing/debug/Redis/Telegram. It authenticates the
configured gateway IP and GoIP password before processing or acknowledging a
protected SMS. All slot-2 messages are excluded from the legacy sinks, including
unmatched messages and messages received while unarmed. Other authenticated slots
and heartbeats keep their existing handling. Raw UDP packet and rejected-packet
logging is removed. No Redis records, existing SMS history or Telegram messages
are read to obtain a bank code.

## Access and one active attempt

The HTTPS listener is published **only on the Pi 3 Tailscale IP**, port 9443.
Workers also require a scoped bearer capability. The server certificate must be
trusted/pinned; certificate verification must not be disabled. TLS private key
and control credential are mounted read-only from a mode-700 directory outside
Git. Nothing is placed in a URL, command argument, Docker environment or log.

The control credential is for the dispatcher/manual operator, **not each
worker**. Authenticated `GET /health` returns a fresh boot ID and bounded health
metadata, never SMS content, sender, reference or credentials. Startup is
unarmed. Explicit `POST /v1/control/clear` requires the current boot ID and an
external `clearance_id`; its caller is responsible for demonstrating that prior
bank challenges are closed. Restart/TTL never authorizes that decision.

`POST /v1/attempts` accepts `attempt_id`, `reservation_id`, `expected_sender`,
`expected_reference` (8–64 token characters, never a six-digit OTP), and
`ttl_seconds` (1–180). It returns one random reader token for that attempt.
Another attempt is refused while the first remains reserved, including after
expiration, ambiguity or consumption. A worker token cannot create/clear a
reservation or read health/all messages/another attempt.

`GET /v1/attempts/<id>/receipt` returns metadata only. Matching requires the
expected sender **and an external reference actually present in the SMS**.
Timestamp or technical GoIP ID alone never matches. Identical UDP retransmission
is idempotent; a second distinct matching packet makes the attempt ambiguous
and discards its content. Wrong-source/credential/malformed packets are dropped
before all legacy sinks. Protected SMS are ACKed after ingress handling, even
when no matching attempt exists, to prevent fallback/replay through Telegram.

`POST /v1/attempts/<id>/consume` is native/deterministic-component only and returns
one matching message once, outside the model. It zeroes the retained Buffer and
marks the attempt consumed. TTL also zeroes the Buffer, without freeing the
channel. JavaScript/OS memory cannot be claimed as cryptographically erased; no
content is persisted, and no raw response is logged or copied into test reports.
The service has no code-submission/payment/browser capability.

**Reception is not bank acceptance.** `bank_accepted` and `financial_success`
remain false. The bank sender, SMS format and matching reference must be
qualified against the real authorized payment flow before automatic banking
use. If a bank SMS provides no demonstrable transaction reference, this API
cannot automatically correlate it and the operation remains suspended. It does
not label arbitrary six-digit text as a valid OTP.

The reservation here is volatile, process-local and explicitly marked
`durable_channel_reservation=false`. Central durable reservation/fencing,
private machine identity and delivery/receipt integration remain Khallasli
KHA-22/31/34/35/36. Startup unarmed prevents a silent continuation after memory
loss; the central must reconcile and authorize any clearance. This is a bounded
prototype adapter, not a complete financial channel manager.

## Verification and local Pi deployment

`node --test app/test/private-sms-inbox.test.js` uses synthetic credentials,
HTTP loopback and an isolated UDP loopback socket. It verifies early routing,
wrong source/credentials, other-slot/heartbeat preservation, one attempt,
references/senders, cross-attempt access, duplicates/ambiguity, expiration,
consumption, restart lock and separation of control/reader capabilities. It
sends no SMS/USSD/call and does not contact a real gateway or Telegram.

Build `deploy/Dockerfile.private-sms` **without network** on the exact local
running image. The old image may contain the legacy `.env`; keep all images
local/private, never publish or export layers. Store an immutable image ID in
the private Compose environment. Merge `docker-compose.yml` with
`deploy/private-sms.compose.yml`, then recreate **only app**, with `--no-deps
--no-build`. Preserve Redis, Watchtower, their volumes, credentials and UDP
44444. Pi 4/Asterisk are unrelated and must not be restarted.

Back up changed source/config and keep the old local image before replacement.
Rollback recreates only app on its prior image/Compose configuration. Do not
rollback sensitive routing while an actual bank challenge may be active.
Verify HTTPS from Pi 4 with certificate validation, authenticated health,
anonymous rejection, and fresh authenticated slot-2 heartbeats. Report these
separately from synthetic UDP tests and from a real banking OTP, which has not
yet been requested or received by this integration.

Telegram command, send and launch errors now emit fixed metadata only and do
not terminate the UDP/private-inbox process. The existing app still uses its
one configured Telegram bot for other slots; workers never use that token or
join its conversations. Nine inbox tests pass locally and on the Pi 3.
