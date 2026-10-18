'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {ObservationJournal,parsePosteOTP}=require('../components/core/otp-observation');
class RedisDouble {
    constructor(now){this.now=now;this.data=new Map();this.syncFails=false;}
    async get(k){const v=this.data.get(k);return v&&v.expires>this.now()?v.raw:null;}
    async set(k,v,...args){const ttl=Number(args[1]);if(args.includes('NX')&&await this.get(k))return null;this.data.set(k,{raw:v,expires:this.now()+ttl});return 'OK';}
    async eval(script,n,k,old,value,ttl){if(await this.get(k)!==old)return null;if(script.includes("'DEL'")){this.data.delete(k);return 1;}return this.set(k,value,'PX',ttl);}
    async call(){return this.syncFails?[0,0]:[1,0];}
}
function setup(){let now=Date.now();const redis=new RedisDouble(()=>now),key=crypto.randomBytes(32);const args={redis,key,now:()=>now};return {redis,key,j:new ObservationJournal(args),args,tick:n=>now+=n};}
const body={attempt_id:'attempt-one',reservation_id:'reservation-one',provider:'mobilis',amount_dzd:100,ttl_seconds:30,dry_run:true};
const packet=(id='packet-one',code='12345')=>({slot:2,receiveId:id,sender:'UNSTABLE_SENDER',content:'Votre mot de passe a usage unique OTP est: '+code});
test('qualified five-digit Poste templates only; no sender dependency',()=>{
 for(const v of ['Votre mot de passe a usage unique OTP est: 12345','Votre mot de passe à usage unique (OTP) est: 12345.'])assert.equal(parsePosteOTP(v).code,'12345');
 for(const v of ['12345','OTP 12345','Votre mot de passe a usage unique OTP est: 123456','Votre mot de passe a usage unique OTP est: 12345 67890','prefix Votre mot de passe a usage unique OTP est: 12345'])assert.equal(parsePosteOTP(v),null);
});
test('scope rejects payment use, unknown provider, arbitrary amount and malformed IDs',async()=>{
 const {j}=setup();for(const replacement of [{dry_run:false},{amount_dzd:200},{provider:'other'},{attempt_id:'../bad'},{ttl_seconds:181}])assert.equal((await j.begin({...body,...replacement}))[0],400);
});
test('read is repeatable until explicit ACK; encrypted state survives process recreation',async()=>{
 const {j,args,redis}=setup();const [,lease]=await j.begin(body);assert.equal(lease.transaction_correlated,false);
 await j.ingest(packet());const [status,event]=await j.event(body.attempt_id,lease.reader_token,0);assert.equal(status,200);assert.equal(event.otp_code,'12345');assert.equal(event.transaction_correlated,false);
 assert.equal(JSON.stringify([...redis.data]).includes('12345'),false);assert.equal(JSON.stringify([...redis.data]).includes(lease.reader_token),false);
 const restarted=new ObservationJournal(args);assert.equal((await restarted.event(body.attempt_id,lease.reader_token,0))[1].event_id,event.event_id);
 assert.equal((await restarted.ack(body.attempt_id,lease.reader_token,'wrong-id'))[0],409);
 assert.equal((await restarted.ack(body.attempt_id,lease.reader_token,event.event_id))[0],200);
 assert.equal((await restarted.ack(body.attempt_id,lease.reader_token,event.event_id))[0],200);
 assert.equal((await restarted.event(body.attempt_id,lease.reader_token,0))[1].otp_code,undefined);
});
test('waiting subscriber receives immediate delivery; no historic SMS lookup',async()=>{
 const {j}=setup();await j.ingest(packet('old-packet'));
 const [,lease]=await j.begin(body);assert.equal((await j.event(body.attempt_id,lease.reader_token,0))[0],204);
 const waiting=j.event(body.attempt_id,lease.reader_token,500);setTimeout(()=>j.ingest(packet('fresh-packet')),10);
 const [status,event]=await waiting;assert.equal(status,200);assert.equal(event.otp_code,'12345');
});
test('UDP duplicate is stable, distinct bank candidates suspend even after restart',async()=>{
 const {j,args}=setup();const [,lease]=await j.begin(body);await j.ingest(packet());const first=(await j.event(body.attempt_id,lease.reader_token,0))[1];
 await j.ingest(packet());assert.equal((await j.event(body.attempt_id,lease.reader_token,0))[1].event_id,first.event_id);
 await j.ingest(packet('packet-two','67890'));assert.equal((await new ObservationJournal(args).event(body.attempt_id,lease.reader_token,0))[0],409);
});
test('wrong capability, wrong slot, personal SMS, expiration and wrong close do not expose OTP',async()=>{
 const {j,tick}=setup();const [,lease]=await j.begin(body);
 await j.ingest({...packet(),slot:1});await j.ingest({...packet(),content:'personal alert'});
 assert.equal((await j.event(body.attempt_id,'wrong-token',0))[0],403);
 assert.equal((await j.event('attempt-other',lease.reader_token,0))[0],403);
 assert.equal((await j.event(body.attempt_id,lease.reader_token,0))[0],204);
 assert.equal((await j.close('wrong-attempt'))[0],409);
 tick(31000);assert.equal((await j.event(body.attempt_id,lease.reader_token,0))[0],403);
});
test('durability failure prevents reporting begin successful and leaves lock for review',async()=>{
 const {j,redis}=setup();redis.syncFails=true;await assert.rejects(()=>j.begin(body),/not_durable/);assert.equal(await j.locked(),true);
});
test('reader cancellation terminates bounded wait; journal tampering fails authentication',async()=>{
 const {j,redis}=setup();const [,lease]=await j.begin(body);const c=new AbortController();const waiting=j.event(body.attempt_id,lease.reader_token,500,c.signal);c.abort();await assert.rejects(()=>waiting,{name:'AbortError'});
 const entry=[...redis.data.values()][0];const v=Buffer.from(entry.raw,'base64');v[v.length-1]^=1;entry.raw=v.toString('base64');await assert.rejects(()=>j.read());
});

