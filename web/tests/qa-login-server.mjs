// Local QA only. This test peer is not imported by the app or offered as a data source.
import {createServer} from 'node:http';
import {DOMParser} from '@xmldom/xmldom';
import {AppleUpstreamFixture} from './apple-upstream-fixture.mjs';
import {decodePlist} from '../lib/auth/plist.ts';
globalThis.DOMParser=DOMParser;
const peer=new AppleUpstreamFixture();
// Exercise password retention with synthetic errors; all requests stay in this fixture.
const retryErrors=process.argv.includes('--retry-errors');
let passwordTimedOut=false,delegateFailed=false;
const allowed=new Set(['http://localhost:5173','http://127.0.0.1:5173']);
const server=createServer(async(request,response)=>{
  const origin=request.headers.origin;
  if(origin&&!allowed.has(origin)){response.writeHead(403);response.end();return;}
  response.setHeader('Access-Control-Allow-Origin',origin??'http://localhost:5173');
  response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  response.setHeader('Access-Control-Allow-Private-Network','true');
  response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json');
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  const send=(value,status=200)=>{response.writeHead(status);response.end(JSON.stringify(value));};
  if(request.url==='/v1/health'){send({protocolVersion:1,agentVersion:'QA-test-peer',capabilities:{anisette:true,appleRelay:true}});return;}
  try{
    const chunks=[];for await(const chunk of request){chunks.push(chunk);if(chunks.reduce((n,c)=>n+c.length,0)>65536)throw Error('oversized');}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(request.url==='/v1/anisette'){send(await peer.getAnisette());return;}
    if(request.url==='/v1/apple/request'){
      if(retryErrors&&body.endpoint==='gsa'&&!passwordTimedOut&&decodePlist(new Uint8Array(Buffer.from(body.bodyBase64,'base64'))).Request.o==='complete'){
        passwordTimedOut=true;send({error:{code:'TIMEOUT',message:'Synthetic password verification timeout',retryable:true}},504);return;
      }
      if(retryErrors&&body.endpoint==='mobileme'&&!delegateFailed){
        delegateFailed=true;send({error:{code:'UPSTREAM_UNAVAILABLE',message:'Synthetic delegate outage',retryable:true}},502);return;
      }
      send(await peer.forwardApple(body));return;
    }
    send({error:{code:'NOT_FOUND'}},404);
  }catch{send({error:{code:'INTERNAL_ERROR'}},500);}
});
server.listen(0,'127.0.0.1',()=>console.log(`QA bridge listening on http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
