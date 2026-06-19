const udp = require('dgram');
const { Telegraf } = require('telegraf');
const sha1 = require('sha1');
const axios = require('axios');
require('dotenv').config();
const bot = new Telegraf(process.env.bottoken);
// db connections /////////////////////////////
const redis = require('./components/db/redis').getConnection();
// db connections end /////////////////////////
// another modules ////////////////////////////
const locale = require('./components/ui/locale').getLocale(process.env.locale ?? 'en');
const functions = require('./components/core/functions');
// another modules end ////////////////////////

async function messageTransmit(msgdata) {
    let users = await redis.hkeys('sim'+msgdata.id, (val) => { return val; });
    let channelinfo = await redis.hget('simconfigs', 'sim'+msgdata.id, (val) => { return val; });
    if(channelinfo) {
        channelinfo = JSON.parse(channelinfo);
    } else {
        channelinfo = {name: locale.unnamed, phonenum: locale.notassigned};
    }
    let index = 0;
    let max = users.length;
    let interval = setInterval(() => {
        if(index < max) {
            bot.telegram.sendMessage(users[index],
                `${locale.slot}: ${msgdata.id}\n` +
                `${locale.channel}: ${channelinfo.name}\n` +
                `${locale.simnumber}: ${channelinfo.phonenum}\n` +
                `${locale.fromnumber}: ${msgdata.srcnum}\n\n${msgdata.message}`
            );
        } else {
            clearInterval(interval);
        }
        index++;
    }, 500);
}

// sms udp server /////////////////////////////
const server = udp.createSocket('udp4');

server.on('error', function (error) {
    if(process.env.debug) {
        console.log('Error: ' + error);
    }
});

server.on('message', async function (msg, info) {
    if(process.env.debug) {
        console.log(msg?.toString());
    }
    let data = msg?.toString()?.split(';');
    let itemscount = data?.length;
    let msginfo = {};
    let message = msg?.toString()?.match(/msg:.*/g);

    if(message?.length > 0) {
        msginfo.message = message[0].replace('msg:', '');
    }

    for (let m = 0; m < itemscount; m++) {
        let item = data[m].split(':');
        switch (item[0]) {
            case 'id': 
                msginfo.id = item[1].replace('goip', '');
            break;
            case 'RECEIVE':
                msginfo.type = 'sms';
                msginfo.RECEIVE = item[1];
                var ack = new Buffer.from('RECEIVE ' + msginfo.RECEIVE + ' OK');
                server.send(ack, 0, ack.length, info.port, info.address, function(err, bytes) {});
                msginfo.receivets = item[1];
            break;
            case 'srcnum':
                msginfo.srcnum = item[1];
            break;
            case 'password':
                msginfo.password = item[1];
            break;
            case 'pass':
                msginfo.password = item[1];
            break;
            case 'req':
                msginfo.type = 'req';
            break;
            case 'signal':
                msginfo.signal = item[1];
            break;
            case 'gsm_status':
                msginfo.gsm_status = item[1];
            break;
            case 'imei':
                msginfo.imei = item[1];
            break;
            case 'imsi':
                msginfo.imsi = item[1];
            break;
            case 'iccid':
                msginfo.iccid = item[1];
            break;
            case 'pro':
                msginfo.provider = item[1];
            break;
        }
    }

    let request_result = JSON.stringify(msginfo);

    if(process.env.goip_password === msginfo.password) {
        if(msginfo.type === 'req') {
            redis.set(`channel_status${msginfo.id}`, request_result);
        } else {
            let hash = sha1(request_result);
            
            if(!await redis.exists(hash) && msginfo?.message) {
                messageTransmit(msginfo);
            }

            if(process.env.persist_msg) {
                await redis.set(`message_${hash}`, request_result);
            } else {
                await redis.setex(`message_${hash}`, 86400, request_result);
            }
        }
    } else {
        if(process.env.debug) {
            console.log('unauth message', msginfo);
        }
    }
});

