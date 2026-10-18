'use strict';

// One authenticated ingress, with an attempt-scoped copy before personal
// Redis/Telegram forwarding. V1 is volatile; opt-in V2 uses an encrypted TTL journal.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');

function equal(a, b) {
    const x = Buffer.from(a || ''), y = Buffer.from(b || '');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function packet(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 8192) return null;
    const text = buffer.toString('utf8');
    const boundary = text.indexOf(';msg:');
    const headers = boundary < 0 ? text : text.slice(0, boundary);
    const fields = Object.create(null);
    for (const item of headers.split(';')) {
        if (!item) continue;
        const split = item.indexOf(':');
        if (split < 1) return null;
        const name = item.slice(0, split), value = item.slice(split + 1);
        if (Object.hasOwn(fields, name)) return null;
        fields[name] = value;
    }
    if (!/^(?:goip)?[1-4]$/.test(fields.id || '')) return null;
    if (fields.password && fields.pass) return null;
    if (Object.hasOwn(fields, 'RECEIVE') && Object.hasOwn(fields, 'req')) return null;
    if (Object.hasOwn(fields, 'req') && boundary >= 0) return null;
    return { slot: Number(fields.id.replace(/^goip/, '')), password: fields.password || fields.pass,
        receiveId: fields.RECEIVE, heartbeat: Object.hasOwn(fields, 'req'),
        sender: fields.srcnum, content: boundary < 0 ? null : text.slice(boundary + 5) };
}

