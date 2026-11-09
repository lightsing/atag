import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeClient} from '../lib/agent/bridge-client.ts';
import {BrowserAppleLogin} from '../lib/auth/apple-login.ts';
import {ClientError} from '../lib/client-support.ts';

const url='http://127.0.0.1:18432';
const message='macOS 系统 Anisette 不可用（OTP dictionary incomplete）。请在高级选项选择便携运行库。';

function delayedFetch(value,delay,observed={}){
  return async(_url,{signal})=>new Promise((resolve,reject)=>{
    observed.signal=signal;
    const aborted=()=>{clearTimeout(timer);reject(new DOMException('aborted','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve(Response.json(value));},delay);
    signal.addEventListener('abort',aborted,{once:true});
  });
}

test('slow machine initialization and Apple responses outlive the old shared 55 second deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const anisette={headers:{'x-apple-i-md':'synthetic-otp','x-apple-i-md-m':'synthetic-machine'},clientInfo:'synthetic-client',userAgent:'synthetic-agent'};
  const bridge=new BridgeClient(url,delayedFetch(anisette,60_000));
  const pending=bridge.getAnisette('portable','user','device');
  t.mock.timers.tick(60_000);
  assert.deepEqual(await pending,anisette);

  const response={status:200,headers:{},bodyBase64:''};
  const relay=new BridgeClient(url,delayedFetch(response,61_000));
  const apple=relay.forwardApple({endpoint:'gsa',method:'POST',headers:{},bodyBase64:''});
  t.mock.timers.tick(61_000);
  assert.deepEqual(await apple,response);
});

test('health, machine initialization and Apple relay each have a bounded wait',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const [path,body,limit] of [['/v1/health',undefined,8_000],['/v1/anisette',{},250_000],['/v1/apple/request',{},70_000]]){
    const observed={};
    const bridge=new BridgeClient(url,delayedFetch({},limit+1,observed));
    const pending=bridge.request(path,body);
    const rejected=assert.rejects(pending,{code:'TIMEOUT'});
    t.mock.timers.tick(limit-1);
    assert.equal(observed.signal.aborted,false,path);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(observed.signal.aborted,true,path);
  }
});

test('cancelling a slow machine request aborts immediately without waiting for its deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const observed={},controller=new AbortController();
  const bridge=new BridgeClient(url,delayedFetch({},200_000,observed));
  const pending=bridge.getAnisette('portable','user','device','auto',controller.signal);
  const rejected=assert.rejects(pending,{code:'CANCELLED'});
  t.mock.timers.tick(60_000);
  assert.equal(observed.signal.aborted,false);
  controller.abort();
  await rejected;
  assert.equal(observed.signal.aborted,true);
});

test('Anisette accepts the agent locale header while rejecting unrelated or injected headers',async()=>{
  const headers={'x-apple-i-md':'synthetic-otp','x-apple-i-md-m':'synthetic-machine','x-mme-device-id':'synthetic-device',loc:'en_US'};
  for(const extra of [{},{Authorization:'never-accept'},{Cookie:'never-accept'},{loc:'en_US\r\nInjected: true'}]){
    const bridge=new BridgeClient(url,async()=>Response.json({headers:{...headers,...extra},clientInfo:'synthetic-client',userAgent:'synthetic-agent'}));
    const pending=bridge.getAnisette('portable','user','device');
    if(Object.keys(extra).length)await assert.rejects(pending,{code:'UPSTREAM_UNAVAILABLE'});
    else assert.deepEqual((await pending).headers,headers);
  }
});

test('bridge retains actionable error details and retry policy without exposing the response body',async()=>{
  const bridge=new BridgeClient(url,async()=>Response.json({error:{code:'UPSTREAM_UNAVAILABLE',message,retryable:false},privateMaterial:'never display'},{status:502}));
  await assert.rejects(bridge.getAnisette('local','user','device'),error=>{
    assert.ok(error instanceof ClientError);
    assert.equal(error.code,'UPSTREAM_UNAVAILABLE');
    assert.equal(error.message,message);
    assert.equal(error.status,502);
    assert.equal(error.retryable,false);
    assert.ok(!JSON.stringify(error).includes('never display'));
    return true;
  });
});

test('malformed bridge error details retain the safe default message',async()=>{
  for(const details of [undefined,null,{}, {code:'unknown',message:'untrusted response'},
    ...['',42,'x'.repeat(513),'control\ntext'].map(message=>({code:'UPSTREAM_UNAVAILABLE',message}))]){
    const bridge=new BridgeClient(url,async()=>Response.json({error:details},{status:502}));
    await assert.rejects(bridge.connect(),error=>{
      assert.ok(error instanceof ClientError);
      assert.equal(error.message,new ClientError(error.code).message);
      assert.equal(error.status,502);
      return true;
    });
  }
});

test('Anisette failure reaches the login screen before any Apple request or account save',async t=>{
  let saves=0;
  const bridge=new BridgeClient(url,async(request)=>{
    assert.ok(request.endsWith('/anisette'));
    return Response.json({error:{code:'UPSTREAM_UNAVAILABLE',message,retryable:true}},{status:502});
  });
  const login=new BrowserAppleLogin(()=>bridge,async()=>{saves++;});
  t.after(()=>login.cancel());
  await assert.rejects(login.start({username:'alice@example.test',password:'synthetic-password',anisetteSource:'local'}),{message});
  assert.equal(login.snapshot().phase,'error');
  assert.deepEqual(login.snapshot().error,{code:'UPSTREAM_UNAVAILABLE',message});
  assert.equal(saves,0);
  assert.ok(!JSON.stringify(login.snapshot()).includes('synthetic-password'));
});