server.on('listening', function () {
    let address = server.address();
    let port = address.port;
    let family = address.family;
    let ipaddr = address.address;
    if(process.env.debug) {
        console.log(ipaddr, port, family);
    }
});

server.on('close', function () {
    console.log('Socket is closed !');
    process.exit(1);
});

server.bind(process.env.goip_port ?? 44444);
// sms server end /////////////////////////////

bot.command('myid', (ctx) => {
    ctx.reply(ctx.update.message.from.id);
})

bot.command('allowsms', async (ctx) => {
    if(!functions.rootAuth(ctx.update.message.from?.username)) { console.log(ctx.update.message.text); return; }
    let args = ctx.update.message.text.split(' ');

    if(!args[1] || !args[2]) {
        ctx.reply(locale.novalue);
        return;
    }

    let info = await bot.telegram.getChat(args[1]).catch((err) => { return false; });
    if(!info) {
        ctx.reply(locale.usernotfound);
        return;
    }

    if(Number.isNaN(Number(args[2]))) {
        ctx.reply(locale.incorrectchannelvalue);
        return;
    }

    await redis.hset(`allowsms_${args[1]}`, args[2], 1);
    ctx.reply(`${locale.allowedsms} ${args[1]}`);
});

bot.command('disallowsms', async (ctx) => {
    if(!functions.rootAuth(ctx.update.message.from?.username)) { console.log(ctx.update.message.text); return; }
    let args = ctx.update.message.text.split(' ');

    if(!args[1] || !args[2]) {
        ctx.reply(locale.novalue);
        return;
    }

    let info = await bot.telegram.getChat(args[1]).catch((err) => { return false; });
    if(!info) {
        ctx.reply(locale.usernotfound);
        return;
    }

    if(Number.isNaN(Number(args[2]))) {
        ctx.reply(locale.incorrectchannelvalue);
        return;
    }

    await redis.hdel(`allowsms_${args[1]}`, args[2]);
    ctx.reply(`${locale.disallowedsms} ${args[1]}`);
});



bot.command('wsms', async (ctx) => {
    let args = ctx.update.message.text.split(' ');
    if(!args[1]) {
        ctx.reply(locale.novalue);
        return;
    }

    let allow = await redis.hexists(`allowsms_${ctx.update.message.from.id}`, args[1]);
    if(Number.isNaN(Number(args[1]))) {
        ctx.reply(locale.incorrectchannelvalue);
        return;
    }

    if(!allow) {
        ctx.reply(locale.nochannelpermission)
        return;
    }

    await redis.hset(`session_${ctx.update.message.from.id}`, 'channel', Number(args[1]));
    await redis.hset('actions', ctx.update.message.from.id, 'sendnumbers');

    ctx.reply(locale.sendphonenums);
})

bot.command('addadmin', async (ctx) => {
    if(!functions.rootAuth(ctx.update.message.from?.username)) { console.log(ctx.update.message.text); return; }

    let args = ctx.update.message.text.split(' ');
    if(!args[1]) { ctx.reply(locale.novalue); return; }

    let info = await bot.telegram.getChat(args[1]).catch((err) => { return false; });
    if(info) {
        redis.hset('admins', args[1], 1);
        ctx.reply(`${locale.administrator}: ${(info.username ?? info.id)} ${info.id} ${locale.added}`);
    } else {
        ctx.reply(locale.usernotfound);
    }
});

bot.command('deladmin', async (ctx) => {
    if(!functions.rootAuth(ctx.update.message.from?.username)) { return; }

    let args = ctx.update.message.text.split(' ');
    if(!args[1]) { ctx.reply(locale.novalue); return; }

    let info = await bot.telegram.getChat(args[1]).catch((err) => { return false; });
    if(info) {
        redis.hdel('admins', args[1]);
        ctx.reply(`${locale.administrator}: ${(info.username ?? info.id)} (${info.id}) ${locale.removed}`);
    } else {
        ctx.reply(locale.usernotfound);
    }
});