class Inbox {
    constructor({ password, gateway, controlToken, now = () => Date.now() }) {
        if (!password || !gateway || !controlToken || controlToken.length < 32) throw Error('sms_configuration_missing');
        this.password = password;
        this.gateway = gateway;
        this.controlToken = controlToken;
        this.now = now;
        this.bootId = crypto.randomUUID();
        this.armed = false;
        this.active = null;
        this.lastHeartbeat = null;
        this.counter = { protected_sms: 0, rejected_packets: 0, duplicates: 0, inbox_errors: 0 };
        this.expiry = setInterval(() => this.prune(), 1000);
        this.expiry.unref();
    }
    close() { clearInterval(this.expiry); this.discard(); }
    discard() {
        if (this.active?.message) this.active.message.fill(0);
        if (this.active) this.active.message = null;
    }
    prune() {
        if (this.active && this.now() >= this.active.expires) {
            this.discard();
            this.active.expired = true;
            // Expiry removes sensitive bytes, never frees the channel.
        }
    }
    // true rejects the packet; false continues the original personal path.
    // Only that path ACKs accepted SMS, so there is no second UDP consumer/ACK.
    intercept(buffer, info) {
        const p = packet(buffer);
        if (!p || info.address.replace(/^::ffff:/, '') !== this.gateway || !equal(p.password, this.password)) {
            this.counter.rejected_packets++;
            return true;
        }
        if (p.heartbeat) {
            if (p.slot === 2) this.lastHeartbeat = new Date(this.now()).toISOString();
            return false;
        }
        if (p.slot !== 2) return false;
        if (!p.receiveId || !/^[A-Za-z0-9_-]{1,64}$/.test(p.receiveId) || p.content === null) return true;
        this.counter.protected_sms++;
        try { this.capture(buffer, p); }
        catch {
            // A worker-copy failure must not suppress personal Telegram SMS.
            // Fail closed for the attempt, without logging message/exception.
            this.counter.inbox_errors++;
            this.discard();
            if (this.active) this.active.ambiguous = true;
        }
        return false;
    }
    async ingress(buffer, info) {
        const rejected = this.intercept(buffer, info);
        if (!rejected && this.observations) {
            try { await this.observations.ingest(packet(buffer)); }
            catch { this.observations.failed = true; this.counter.inbox_errors++; }
        }
        // Observation failure never suppresses the independent personal path.
        return rejected;
    }
    capture(buffer, p) {
        this.prune();
        const a = this.active;
        if (a && !a.expired && !a.consumed) {
            // Transaction scopes require sender AND external reference.
            // Connectivity tests accept only the exact nonbanking marker.
            const escaped = a.reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const matches = a.connectivityTest ? p.content.trim() === a.reference :
                p.sender === a.sender && new RegExp('(^|[^A-Za-z0-9_-])' + escaped + '($|[^A-Za-z0-9_-])').test(p.content);
            if (matches) {
                const digest = crypto.createHmac('sha256', a.digestKey).update(buffer).digest('hex');
                if (a.digest === digest) this.counter.duplicates++;
                else if (a.receivedAt) { a.ambiguous = true; this.discard(); }
                else {
                    a.digest = digest;
                    a.message = Buffer.from(p.content, 'utf8');
                    a.receivedAt = new Date(this.now()).toISOString();
                    a.eventId = crypto.randomUUID();
                }
            }
        }
    }
    health() {
        this.prune();
        const a = this.active;
        return { service: 'khallasli-private-sms', boot_id: this.bootId, protected_slot: 2,
            state: !this.armed ? 'unarmed' : !a ? 'idle' : a.expired ? 'expired_locked' : a.ambiguous ? 'ambiguous_locked' : a.consumed ? 'consumed_locked' : a.receivedAt ? 'received' : 'waiting',
            last_slot2_heartbeat_at: this.lastHeartbeat, counters: { ...this.counter },
            durable_channel_reservation: false, financial_success: false, otp_observation_enabled: !!this.observations, otp_observation_failed: !!this.observations?.failed };
    }
    clear(body) {
        // Control-plane clearance is an explicit external decision. The
        // current manual qualifier must never claim this is central fencing.
        if (body.boot_id !== this.bootId || !/^[A-Za-z0-9_-]{8,100}$/.test(body.clearance_id || '')) return [409, { error: 'clearance_required' }];
        this.discard();
        this.active = null;
        this.armed = true;
        return [200, { state: 'idle', durable_channel_reservation: false }];
    }
    begin(body) {
        this.prune();
        if (!this.armed || this.active) return [409, { error: 'channel_locked' }];
        const connectivityTest = body.purpose === 'connectivity_test';
        if (body.purpose !== undefined && !['transaction', 'connectivity_test'].includes(body.purpose)) return [400, { error: 'invalid_attempt_scope' }];
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(body.attempt_id || '') ||
            !/^[A-Za-z0-9_-]{8,100}$/.test(body.reservation_id || '') ||
            !/^[A-Za-z0-9_-]{8,64}$/.test(body.expected_reference || '') ||
            (connectivityTest ? !/^KHA_TEST_[A-Z0-9_]{8,48}$/.test(body.expected_reference) || body.expected_sender !== undefined :
                !/^[A-Za-z0-9+ _-]{2,40}$/.test(body.expected_sender || '')) ||
            !Number.isInteger(body.ttl_seconds) || body.ttl_seconds < 1 || body.ttl_seconds > 180) return [400, { error: 'invalid_attempt_scope' }];
        const token = crypto.randomBytes(32).toString('base64url');
        this.active = { id: body.attempt_id, reservation: body.reservation_id,
            reference: body.expected_reference, sender: body.expected_sender,
            connectivityTest,
            token, expires: this.now() + body.ttl_seconds * 1000,
            digestKey: crypto.randomBytes(32), message: null };
        return [201, { attempt_id: body.attempt_id, reader_token: token,
            expires_at: new Date(this.active.expires).toISOString(), durable_channel_reservation: false }];
    }
    receipt(id, token, consume = false) {
        this.prune();
        const a = this.active;
        if (!a || id !== a.id || !equal(token, a.token)) return [403, { error: 'attempt_forbidden' }];
        const result = { attempt_id: a.id, slot: 2, source: 'goip_udp',
            received: !!a.receivedAt && !a.ambiguous && !a.expired && !a.consumed,
            correlation: a.receivedAt ? (a.connectivityTest ? 'diagnostic_marker' : 'external_reference_and_sender') : 'not_established',
            ambiguous: !!a.ambiguous, expired: !!a.expired, consumed: !!a.consumed,
            bank_accepted: false, financial_success: false };
        if (result.received) { result.event_id = a.eventId; result.received_at = a.receivedAt; }
        if (consume) {
            if (!result.received || !a.message) return [409, { error: 'message_unavailable', ...result }];
            // Native deterministic component only, outside model/log context.
            // This is the SMS, not a declaration of a valid OTP/payment.
            result.message = a.message.toString('utf8');
            this.discard();
            a.consumed = true;
        }
        return [200, result];
    }
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'connection': 'close' });
    res.end(JSON.stringify(body));
}
function handler(inbox) {
    return async (req, res) => {
        try {
            const token = (req.headers.authorization || '').replace(/^Bearer /, '');
            if (req.url === '/health' && req.method === 'GET' && equal(token, inbox.controlToken)) return json(res, 200, inbox.health());
            if (inbox.observations && (req.url || '').startsWith('/v2/observations')) {
                const observed = /^\/v2\/observations(?:\/([A-Za-z0-9_-]{8,100})\/(event|ack|close))?$/.exec(req.url);
                if (!observed) return json(res, 404, { error: 'route_not_found' });
                if (observed[2] === 'event' && req.method === 'GET') {
                    const cancel = new AbortController(); res.on('close', () => cancel.abort());
                    try {
                        const [status, body] = await inbox.observations.event(observed[1], token, 5000, cancel.signal);
                        if (!res.destroyed) json(res, status, body);
                    } catch { if (!res.destroyed) json(res, 503, { error: 'observation_unavailable' }); }
                    return;
                }
                const isAck = observed[2] === 'ack';
                if ((!isAck && !equal(token, inbox.controlToken)) || req.method !== 'POST') return json(res, 403, { error: 'forbidden' });
                let data = [], size = 0;
                for await (const chunk of req) { size += chunk.length; if (size > 2048) return json(res, 413, { error: 'body_too_large' }); data.push(chunk); }
                const body = JSON.parse(Buffer.concat(data).toString('utf8'));
                if (!body || Array.isArray(body) || typeof body !== 'object') return json(res, 400, { error: 'invalid_json' });
                if (!observed[1] && (inbox.active || inbox.observationBeginning)) return json(res, 409, { error: 'legacy_attempt_locked' });
                let result;
                try {
                    if (!observed[1]) inbox.observationBeginning = true;
                    result = isAck ? await inbox.observations.ack(observed[1], token, body.event_id) :
                        observed[2] === 'close' ? await inbox.observations.close(observed[1]) : await inbox.observations.begin(body);
                } catch { return json(res, 503, { error: 'observation_unavailable' }); }
                finally { if (!observed[1]) inbox.observationBeginning = false; }
                return json(res, result[0], result[1]);
            }
            const match = /^\/v1\/attempts\/([A-Za-z0-9_-]{8,100})\/(receipt|consume)$/.exec(req.url || '');
            if (match && ((match[2] === 'receipt' && req.method === 'GET') || (match[2] === 'consume' && req.method === 'POST'))) {
                const [status, body] = inbox.receipt(match[1], token, match[2] === 'consume');
                return json(res, status, body);
            }
            if (!equal(token, inbox.controlToken)) return json(res, 403, { error: 'forbidden' });
            if (req.method !== 'POST' || !['/v1/control/clear', '/v1/attempts'].includes(req.url)) return json(res, 404, { error: 'route_not_found' });
            let chunks = [], size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 2048) return json(res, 413, { error: 'body_too_large' });
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || Array.isArray(body) || typeof body !== 'object') return json(res, 400, { error: 'invalid_json' });
            if (req.url === '/v1/attempts' && inbox.observations && (inbox.observationBeginning || await inbox.observations.locked() || inbox.observationBeginning)) return json(res, 409, { error: 'observation_locked' });
            const [status, result] = req.url === '/v1/control/clear' ? inbox.clear(body) : inbox.begin(body);
            return json(res, status, result);
        } catch { if (!res.headersSent) json(res, 400, { error: 'invalid_request' }); }
    };
}

