'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const { once } = require('node:events');
const { Inbox, packet, handler, fromEnvironment } = require('../components/core/private-sms-inbox');
const PASSWORD = 'SYNTHETIC_GATEWAY_PASSWORD', TOKEN = 'SYNTHETIC_CONTROL_TOKEN_NOT_A_REAL_CREDENTIAL';
function setup(t) {
    let time = Date.now();
    const inbox = new Inbox({ password: PASSWORD, gateway: '192.0.2.8', controlToken: TOKEN, now: () => time });
    t.after(() => inbox.close());
    const scope = { attempt_id: 'attempt-one', reservation_id: 'reservation-one', expected_sender: 'FIXTURE_BANK', expected_reference: 'REFERENCE_12345678', ttl_seconds: 30 };
    const clear = () => inbox.clear({ boot_id: inbox.bootId, clearance_id: 'fixture-clearance' });
    return { inbox, scope, clear, tick: (ms) => time += ms };
}
function sms({ slot = 2, id = '11111', sender = 'FIXTURE_BANK', reference = 'REFERENCE_12345678', code = '654321', password = PASSWORD } = {}) {
    return Buffer.from(`RECEIVE:${id};id:goip${slot};password:${password};srcnum:${sender};msg:Reference ${reference}. Synthetic code ${code}`);
}
const SOURCE = { address: '192.0.2.8', port: 44444 };

test('sensitive ingress never reaches the legacy sinks, even without an armed attempt', t => {
    const { inbox } = setup(t); let ack = 0;
    assert.equal(inbox.intercept(sms(), SOURCE, () => ack++), true);
    assert.equal(ack, 1);
    assert.equal(inbox.active, null);
    assert.equal(inbox.health().state, 'unarmed');
    assert.equal(inbox.intercept(sms({ slot: 1 }), SOURCE, () => {}), false);
    assert.equal(inbox.intercept(Buffer.from(`req:1;id:goip2;pass:${PASSWORD};gsm_status:LOGIN`), SOURCE, () => {}), false);
    assert.ok(inbox.health().last_slot2_heartbeat_at);
});

test('invalid source, credentials, ambiguous headers and oversized packets are dropped without ACK', t => {
    const { inbox } = setup(t); let ack = 0;
    for (const [buffer, source] of [[sms({ password: 'wrong' }), SOURCE], [sms(), { address: '192.0.2.99' }], [Buffer.alloc(8193), SOURCE], [Buffer.from(`RECEIVE:1;id:goip2;id:goip1;password:${PASSWORD};msg:test`), SOURCE], [Buffer.from(`RECEIVE:1;req:1;id:goip2;password:${PASSWORD};msg:test`), SOURCE]]) {
        assert.equal(inbox.intercept(buffer, source, () => ack++), true);
    }
    assert.equal(ack, 0);
});

test('one active attempt, exact external reference and sender; no latest-SMS attribution', t => {
    const { inbox, scope, clear } = setup(t);
    assert.equal(inbox.begin(scope)[0], 409);
    clear(); const [status, lease] = inbox.begin(scope); assert.equal(status, 201);
    assert.equal(inbox.begin({ ...scope, attempt_id: 'attempt-two' })[0], 409);
    for (const p of [sms({ reference: 'OLD_REFERENCE' }), sms({ sender: 'OTHER_SENDER' }), sms({ reference: 'XREFERENCE_12345678Y' })]) inbox.intercept(p, SOURCE, () => {});
    assert.equal(inbox.receipt(scope.attempt_id, lease.reader_token)[1].received, false);
    inbox.intercept(sms(), SOURCE, () => {});
    const receipt = inbox.receipt(scope.attempt_id, lease.reader_token)[1];
    assert.equal(receipt.received, true); assert.equal(receipt.bank_accepted, false);
    assert.equal(receipt.correlation, 'external_reference_and_sender');
    assert.ok(receipt.received_at); assert.equal(receipt.source, 'goip_udp');
    assert.equal(JSON.stringify(receipt).includes('654321'), false);
    assert.equal(inbox.receipt('attempt-two', lease.reader_token)[0], 403);
    assert.equal(inbox.receipt(scope.attempt_id, TOKEN)[0], 403);
});

