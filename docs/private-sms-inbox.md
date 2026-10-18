# Private slot-2 SMS ingress

This change is explicitly requested by Merouane for the Algeria prototype. It
extends the existing Pi 3 receiver; it does not start a second GoIP UDP listener
or require each worker to join Telegram.

**Owner correction, 18 October 2026:** slot 2 is a personal SIM shared with
Khallasli. All authenticated SMS, including banking OTPs, continue to the
existing personal Redis/Telegram path and configured recipients. The worker
receives an additional attempt-scoped copy through the private HTTPS API. It
never reads Telegram or Redis. The earlier exclusive slot-2 routing is
superseded; the owner explicitly requests personal visibility of these OTPs.

The hook authenticates gateway IP and GoIP password, then copies only messages
matching the active attempt. The original path forwards personal alerts,
unmatched messages, and messages received while unarmed, expired, consumed or
ambiguous. Only that path sends the single UDP ACK. A worker-copy error locks
the attempt but does not suppress personal forwarding. A Telegram failure does
not discard the worker copy. Disabling the worker API leaves personal forwarding
active. There is still one UDP socket and one Telegram bot.

Raw UDP/debug logging stays removed. SMS bodies are opaque (including newlines
and header-like text); their text cannot change the recipient slot. New Redis
records omit the GoIP authentication password, but retain personal SMS content
under the existing retention setting. Historical records are not modified.

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

For a nonbanking plumbing test only, `purpose: "connectivity_test"` omits
`expected_sender` and requires `expected_reference` matching
`KHA_TEST_[A-Z0-9_]{8,48}`. It accepts only an SMS whose entire trimmed body equals
that marker, regardless of sender. Random texts/OTP messages are not captured.
The receipt is explicitly `correlation: "diagnostic_marker"`, never bank
correlation or acceptance. Normal transaction scopes still require sender and
external reference; unknown purposes are rejected. Both use the same bounded
reservation, source authentication, TTL, one-time read and personal forwarding.

`GET /v1/attempts/<id>/receipt` returns metadata only. Matching requires the
expected sender **and an external reference actually present in the SMS**.
Timestamp or technical GoIP ID alone never matches. Identical UDP retransmission
is idempotent; a second distinct matching packet makes the attempt ambiguous
and discards its content. Wrong-source/credential/malformed packets are dropped
before all legacy sinks. Accepted SMS continue to the personal path for its ACK
and forwarding, regardless of whether a worker attempt matches.

`POST /v1/attempts/<id>/consume` is native/deterministic-component only and returns
one matching message once, outside the model. It zeroes the retained Buffer and
marks the attempt consumed. TTL also zeroes the Buffer, without freeing the
channel. JavaScript/OS memory cannot be claimed as cryptographically erased; no
content is persisted by the private inbox, and no raw API response is logged or
copied into test reports. The personal Telegram/Redis copy is intentional and
independent: consuming or expiring the inbox does not delete that copy.
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
consumption, restart lock and separation of control/reader capabilities. The
actual receiver is also tested with mocked Telegram/Redis: personal delivery in
all attempt states, one ACK per packet, opaque bodies, copy failure and
Telegram/recipient failure isolation. It
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
one configured Telegram bot for all personal slots, including slot 2; workers never use that token or
join its conversations. Eighteen inbox/receiver tests pass locally and on the exact deployed Pi 3
image; the initial fan-out delivery below records fourteen tests at that time. The [fan-out correction evidence](personal-slot2-fanout-2026-10-18.json)
records those results and the remote verification.
The inherited personal Telegram path remains best effort: its ACK precedes
durable delivery, its legacy Redis deduplication is not a delivery guarantee,
and it has no durable Telegram retry/outbox. This change restores forwarding;
it does not claim recovery of SMS suppressed by the previous exclusive route.


## Historical exclusive-routing delivery — 18 October 2026

This paragraph records the initial deployment, before the personal fan-out
correction. It is not evidence that the corrected forwarding was tested.

[Sanitized deployment evidence](private-sms-deployment-2026-10-18.json) records
code revision `3fa42c6`, immutable local image, code hashes, ten tests on Pi 3,
TLS and authorization checks from Pi 4, a fresh authenticated GoIP heartbeat,
and the real native worker receipt client with a temporary nonfinancial
attempt. A wrong reader token was rejected and that test reservation was
explicitly closed. No bank SMS or payment was triggered. Only app was
recreated; Redis and Watchtower retain their 17 October start times, Redis
returns PONG, and Pi 4 Asterisk remains stopped. Two pre-existing untracked
backup files in the remote checkout are preserved.

The listener uses a private pinned certificate expiring 17 November 2026.
Automatic certificate rotation and central machine provisioning are not
delivered. The Pi 3 kernel reported that Docker memory limits are unavailable;
no boot modification/reboot was made. The existing local image/credentials
remain private and are not exported or published.

## Personal fan-out correction delivered — 18 October 2026

Code `1f7bbc7`, local image
`sha256:b2dfe179f3d04059dac29213f730c4e20f45402d22380a91c9680367afb42895`,
app replaced at 14:06:52 UTC. Fourteen tests pass on that image, including the
actual receiver with mocked personal Telegram forwarding and private receipt of
the same synthetic SMS. Source hashes match between checkout and container.
From Pi 4: validated TLS, authorized 200 and unauthorized 403, authenticated
heartbeat age 8.42 s. The native client again reads an empty qualification
attempt and rejects a wrong reader; that reservation was explicitly closed.

The existing slot-2 recipient count is one and Telegram `getMe` authenticates;
these read-only checks are not a delivery test. No real SMS arrived during the
post-deployment observation, so live Telegram delivery remains **NOT RUN**.
Before replacement, the old exclusive route had counted one authenticated
slot-2 SMS packet and suppressed its personal forwarding. Its content was not
read/exported; this correction does not retroactively recover it. Redis,
Watchtower, GoIP configuration, credentials and Pi 4/Asterisk are preserved.


## Sender-independent plumbing test and Telegram recovery

[Qualification record](sms-connectivity-qualification-2026-10-18.json): the
owner confirms personal Telegram restoration and sends random texts, observed
as 20 authenticated slot-2 packets (not necessarily 20 distinct SMS). Those
texts do not match a reserved worker attempt. A subsequent nonbanking test
uses the exact marker `KHA_TEST_7C4A91D2`, without any sender filter. The native
Go client on Pi 4 polls through private HTTPS using the explicit connectivity
mode. That window ends with `received=false` and is explicitly closed: no new
authenticated slot-2 SMS was observed after that app replacement. The owner
also reports the marker absent from Telegram. **Live marker fan-out is not
validated**, despite synthetic tests and the earlier personal delivery.

The initial Telegram launch had failed. Code `f7a230a`, image
`sha256:679641ecd729fefc63c9dddab58c1356570cab3fe037da7aae99703f4af3672a`,
delivered at 14:27:52 UTC, retries transient launch errors with 5–60 s backoff,
honors a supplied rate-limit delay and stops automatic retries on 401/403.
Only numeric/allowlisted failure metadata is logged, never token, URL,
description or stack. Eighteen tests pass locally and on this exact image.
GetMe success or absence of errors is not asserted as live Telegram delivery
or polling health. The original personal SMS forwarding still has no durable
retry/outbox; startup reconnection does not recover a prior undelivered SMS.
Redis/Watchtower, Asterisk, GoIP configuration and private credentials remain
preserved. No outbound SMS/USSD/call or payment is used as a probe.
