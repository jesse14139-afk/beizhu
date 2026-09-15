// ==UserScript==
// @name         聚宝盆 V200.1 多平台联系人采集器
// @namespace    jubo-v200
// @version      200.1.0
// @description  稳定来源、稳定观察指纹、冲突/死信隔离
// @match        https://web.whatsapp.com/*
// @match        https://www.instagram.com/*
// @match        https://www.facebook.com/*
// @match        https://web.telegram.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==
(function(){'use strict';
const KEY='jubo_v201_config',OUT='jubo_v201_outbox',CONFLICT='jubo_v201_conflicts',DEAD='jubo_v201_deadletter';
const C=JSON.parse(localStorage.getItem(KEY)||'{}');C.server=C.server||'http://127.0.0.1:8765';C.deviceId=C.deviceId||('browser-'+crypto.randomUUID());localStorage.setItem(KEY,JSON.stringify(C));
const channel=location.host.includes('whatsapp')?'whatsapp':location.host.includes('instagram')?'instagram':location.host.includes('telegram')?'telegram':'facebook';let sourceId='',flushing=false;
function save(){localStorage.setItem(KEY,JSON.stringify(C))}function list(k){try{return JSON.parse(localStorage.getItem(k)||'[]')}catch{return []}}function put(k,v){localStorage.setItem(k,JSON.stringify(v.slice(-5000)))}
function req(method,path,body){return new Promise((ok,fail)=>GM_xmlhttpRequest({method,url:C.server+path,headers:{'Content-Type':'application/json','X-Auth-Token':C.token||'','X-Device-Id':C.deviceId},data:body?JSON.stringify(body):null,timeout:10000,onload:r=>{let x;try{x=JSON.parse(r.responseText)}catch{x={message:r.responseText}}r.status<300?ok(x):fail(Object.assign(Error(x.message||String(r.status)),{status:r.status,data:x}))},onerror:fail,ontimeout:()=>fail(Error('timeout'))}))}
function queue(e){let q=list(OUT);if(!q.some(x=>x.eventId===e.eventId))q.push(e);put(OUT,q);flush()}
async function flush(){if(flushing)return;flushing=true;let q=list(OUT);try{while(q.length){let batch=q.slice(0,50),r=await req('POST','/api/v200/events/batch',{events:batch}),done=new Set();for(const x of r.results||[]){if(x.ok)done.add(x.eventId);else if(x.code==='VERSION_CONFLICT'){let a=list(CONFLICT);a.push(x);put(CONFLICT,a);done.add(x.eventId)}else if(['EVENT_ID_REUSED','INVALID_EVENT','INVALID_OBSERVATION','SOURCE_NOT_FOUND'].includes(x.code)){let a=list(DEAD);a.push(x);put(DEAD,a);done.add(x.eventId)}}q=q.filter(x=>!done.has(x.eventId));put(OUT,q);if(!done.size)break}}catch(e){}finally{flushing=false;setTimeout(flush,Math.min(60000,2000+list(OUT).length*200))}}
function configure(){C.server=prompt('中心服务地址',C.server)||C.server;C.token=prompt('Token',C.token||'')||'';C.accounts=C.accounts||{};let old=C.accounts[channel]||{};let id=prompt('稳定账号标识（不能填写当前聊天对象）',old.identity||'');if(id)C.accounts[channel]={identity:id.trim(),name:(prompt('来源显示名称',old.name||id)||id).trim()};save();location.reload()}
function account(){return C.accounts&&C.accounts[channel]}async function register(){let a=account();if(!a||!a.identity)throw Error('请先通过油猴菜单配置稳定账号标识');let r=await req('POST','/api/v200/sources/register',{channel,accountIdentity:a.identity,sourceName:a.name||a.identity,deviceName:navigator.userAgent.slice(0,80),metadata:{origin:location.origin}});sourceId=r.sourceId}
function cleanUrl(raw){try{let u=new URL(raw,location.origin);u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid|session|timestamp|ts|ref)/i.test(k))u.searchParams.delete(k);return u.origin+u.pathname+(u.searchParams.toString()?'?'+u.searchParams:'')}catch{return ''}}
function enc(s){return btoa(unescape(encodeURIComponent(s))).replace(/=+$/,'').slice(0,160)}
function candidate(el){let name=(el.querySelector('[title]')?.getAttribute('title')||el.querySelector('span,div')?.textContent||'').trim().replace(/\s+/g,' ').slice(0,120);if(!name)return null;let link=cleanUrl(el.closest('a')?.href||el.querySelector('a')?.href||'');let peer=el.getAttribute('data-peer-id')||el.dataset?.peerId||'';let key=peer||link;if(!key)return null;return {externalContactId:channel+':'+enc(key),channel,displayName:name,avatarUrl:el.querySelector('img')?.src||'',observed:{pageUrl:link,identityQuality:peer?'strong':'medium'}}}
const selectors={whatsapp:'[role=listitem], [data-testid=cell-frame-container]',instagram:'a[href^="/direct/t/"]',facebook:'a[href*="/messages/t/"]',telegram:'.chatlist-chat, .ListItem'};const seen=new Map();
function stable(x){return JSON.stringify([x.externalContactId,x.displayName,x.avatarUrl,x.observed.pageUrl,x.observed.identityQuality])}function scan(){if(!sourceId)return;document.querySelectorAll(selectors[channel]).forEach(el=>{let x=candidate(el);if(!x)return;let sig=stable(x);if(seen.get(x.externalContactId)===sig)return;seen.set(x.externalContactId,sig);queue({eventId:crypto.randomUUID(),deviceId:C.deviceId,sourceId,entityType:'contact',operation:'contact.observe',payload:x})})}
GM_registerMenuCommand('聚宝盆 V200.1 配置来源',configure);GM_registerMenuCommand('查看队列状态',()=>alert(`待提交 ${list(OUT).length}\n冲突 ${list(CONFLICT).length}\n死信 ${list(DEAD).length}`));
(async()=>{try{await register();scan();let timer=0;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(scan,700)}).observe(document.documentElement,{subtree:true,childList:true});setInterval(scan,15000);flush()}catch(e){console.error('[聚宝盆 V200.1]',e);alert('聚宝盆采集器：'+e.message)}})();})();