test('duplicate UDP delivery is idempotent; conflicting second SMS locks the attempt', t => {
    const { inbox, scope, clear } = setup(t); clear();
    const lease = inbox.begin(scope)[1];
    inbox.intercept(sms(), SOURCE, () => {}); const first = inbox.receipt(scope.attempt_id, lease.reader_token)[1];
    inbox.intercept(sms(), SOURCE, () => {});
    assert.equal(inbox.receipt(scope.attempt_id, lease.reader_token)[1].event_id, first.event_id);
    assert.equal(inbox.counter.duplicates, 1);
    inbox.intercept(sms({ id: '2222', code: '123456' }), SOURCE, () => {});
    assert.equal(inbox.health().state, 'ambiguous_locked');
    assert.equal(inbox.receipt(scope.attempt_id, lease.reader_token, true)[0], 409);
    assert.equal(inbox.active.message, null);
});

test('native consumption is once-only, metadata has no code, TTL wipes without unlocking', t => {
    const { inbox, scope, clear, tick } = setup(t); clear(); const lease = inbox.begin(scope)[1];
    inbox.intercept(sms(), SOURCE, () => {});
    const bytes = inbox.active.message;
    const result = inbox.receipt(scope.attempt_id, lease.reader_token, true);
    assert.equal(result[0], 200); assert.ok(result[1].message.includes('654321'));
    assert.ok(bytes.every(b => b === 0)); assert.equal(inbox.active.message, null);
    assert.equal(inbox.receipt(scope.attempt_id, lease.reader_token, true)[0], 409);
    tick(31000); inbox.prune();
    assert.equal(inbox.health().state, 'expired_locked'); assert.equal(inbox.begin(scope)[0], 409);
    const restarted = setup(t).inbox;
    assert.equal(restarted.health().state, 'unarmed');
    assert.equal(restarted.clear({ boot_id: inbox.bootId, clearance_id: 'old-clearance' })[0], 409);
});

test('malformed attempts never reserve the inbox; short OTP cannot be used as a reference', t => {
    const { inbox, scope, clear } = setup(t); clear();
    for (const replacement of [{ expected_reference: '654321' }, { ttl_seconds: 181 }, { attempt_id: '../other' }, { expected_sender: '' }]) {
        assert.equal(inbox.begin({ ...scope, ...replacement })[0], 400);
        assert.equal(inbox.active, null);
    }
    assert.equal(packet(Buffer.from('invalid')), null);
});

test('HTTP control and reader capabilities are separate; no anonymous metadata or message', async t => {
    const { inbox, scope } = setup(t);
    const server = http.createServer(handler(inbox)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close());
    const root = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, token, body) => {
        const r = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return [r.status, r.headers, await r.json()];
    };
    assert.equal((await request('/health', 'wrong'))[0], 403);
    const h = await request('/health', TOKEN); assert.equal(h[0], 200); assert.equal(h[1].get('cache-control'), 'no-store');
    assert.equal((await request('/v1/control/clear', TOKEN, { boot_id: h[2].boot_id, clearance_id: 'fixture-clearance' }))[0], 200);
    const lease = await request('/v1/attempts', TOKEN, scope); assert.equal(lease[0], 201);
    assert.equal((await request('/v1/control/clear', lease[2].reader_token, {}))[0], 403);
    assert.equal((await request(`/v1/attempts/${scope.attempt_id}/receipt`, TOKEN))[0], 403);
    inbox.intercept(sms(), SOURCE, () => {});
    const receipt = await request(`/v1/attempts/${scope.attempt_id}/receipt`, lease[2].reader_token);
    assert.equal(receipt[2].received, true); assert.equal(receipt[2].message, undefined);
});

