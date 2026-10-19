import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { c15tInstance, createMigrator, policyRulePresets } from '@c15t/backend';

const here = path.dirname(fileURLToPath(import.meta.url));
const password = process.env.ADMIN_PASSWORD || '';
const secret = process.env.MASTER_SECRET || '';
if (password.length < 24 || secret.length < 32) throw new Error('Set a strong ADMIN_PASSWORD and MASTER_SECRET before starting.');
const origin = new URL(process.env.PUBLIC_URL || 'http://127.0.0.1:3090').origin;
if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Production requires an HTTPS PUBLIC_URL.');
const dir = path.resolve(process.env.DATA_DIR || './data');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const registry = new DatabaseSync(path.join(dir, 'registry.sqlite'));
registry.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL, created_at TEXT NOT NULL)');
const instances = new Map();
const initializing = new Map();
const csrf = crypto.createHmac('sha256', secret).update('admin-form').digest('hex');
const equal = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(); const y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const siteFor = (id) => registry.prepare('SELECT * FROM sites WHERE id=?').get(id);
const derive = (id, purpose) => crypto.createHmac('sha256', secret).update(`${purpose}:${id}`).digest('hex');

async function backend(site) {
  if (instances.has(site.id)) return instances.get(site.id);
  if (initializing.has(site.id)) return initializing.get(site.id);
  const pending = (async () => {
    const database = { dialect: 'sqlite', filename: path.join(dir, site.id + '.sqlite') };
    const migrator = createMigrator(database);
    try { const plan = await migrator.plan(); if (plan.blocked) throw new Error('Database migration blocked'); const result = await migrator.apply(); if (result.blocked) throw new Error('Database migration blocked'); } finally { await migrator.dispose(); }
    const base = `${origin}/sites/${site.id}`;
    const instance = c15tInstance({ database, tenantId: site.id, requireTenantId: true,
      apiKeys: [derive(site.id, 'admin-api')], trustedOrigins: JSON.parse(site.origins),
      basePath: `/sites/${site.id}`, ipAddress: { tracking: false },
      policySnapshot: { signingKey: derive(site.id, 'policy-signing') },
      openapi: { enabled: false }, observability: { level: 'silent' },
      manifest: { policyRules: [{ ...policyRulePresets.europeOptIn(), match: { isDefault: true } }] },
      script: { backendURL: base, config: { language: 'sv', ui: { banner: { hideBranding: true }, dialog: { hideBranding: true }, theme: { colors: { primary: '#b93820', primaryHover: '#952b19', textOnPrimary: '#ffffff' } } } } }
    });
    instances.set(site.id, instance); return instance;
  })();
  initializing.set(site.id, pending);
  try { return await pending; } finally { initializing.delete(site.id); }
}
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const split = decoded.indexOf(':'); if (split < 0) return false;
  return equal(decoded.slice(0, split), process.env.ADMIN_USERNAME || 'admin') && equal(decoded.slice(split + 1), password);
}
async function bodyOf(req) {
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > 65536) { const error = new Error('Body too large'); error.status = 413; throw error; } parts.push(part); }
  return Buffer.concat(parts);
}
const buckets = new Map();
const sweep = setInterval(() => { const now=Date.now(); for (const [key,b] of buckets) if (b.until < now) buckets.delete(key); }, 60000); sweep.unref();
function rateLimited(req, url) {
  const key=(req.headers['x-real-ip'] || req.socket.remoteAddress || '') + (url.startsWith('/admin') ? ':admin' : ':public');
  let b=buckets.get(key); if (!b || b.until < Date.now()) { if(buckets.size > 10000) return true; b={count:0,until:Date.now()+60000}; buckets.set(key,b); }
  return ++b.count > (url.startsWith('/admin') ? 120 : 600);
}
const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000 }, async (req, res) => {
  let response;
  try {
    const url = new URL(req.url || '/', origin);
    if (rateLimited(req,url.pathname)) response=json({error:'Too many requests'},429);
    else if (url.pathname === '/healthz') {registry.prepare('SELECT 1').get(); response=json({status:'ok',service:'Chilli Consent pilot'});}
    else if (url.pathname === '/') response=new Response(null,{status:302,headers:{Location:'/admin/'}});
    else if (url.pathname.startsWith('/admin')) {
      if (!authorized(req)) response=new Response('Sign in to Chilli Consent',{status:401,headers:{'WWW-Authenticate':'Basic realm="Chilli Consent", charset="UTF-8"','Cache-Control':'no-store'}});
      else if (req.method === 'GET' && url.pathname === '/admin/api/sites') {
        const rows=registry.prepare('SELECT * FROM sites ORDER BY created_at DESC').all().map(site=>{
          const filename=path.join(dir,site.id+'.sqlite');let total=0;let latest=[];
          try {const db=new DatabaseSync(filename,{readOnly:true});try{total=db.prepare('SELECT count(*) AS total FROM consent WHERE tenantId=?').get(site.id).total;latest=db.prepare('SELECT givenAt,purposeIds FROM consent WHERE tenantId=? ORDER BY givenAt DESC LIMIT 12').all(site.id);}finally{db.close();}}catch{}
          return {id:site.id,name:site.name,origins:JSON.parse(site.origins),created_at:site.created_at,total,latest,script:`<script src="${origin}/sites/${site.id}/c15t.js" defer></script>`,demo:`/demo/${site.id}`};
        });response=json({sites:rows,csrf,scanner:'not configured',billing:'not configured'});
      } else if (req.method === 'POST' && url.pathname === '/admin/api/sites') {
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== csrf) response=json({error:'Invalid request origin or CSRF token'},403);
        else {
          const input=JSON.parse((await bodyOf(req)).toString());const name=String(input.name||'').trim();
          if(!name || name.length>100 || !Array.isArray(input.origins) || input.origins.length<1 || input.origins.length>10) throw Object.assign(new Error('Provide a site name and 1–10 origins'),{status:422});
          const origins=[...new Set(input.origins.map(x=>{const u=new URL(x);if(u.hostname.includes('*') || u.origin!==x || u.username || u.password || (u.protocol!=='https:' && !(process.env.NODE_ENV!=='production' && u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw Object.assign(new Error('Origins must be exact HTTPS origins, without paths'),{status:422});return u.origin;}))];
          if(registry.prepare('SELECT count(*) AS n FROM sites').get().n>=100) throw Object.assign(new Error('Pilot site limit reached'),{status:422});
          const site={id:crypto.randomUUID(),name,origins:JSON.stringify(origins),created_at:new Date().toISOString()};
          // Include this service's own origin for the protected preview page.
          site.origins=JSON.stringify([...new Set([...origins,origin])]);
          registry.prepare('INSERT INTO sites VALUES (?,?,?,?)').run(site.id,site.name,site.origins,site.created_at);
          try{await backend(site);response=json({id:site.id},201);}catch(error){registry.prepare('DELETE FROM sites WHERE id=?').run(site.id);throw error;}
        }
      } else if (req.method==='GET' && ['/admin/','/admin'].includes(url.pathname)) response=new Response(await fs.readFile(path.join(here,'public/index.html')),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      else if (req.method==='GET' && ['/admin/admin.js','/admin/styles.css'].includes(url.pathname)) response=new Response(await fs.readFile(path.join(here,'public',url.pathname.split('/').pop())),{headers:{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store'}});
      else response=json({error:'Not found'},404);
    } else if (url.pathname.startsWith('/demo/')) {
      if(!authorized(req)) response=new Response('Sign in',{status:401,headers:{'WWW-Authenticate':'Basic realm="Chilli Consent"'}});
      else {const id=url.pathname.slice(6);const site=siteFor(id);if(!site)response=json({error:'Not found'},404);else response=new Response(`<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chilli Consent — förhandsvisning</title><script src="/sites/${site.id}/c15t.js" defer></script><style>body{font:18px/1.6 system-ui;background:#faf6ef;color:#241f1b;padding:10vw;max-width:780px}h1{font-size:clamp(36px,7vw,72px);line-height:1.05}a{color:#b93820}</style><p>CHILLI CONSENT / PILOT</p><h1>Ditt val.<br>Din integritet.</h1><p>En testmiljö för samtycke. Ingen extern spårning används här. Testskriptet aktiveras först när du godkänner analys.</p><p><a href="#c15t-preferences">Ändra integritetsinställningar</a> · <a href="/admin/">Till administrationen</a></p><script type="text/plain" data-c15t-category="measurement" src="/fixture-analytics.js"></script></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}
    } else if(url.pathname==='/fixture-analytics.js') response=new Response('window.chilliDemoAnalytics=true;',{headers:{'Content-Type':'text/javascript'}});
    else {
      const match=url.pathname.match(/^\/sites\/([0-9a-f-]{36})(\/.*)$/);const site=match && siteFor(match[1]);
      if(!site)response=json({error:'Unknown site'},404);
      else {
        // Browser calls may write only from a registered origin. The public
        // script and policy are readable without granting private record access.
        const requestOrigin=req.headers.origin;
        if(req.method==='POST' && !JSON.parse(site.origins).includes(requestOrigin)) response=json({error:'Origin not allowed'},403);
        else {const instance=await backend(site);const body=await bodyOf(req);const headers=new Headers();for(const[k,v]of Object.entries(req.headers)){if(['authorization','host','x-forwarded-for','x-real-ip'].includes(k))continue;if(Array.isArray(v))for(const item of v)headers.append(k,item);else if(v!==undefined)headers.set(k,v);}
          response=await instance.handler(new Request(origin+url.pathname+url.search,{method:req.method,headers,...(body.length?{body}: {})}));}
      }
    }
  } catch(error) {response=json({error:error.status&&error.status<500?error.message:'Request failed'},error.status||500);if(!error.status)console.error('Request failed:',error.name);}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Robots-Tag','noindex, nofollow');
  if(req.url?.startsWith('/admin'))res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
});
server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT||3090),process.env.HOST||'127.0.0.1',()=>console.log('Chilli Consent listening on port '+(process.env.PORT||3090)));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(sweep);server.close(async()=>{for(const instance of instances.values())await instance.dispose();registry.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
