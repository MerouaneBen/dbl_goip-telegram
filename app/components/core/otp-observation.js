'use strict';
// Dry-run observation only. A recent bank SMS is NOT transaction correlation.
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const KEY = 'khallasli:otp:v2:active';
const AAD = Buffer.from('khallasli-otp-observation-v2');
const CAS = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]) else return false end";
const ID = /^[A-Za-z0-9_-]{8,100}$/;
function same(a, b) {
    const x=Buffer.from(a||''), y=Buffer.from(b||'');
    return x.length>0 && x.length===y.length && crypto.timingSafeEqual(x,y);
}
function parsePosteOTP(text) {
    if (typeof text!=='string' || text.length>1000) return null;
    const value=text.normalize('NFKC').replace(/\s+/g,' ').trim();
    const m=/^Votre mot de passe [aà] usage unique\s*(?:\(?OTP\)?)\s*est\s*:\s*([0-9]{5})\.?$/i.exec(value);
    return m ? { code:m[1], parser:'poste-fr-otp5-v1' } : null;
}
class ObservationJournal {
    constructor({redis,key,now=()=>Date.now()}) {
        if (!redis || !Buffer.isBuffer(key) || key.length!==32) throw Error('otp_journal_configuration');
        this.redis=redis;this.key=Buffer.from(key);this.now=now;this.failed=false;
    }
    seal(value) {
        const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(AAD);
        const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
        return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');
    }
    open(raw) {
        const b=Buffer.from(raw,'base64');if(b.length<29 || b.length>20000)throw Error('otp_journal_invalid');
        const d=crypto.createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAAD(AAD);d.setAuthTag(b.subarray(12,28));
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));
    }
    async durable() {
        const r=await this.redis.call('WAITAOF',1,0,1500);
        if(!Array.isArray(r)||Number(r[0])!==1)throw Error('otp_journal_not_durable');
    }
    async read() {const raw=await this.redis.get(KEY);return raw?{raw,state:this.open(raw)}:null;}
    async locked(){return !!(await this.read());}
    async begin(body) {
        if (!body || !ID.test(body.attempt_id||'') || !ID.test(body.reservation_id||'') ||
            body.dry_run!==true || body.amount_dzd!==100 || !['mobilis','ooredoo','djezzy'].includes(body.provider) ||
            !Number.isInteger(body.ttl_seconds)||body.ttl_seconds<5||body.ttl_seconds>180) return [400,{error:'observation_scope_invalid'}];
        const token=crypto.randomBytes(32).toString('base64url');
        const state={id:body.attempt_id,reservation:body.reservation_id,provider:body.provider,amount:body.amount_dzd,
            token_hash:crypto.createHash('sha256').update(token).digest('hex'),expires:this.now()+body.ttl_seconds*1000,
            created_at:new Date(this.now()).toISOString(),candidate:null,ambiguous:false,acked:false};
        if(await this.redis.set(KEY,this.seal(state),'PX',body.ttl_seconds*1000,'NX')!=='OK')return [409,{error:'observation_locked'}];
        await this.durable();this.failed=false;
        return [201,{attempt_id:state.id,reader_token:token,armed_at:state.created_at,expires_at:new Date(state.expires).toISOString(),
            mode:'dry_run_observation_only',transaction_correlated:false,financial_channel_reservation:false}];
    }
    async update(old,state) {
        const ttl=state.expires-this.now();if(ttl<=0)return false;
        const result=await this.redis.eval(CAS,1,KEY,old,this.seal(state),ttl);
        if(result!=='OK')return false;
        await this.durable();return true;
    }
    async ingest(p) {
        if(p.slot!==2||!p.receiveId||typeof p.content!=='string')return;
        const parsed=parsePosteOTP(p.content);if(!parsed)return;
        const receivedAt=new Date(this.now()).toISOString();
        for(let n=0;n<4;n++) {
            const old=await this.read();if(!old)return;
            const s=old.state;if(s.expires<=this.now())return;
            const digest=crypto.createHmac('sha256',this.key).update(p.receiveId+'\0'+p.content).digest('hex');
            if(s.candidate?.digest===digest)return;
            if(s.candidate){s.ambiguous=true;s.candidate.message='';s.candidate.code='';}
            else s.candidate={event_id:crypto.randomUUID(),received_at:receivedAt,
                digest,message:p.content,code:parsed.code,parser:parsed.parser};
            if(await this.update(old.raw,s))return;
        }
        throw Error('otp_journal_conflict');
    }
    async authorized(id,token) {
        const record=await this.read();
        if(!record||record.state.id!==id||!same(record.state.token_hash,crypto.createHash('sha256').update(token||'').digest('hex')))
            return null;
        return record;
    }
    async event(id,token,waitMs=5000,signal) {
        const end=Date.now()+Math.min(5000,Math.max(0,waitMs));
        while(true){
            const record=await this.authorized(id,token);if(!record)return [403,{error:'observation_forbidden_or_expired'}];
            const s=record.state;
            if(s.ambiguous)return [409,{error:'observation_ambiguous',transaction_correlated:false}];
            if(s.acked)return [200,{attempt_id:id,acknowledged:true,transaction_correlated:false}];
            if(s.candidate){await this.durable();const c=s.candidate;return [200,{attempt_id:id,event_id:c.event_id,received_at:c.received_at,
                message:c.message,otp_code:c.code,parser:c.parser,transaction_correlated:false,bank_accepted:false,financial_success:false}];}
            if(Date.now()>=end)return [204,null];
            await delay(Math.min(100,Math.max(1,end-Date.now())),undefined,{signal});
        }
    }
    async ack(id,token,eventId) {
        for(let n=0;n<4;n++){
            const old=await this.authorized(id,token);if(!old)return [403,{error:'observation_forbidden_or_expired'}];
            const s=old.state;if(s.ambiguous||!s.candidate||s.candidate.event_id!==eventId)return [409,{error:'event_mismatch'}];
            if(!s.acked){s.acked=true;s.candidate.message='';s.candidate.code='';if(!await this.update(old.raw,s))continue;}
            return [200,{attempt_id:id,event_id:eventId,acknowledged:true,financial_success:false}];
        }
        return [409,{error:'observation_conflict'}];
    }
    async close(id) {
        const old=await this.read();if(!old||old.state.id!==id)return [409,{error:'observation_mismatch'}];
        const deleted=await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,KEY,old.raw);
        if(!deleted)return [409,{error:'observation_conflict'}];
        await this.durable();return [200,{closed:true,financial_success:false}];
    }
}
module.exports={ObservationJournal,parsePosteOTP};