bot.command('simconfig', async (ctx) => {
    let args = ctx.update.message.text.split(' ');
    if(!await functions.auth(redis, ctx.update.message.from.id)) { ctx.reply(locale.restricted); return; }

    if(!args[1] || !args[2] || !args[3]) { ctx.reply(locale.novalue); return; }

    if(!functions.checkValue(args[1])) {
        ctx.reply(locale.slotmustbeinteger);
        return;
    }
    let siminfo;
    if(await redis.hexists('simconfigs', `sim${args[1]}`, (val) => { return val; })) {
        siminfo = JSON.parse(await redis.hget('simconfigs', `sim${args[1]}`, (val) => { return val; }));
    } else {
        siminfo = { name: locale.unnamed, phonenum: locale.notassigned };
    }

    if(args[2] === 'phonenum' || args[2] === 'name') {
        siminfo[args[2]] = args[3];
        redis.hset('simconfigs', `sim${args[1]}`, JSON.stringify(siminfo));
        ctx.reply(locale.settingsupdated)
    }
});

bot.command('simsim', async (ctx) => {
    if(await functions.auth(redis, ctx.update.message.from.id)) {
        let simkeys = await redis.keys('channel_status*', (val) => { return val; });
        let siminfos = await redis.hgetall('simconfigs', (val) => { return val; })
        if(simkeys.length > 0) {
            let simstatuses = await redis.mget(simkeys, (val) => { return val; });
            let result = '';
            for(let r = 0; r < simstatuses.length; r++) {
                let info = JSON.parse(simstatuses[r]);
                if(siminfos[`sim${info.id}`]) {
                    let simconfig = JSON.parse(siminfos[`sim${info.id}`]);
                    result += `${locale.channel}: ${simconfig.name}\n`+
                            `${locale.simnumber}: ${simconfig.phonenum}\n`;
                }
                result += `id: ${info.id}\nsignal: ${info.signal}\ngsm_status: ${info.gsm_status}\n\n`;
            }
            ctx.reply(result);
        } else {
            ctx.reply(locale.nosimdata);
        }
    }
});

bot.command('getusers', async (ctx) => {
    if(await functions.auth(redis, ctx.update.message.from.id)) {
        let users = await redis.hvals('users', (val) => { return val; });
        if(users?.length > 50) {
            functions.sendInParts(users, ctx);
        } else {
            ctx.reply(users.join('\n'));
        }
    }
});

bot.command('addrecipient', async (ctx) => {
    if(await functions.auth(redis, ctx.update.message.from.id)) {
        let args = ctx.update.message.text.split(' ');
        functions.changeRecipient(redis, locale, args[1], args[2], ctx, true)
    }
});

bot.command('delrecipient', async (ctx) => {
    if(await functions.auth(redis, ctx.update.message.from.id)) {
        let args = ctx.update.message.text.split(' ');
        functions.changeRecipient(redis, locale, args[1], args[2], ctx, false)
    }
});

bot.command('recipients', async (ctx) => {
    if(await functions.auth(redis, ctx.update.message.from.id)) {
        let args = ctx.update.message.text.split(' ');
        if(!args[1]) { ctx.reply(locale.novalue); return; }

        let recipients = await functions.getRecipients(redis, args[1]);

        if(recipients?.length == 0) { ctx.reply(locale.recipientsnotfound); return; }

        if(recipients?.length > 50) {
            functions.sendInParts(recipients, ctx);
        } else {
            ctx.reply(recipients.join('\n'));
        }

    }
});