const http=require('node:http'),{once}=require('node:events');
const {Inbox,handler}=require('../components/core/private-sms-inbox');
test('HTTP long poll uses scoped capabilities, separate ACK, dry-only creation and exclusive v1/v2 modes',async t=>{
 const {j}=setup();const control='SYNTHETIC_CONTROL_CAPABILITY_WITH_32_CHARS';
 const inbox=new Inbox({password:'SYNTHETIC_PASSWORD',gateway:'192.0.2.8',controlToken:control});inbox.observations=j;
 const server=http.createServer(handler(inbox));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{inbox.close();server.close();});
 const root='http://127.0.0.1:'+server.address().port;
 const req=async(path,token,data)=>{const r=await fetch(root+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token},body:data?JSON.stringify(data):undefined});return {status:r.status,headers:r.headers,body:r.status===204?null:await r.json()};};
 assert.equal((await req('/v2/observations','wrong',body)).status,403);
 assert.equal((await req('/v2/observations',control,{...body,dry_run:false})).status,400);
 const lease=await req('/v2/observations',control,body);assert.equal(lease.status,201);
 assert.equal((await req('/v2/observations',control,{...body,attempt_id:'attempt-other'})).status,409);
 inbox.clear({boot_id:inbox.bootId,clearance_id:'clearance-one'});
 assert.equal((await req('/v1/attempts',control,{attempt_id:'legacy-one',reservation_id:'reservation-legacy',expected_reference:'REFERENCE_12345678',expected_sender:'BANK',ttl_seconds:30})).status,409);
 const path='/v2/observations/'+body.attempt_id;
 assert.equal((await req(path+'/event',control)).status,403);
 const waiting=req(path+'/event',lease.body.reader_token);await j.ingest(packet());const event=await waiting;
 assert.equal(event.status,200);assert.equal(event.headers.get('cache-control'),'no-store');assert.equal(event.body.otp_code,'12345');
 assert.equal(event.body.transaction_correlated,false);
 assert.equal((await req(path+'/ack','wrong',{event_id:event.body.event_id})).status,403);
 assert.equal((await req(path+'/ack',lease.body.reader_token,{event_id:event.body.event_id})).status,200);
 assert.equal((await req(path+'/event',lease.body.reader_token)).body.otp_code,undefined);
 assert.equal((await req(path+'/close',lease.body.reader_token,{})).status,403);
 assert.equal((await req(path+'/close',control,{})).status,200);
});