function fromEnvironment(env) {
    const enabled = env.KHALLASLI_SMS_ENABLED === '1';
    const inbox = new Inbox({ password: env.goip_password, gateway: env.goip_host,
        controlToken: enabled ? fs.readFileSync(env.KHALLASLI_SMS_TOKEN_FILE, 'utf8').trim() : crypto.randomBytes(32).toString('hex') });
    // Personal forwarding is independent of the worker API. Without an API
    // listener the inbox remains unarmed, while valid SMS still reach Telegram.
    if (!enabled) return inbox;
    if (env.KHALLASLI_OTP_OBSERVATION_ENABLED === '1') {
        const { ObservationJournal } = require('./otp-observation');
        const redis = require('../db/redis').getConnection();
        inbox.observations = new ObservationJournal({ redis, key: fs.readFileSync(env.KHALLASLI_OTP_JOURNAL_KEY_FILE) });
    }
    const server = https.createServer({ minVersion: 'TLSv1.2',
        key: fs.readFileSync(env.KHALLASLI_SMS_TLS_KEY_FILE),
        cert: fs.readFileSync(env.KHALLASLI_SMS_TLS_CERT_FILE) }, handler(inbox));
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxConnections = 16;
    server.on('error', () => { console.error('private_sms_listener_failed'); process.exit(1); });
    server.listen(8443, '0.0.0.0');
    return inbox;
}

module.exports = { Inbox, packet, handler, fromEnvironment };
