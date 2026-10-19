import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1:18769';
const password='pilot-test-password-long-enough';
const auth='Basic '+Buffer.from('admin:'+password).toString('base64');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chilli-pilot-'));
let log='';
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'test',PUBLIC_URL:base,HOST:'127.0.0.1',PORT:'18769',DATA_DIR:dir,ADMIN_PASSWORD:password,MASTER_SECRET:'a-test-master-secret-of-at-least-32-chars'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
const request=(pathname,options={})=>fetch(base+pathname,{...options,headers:{Authorization:auth,...options.headers}});
try{
 for(let i=0;i<50;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 await test('health reports a working registry',async()=>assert.equal((await fetch(base+'/healthz')).status,200));
 await test('admin requires authentication',async()=>assert.equal((await fetch(base+'/admin/api/sites')).status,401));
 const state=await(await request('/admin/api/sites')).json();
 await test('new registry is empty',()=>assert.deepEqual(state.sites,[]));
 await test('site creation rejects missing CSRF',async()=>assert.equal((await request('/admin/api/sites',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'Probe',origins:['https://example.com']})})).status,403));
 await test('site creation rejects hostile origin',async()=>assert.equal((await request('/admin/api/sites',{method:'POST',headers:{Origin:'https://hostile.example','Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify({name:'Probe',origins:['https://example.com']})})).status,403));
 const create=async(name,origins)=>request('/admin/api/sites',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify({name,origins})});
 await test('wildcard origins are rejected',async()=>assert.equal((await create('Bad',['https://*.example.com'])).status,422));
 const created=await create('<script>test</script>',['https://example.com']);
 await test('site creates its own backend',()=>assert.equal(created.status,201,log));
 const {id}=await created.json();
 const second=await create('Second site',['https://second.example']);const secondId=(await second.json()).id;
 await test('site IDs are distinct',()=>assert.notEqual(id,secondId));
 await test('public scripts contain the correct site URL and brand settings',async()=>{const r=await fetch(base+`/sites/${id}/c15t.js`);const js=await r.text();assert.equal(r.status,200);assert.ok(js.includes(`/sites/${id}`));assert.ok(js.includes('hideBranding'));assert.ok(!js.includes(password));});
 await test('policy initialization works',async()=>{const r=await fetch(base+`/sites/${id}/init`,{headers:{Origin:'https://example.com'}});assert.equal(r.status,200,await r.text());});
 await test('private consent reads stay protected',async()=>assert.equal((await fetch(base+`/sites/${id}/subjects?externalId=probe`,{headers:{Origin:'https://example.com'}})).status,401));
 await test('unregistered origin cannot save consent',async()=>assert.equal((await fetch(base+`/sites/${id}/subjects`,{method:'POST',headers:{Origin:'https://hostile.example','Content-Type':'application/json'},body:'{}'})).status,403));
 await test('unknown site cannot initialize',async()=>assert.equal((await fetch(base+'/sites/00000000-0000-0000-0000-000000000000/init')).status,404));
 await test('admin-supplied markup stays data',async()=>{const s=await(await request('/admin/api/sites')).json();assert.equal(s.sites.length,2);assert.equal(s.sites.find(x=>x.id===id).name,'<script>test</script>');assert.equal(s.sites.find(x=>x.id===id).total,0);});
 await test('admin UI uses a restrictive CSP',async()=>{const r=await request('/admin/');assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);});
 await test('readable backup copies the registry and site databases',async()=>{const dest=path.join(dir,'backups');await fs.mkdir(dest);const backup=spawn(process.execPath,['backup.mjs',dest],{cwd:root,env:{...process.env,DATA_DIR:dir},stdio:['ignore','pipe','pipe']});const exit=await new Promise(r=>backup.on('exit',r));assert.equal(exit,0);const [stamp]=await fs.readdir(dest);assert.equal((await fs.readdir(path.join(dest,stamp))).filter(x=>x.endsWith('.sqlite')).length,3);});
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await fs.rm(dir,{recursive:true,force:true});}
