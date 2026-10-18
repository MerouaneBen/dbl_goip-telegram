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


## Live native worker receipt — 18 October, 15:08 UTC

[Live receipt evidence](sms-connectivity-live-2026-10-18.json) supersedes the
missing-receipt result of the earlier window: the owner sends the new marker
`KHA_TEST_18B7D401` as an actual SMS. At **15:08:00.923 UTC**, the Pi 4 native Go
client reads `received=true`, `correlation=diagnostic_marker` through private
HTTPS from Pi 3, with no sender filter. Wrong-reader access is refused, the
ordinary transaction client rejects this diagnostic receipt, and the temporary
test reservation is explicitly closed. No body, banking OTP or payment is
read/submitted by this metadata client.

The owner confirms this same new marker visible in Telegram, as well as the
two preceding SMS. **Live fan-out passes: the same actual SMS reaches the native
worker receipt client and the personal Telegram recipient.** Zero fixed
delivery/transport errors are observed; the Telegram delivery evidence is the
owner confirmation, not a fabricated API acknowledgment. At 15:09:27 UTC the receiver is idle with three authenticated
slot-2 SMS packets, zero rejects/copy errors, valid HTTPS/authorization and a
fresh authenticated heartbeat. No service restart or code change was needed
for this live test. The previous absence of SMS in the initial window remains
a historical observation, not a current worker-receipt failure.


## VM dry-run OTP observation — 18 October 2026

The owner authorized a dedicated VM browser to request a bank SMS and stop
**without entering or submitting its code**. The opt-in `/v2/observations`
protocol is separate from the V1 transaction-reference API: it observes a
qualified candidate; it never claims bank transaction correlation or acceptance.

The authenticated ingress awaits an encrypted Redis journal write and
`WAITAOF 1 0 1500` before the existing personal path sends its one UDP ACK.
The journal uses AES-256-GCM with a separate root-owned 32-byte key, fresh nonce,
authenticated metadata and a 5–180 second TTL. Existing personal Redis/Telegram
copies remain intentional and independent. A private-copy failure marks health
failed and preserves personal forwarding. Redis must support WAITAOF (7.2+);
the tested Pi has Redis 8.10.2 with AOF enabled.

Enable only after provisioning `otp-journal.key` outside Git (root 0600), under
the existing private read-only configuration mount. Set
`KHALLASLI_OTP_OBSERVATION_ENABLED=1` and
`KHALLASLI_OTP_JOURNAL_KEY_FILE=/run/khallasli-sms/otp-journal.key`.
The Compose overlay records these paths without any key value.

Control capability creates one `POST /v2/observations` with `attempt_id`,
`reservation_id`, `provider`, `amount_dzd:100`, `ttl_seconds` and `dry_run:true`.
Other amounts, live mode and unknown providers are refused. This is a trial
constraint, not the product's client-selected amount contract. V1/V2 cannot
reserve simultaneously. `GET /v2/observations/<id>/event` is a bounded 5-second
long poll using a new reader capability, not the control token. It replays the
same event until the reader sends `POST .../ack` with `event_id`. ACK is
idempotent and removes message/code from the active record. Explicit control
`POST .../close` deletes the observation; TTL also removes it. Neither action
releases a central financial reservation, which is not implemented here.

The qualified French Poste template has exactly five digits. Parsing has no
sender-name dependency; arbitrary text, other slots and historical messages do
not become candidates. An identical authenticated UDP retransmission is stable;
a distinct second bank candidate makes the observation ambiguous and prevents
code delivery. A timestamp, technical GoIP ID or this template does not establish
bank transaction correlation. All financial/correlation flags remain false.

The native VM client arms before the normal Envoyer click, receives over pinned
TLS, validates the parser/body/code agreement and ACKs outside the LLM. Reports
contain only code presence, opaque event ID, timestamps and timing. No code is
logged, versioned, displayed to the model or submitted to the bank.

[Deployment and actual VM receipt](otp-observation-deployment-2026-10-18.json):
Mobilis 100 DZD dry run PASS, 50,109 ms including 1Password, worker 27,940 ms,
SMS request to acknowledged observation 4,446 ms, Pi3-receipt-to-client 158 ms
(between host clocks, not a latency SLO). The journal was explicitly closed
and no Chrome worker remained after the run. The actual Telegram delivery of
this particular SMS was not independently checked; the personal path is
preserved and covered by tests, with no receiver token given to workers.

Twenty-nine tests pass locally and against the deployed image, with the updated
test directory mounted read-only and networking disabled. They include actual
receiver ordering (persist before ACK) and personal-forwarding survival on
journal failure, encrypted replay, capability separation, ambiguity, ACK and
expiry. No test SMS/USSD/call or Telegram message is injected by these tests.
Central durable financial fencing, TLS renewal (current certificate expires
17 November), and production identity/authorization remain outside this adapter.