bot.command('ussd', async (ctx) => {
    if(!await functions.auth(redis, ctx.update.message.from.id)) { ctx.reply(locale.restricted); return; }
    let args = ctx.update.message.text.split(' ');
    let channel = args[1];
    let code = (args.slice(2).join(' ') || '').trim();
    if(!channel || !code) { ctx.reply('Usage: /ussd <channel> <code|selection>   ex: /ussd 2 *100#   ou (reponse menu) /ussd 2 1'); return; }
    if(!functions.checkValue(channel)) { ctx.reply(locale.incorrectchannelvalue); return; }
    const smskey = String(Math.floor(Math.random() * 99999999));
    const host = process.env.goip_host;
    const auth = { username: process.env.goip_user, password: process.env.goip_password };
    const post = (body) => axios.post(`http://${host}/default/en_US/ussd_info.html?type=ussd`, body, { auth, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    const fresh = code.startsWith('*');   // "*code#" = new query (close any open session first); a plain input is a menu reply
    try {
        if(fresh) {
            await post(`line${channel}=1&action=USET&smskey=${smskey}&send=Disconnect&telnum=`).catch(() => {});
            await new Promise(r => setTimeout(r, 800));
        }
        await post(`line${channel}=1&action=USSD&smskey=${smskey}&send=Send&telnum=${encodeURIComponent(code)}`);
    } catch(e) { ctx.reply(`USSD: echec d'envoi (${e?.message ?? 'erreur'})`); return; }
    await ctx.reply(`📡 USSD ${code} envoye sur le canal ${channel}${fresh ? '' : ' (reponse menu)'}, attente de la reponse...`);
    let reply = null;
    for(let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 2000));
        let xml;
        try {
            let res = await axios.get(`http://${host}/default/en_US/send_sms_status.xml?line=`, { auth, timeout: 8000 });
            xml = String(res.data);
        } catch(e) { continue; }
        let key = (xml.match(new RegExp(`<smskey${channel}>([^<]*)</smskey${channel}>`)) || [])[1];
        let status = (xml.match(new RegExp(`<status${channel}>([^<]*)</status${channel}>`)) || [])[1];
        let error = (xml.match(new RegExp(`<error${channel}>([^<]*)</error${channel}>`)) || [])[1];
        if(key === smskey && (error || '').trim()) { reply = error.trim(); break; }
        if(key === smskey && status === 'DONE') { reply = (error || '').trim(); break; }
    }
    if(reply === null) { ctx.reply(`USSD ${code}: pas de reponse dans le delai imparti.`); return; }
    ctx.reply(`📲 USSD (canal ${channel}) "${code}":\n${reply || '(reponse vide)'}`);
});

const OWN_NUMBER_USSD = { djezzy: '*99#', ooredoo: '*113*1*1*1#', nedjma: '*113*1*1*1#', mobilis: '*101#' };

async function ussdQuery(channel, code, closeFirst) {
    const host = process.env.goip_host;
    const auth = { username: process.env.goip_user, password: process.env.goip_password };
    const smskey = String(Math.floor(Math.random() * 99999999));
    const post = (body) => axios.post(`http://${host}/default/en_US/ussd_info.html?type=ussd`, body, { auth, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    if(closeFirst) {
        await post(`line${channel}=1&action=USET&smskey=${smskey}&send=Disconnect&telnum=`).catch(() => {});
        await new Promise(r => setTimeout(r, 800));
    }
    await post(`line${channel}=1&action=USSD&smskey=${smskey}&send=Send&telnum=${encodeURIComponent(code)}`);
    for(let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 2000));
        let xml;
        try { xml = String((await axios.get(`http://${host}/default/en_US/send_sms_status.xml?line=`, { auth, timeout: 8000 })).data); } catch(e) { continue; }
        const get = (t) => (xml.match(new RegExp(`<${t}${channel}>([^<]*)</${t}${channel}>`)) || [])[1];
        const key = get('smskey'), status = get('status'), error = get('error');
        if(key === smskey && (error || '').trim()) return error.trim();
        if(key === smskey && status === 'DONE') return (error || '').trim();
    }
    return null;
}