test('actual isolated UDP socket routes a fixture packet before any legacy consumer', async t => {
    const { inbox, scope, clear } = setup(t); clear(); const lease = inbox.begin(scope)[1];
    // The production source restriction remains enforced in normal tests.
    // This isolated loopback socket has synthetic credentials and no GoIP link.
    inbox.gateway = '127.0.0.1';
    let legacy = 0;
    const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4');
    receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
    t.after(() => { receiver.close(); sender.close(); });
    receiver.on('message', (data, info) => { if (!inbox.intercept(data, info, ack => receiver.send(ack, info.port, info.address))) legacy++; });
    const acknowledged = once(sender, 'message');
    sender.send(sms(), receiver.address().port, '127.0.0.1');
    const [ack] = await acknowledged;
    assert.equal(ack.toString(), 'RECEIVE 11111 OK'); assert.equal(legacy, 0);
    assert.equal(inbox.receipt(scope.attempt_id, lease.reader_token)[1].received, true);
});


test('missing API enablement keeps slot 2 private; heartbeat-shaped SMS cannot escape', t => {
    const inbox = fromEnvironment({ goip_password: PASSWORD, goip_host: '192.0.2.8' });
    t.after(() => inbox.close());
    assert.equal(inbox.intercept(sms(), SOURCE, () => {}), true);
    assert.equal(inbox.intercept(sms({ slot: 1 }), SOURCE, () => {}), false);
    for (const text of [`req:1;id:goip2;pass:${PASSWORD};msg:SYNTHETIC_SMS`, `RECEIVE:;req:1;id:goip2;pass:${PASSWORD};msg:SYNTHETIC_SMS`]) {
        assert.equal(inbox.intercept(Buffer.from(text), SOURCE, () => {}), true);
    }
    assert.equal(inbox.health().state, 'unarmed');
});

test('actual receiver hook survives Telegram failures and never logs a protected packet', async t => {
    const vm = require('node:vm'), fs = require('node:fs'), { EventEmitter } = require('node:events');
    const { inbox } = setup(t);
    const udp = new EventEmitter(); let acks = 0, exits = 0, instance;
    udp.bind = () => {}; udp.send = () => acks++;
    const output = [], intervals = [];
    class Bot {
        constructor() { instance = this; this.telegram = { sendMessage: () => Promise.reject(Error('SYNTHETIC_TELEGRAM_FAILURE')) }; }
        command() {} on() {} start() {} catch(fn) { this.failure = fn; }
        launch() { return Promise.reject(Error('SYNTHETIC_TELEGRAM_FAILURE')); }
    }
    const redis = { hkeys: async () => ['fixture-recipient'], hget: async () => null };
    const imports = {
        dgram: { createSocket: () => udp }, telegraf: { Telegraf: Bot }, sha1: () => '', axios: {},
        dotenv: { config: () => {} }, './components/db/redis': { getConnection: () => redis },
        './components/ui/locale': { getLocale: () => ({}) }, './components/core/functions': {},
        './components/core/private-sms-inbox': { fromEnvironment: () => inbox }
    };
    const context = vm.createContext({ require: name => { if (!(name in imports)) throw Error('unexpected import'); return imports[name]; },
        Buffer, process: { env: { goip_password: PASSWORD, bottoken: 'SYNTHETIC_BOT_TOKEN', admin_username: 'fixture', debug: '1' }, exit: () => exits++ },
        console: { log: (...v) => output.push(v.join(' ')) },
        setInterval: fn => { intervals.push(fn); return 1; }, clearInterval: () => {} });
    vm.runInContext(fs.readFileSync(require.resolve('../sms_server.js'), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    instance.failure(Error('SYNTHETIC_CONTEXT_SECRET'), { message: '654321' });
    udp.emit('message', sms(), SOURCE);
    await context.messageTransmit({ id: '1', srcnum: 'fixture', message: 'SYNTHETIC_OTHER_SLOT_MESSAGE' });
    intervals[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(exits, 0); assert.equal(acks, 1);
    assert.ok(output.includes('telegram_transport_unavailable'));
    assert.ok(output.includes('telegram_handler_failed'));
    assert.ok(output.includes('telegram_delivery_failed'));
    assert.equal(output.join(' ').includes('654321'), false);
    assert.equal(output.join(' ').includes(PASSWORD), false);
    assert.equal(output.join(' ').includes('SYNTHETIC_CONTEXT_SECRET'), false);
});