bot.command('getnumber', async (ctx) => {
    if(!await functions.auth(redis, ctx.update.message.from.id)) { ctx.reply(locale.restricted); return; }
    let args = ctx.update.message.text.split(' ');
    let channel = args[1];
    let override = (args[2] || '').trim();
    if(!channel) { ctx.reply('Usage: /getnumber <channel> [code_ussd]   ex: /getnumber 2'); return; }
    if(!functions.checkValue(channel)) { ctx.reply(locale.incorrectchannelvalue); return; }
    let provider = '';
    try { provider = (JSON.parse(await redis.get(`channel_status${channel}`) || '{}').provider || '').toLowerCase(); } catch(e) {}
    let code = override || OWN_NUMBER_USSD[provider] || '';
    if(!code) { ctx.reply(`Operateur "${provider || 'inconnu'}" non reconnu. Donne le code: /getnumber ${channel} <code_ussd>`); return; }
    await ctx.reply(`🔎 Recherche du numero (canal ${channel}, ${provider || '?'}) via ${code}...`);
    let reply;
    try { reply = await ussdQuery(channel, code, true); } catch(e) { ctx.reply(`getnumber: echec (${e?.message ?? 'erreur'})`); return; }
    if(reply === null) { ctx.reply(`getnumber: pas de reponse (la SIM est peut-etre deconnectee).`); return; }
    let m = reply.match(/([+]?[0-9][0-9 ().-]{6,}[0-9])/);
    let num = m ? m[1].replace(/[ ().-]/g, '') : null;
    ctx.reply(`📇 Canal ${channel} (${provider || '?'}):\n${num ? 'Numero detecte: ' + num + '\n' : ''}Reponse: ${reply}`);
});

bot.start(async (ctx) => {
    let registered = await functions.isRegistered(redis, ctx.update.message.from.id);

    if(!registered) {
        let info = await bot.telegram.getChat(ctx.update.message.from.id).catch((err) => { console.log(err); return false; });
        if(info) {
            redis.hset('users', ctx.update.message.from.id, `${info.username ?? info.id} ( ${info.id} )`);
        }
    }

    ctx.reply(`👋🏻 ${locale.hello} ${ctx.message.from.username ?? ctx.message.chat.first_name}!`);
});

bot.on('text', async (ctx) => {
    let action = await redis.hget('actions', ctx.update.message.from.id);

    if(!action) {
        return;
    }

    switch(action) {
        case 'sendnumbers':
            let numbersArr = ctx.update.message?.text?.replace(' ', '')?.split('\n');
            if(numbersArr.length > 20) {
                ctx.reply(locale.morethantwenty);
                return;
            }
            await redis.hset(`session_${ctx.update.message.from.id}`, 'numbers', JSON.stringify(numbersArr));
            await redis.hset('actions', ctx.update.message.from.id, 'sendmessage');
            ctx.reply(`${locale.selectednumbers}\n${numbersArr.join(' \n')}\n\n${locale.writeyourmessage}`)
        break;
        case 'sendmessage':
            let numbers = JSON.parse(await redis.hget(`session_${ctx.update.message.from.id}`, 'numbers'));
            let channel = await redis.hget(`session_${ctx.update.message.from.id}`, 'channel');
            await ctx.reply(locale.querysended);
            for(let i = 0; i < numbers?.length; i++) {
                await new Promise(data => { setTimeout(() => { data(true) }, 500) });
                let send = await axios.get(`http://${process.env.goip_host}/default/en_US/send.html?u=${process.env.goip_user}&p=${process.env.goip_password}&l=${channel}&n=${encodeURIComponent(numbers[i].trim().replace(/^[+]/, '00'))}&m=${encodeURIComponent(ctx.update.message.text)}`).catch(e => { return { status: 'failed', err: e?.message ?? 'unknown error'} })
                if(send?.status === 'failed' || send.status >= 400 || /error/i.test(String(send?.data))) {
                    if(process.env?.debug) {
                        console.log(`${locale.sendingfailed}\n${numbers[i]}err${send.err}`);
                    }
                    await ctx.reply(`${locale.sendingfailed}\n${numbers[i]}`);
                }
            }
            await redis.hdel(`actions`, ctx.update.message.from.id);
        break;
    }
});

bot.catch((err, ctx) => {
    console.log(err, ctx);
    process.exit(1);
})

if(!process.env.goip_password || !process.env.bottoken || !process.env.admin_username) {
    console.log('Configure required parameters in app/.env');
    process.exit(0);
}

bot.launch();