// ==UserScript==
// @name         聚宝盆 V200 多平台联系人采集器
// @namespace    jubo-v200
// @version      200.0.0
// @description  WhatsApp / Instagram / Facebook Messenger / Telegram 增量事件采集
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
const C=JSON.parse(localStorage.jubo_v200_config||'{}');C.server=C.server||'http://127.0.0.1:8765';C.deviceId=C.deviceId||('browser-'+crypto.randomUUID());localStorage.jubo_v200_config=JSON.stringify(C);
const channel=location.host.includes('whatsapp')?'whatsapp':location.host.includes('instagram')?'instagram':location.host.includes('telegram')?'telegram':'facebook';
const OUT='jubo_v200_outbox';let sourceId='';function save(c){localStorage.jubo_v200_config=JSON.stringify(c)}function req(method,path,body){return new Promise((ok,fail)=>GM_xmlhttpRequest({method,url:C.server+path,headers:{'Content-Type':'application/json','X-Auth-Token':C.token||'','X-Device-Id':C.deviceId},data:body?JSON.stringify(body):null,onload:r=>{let x;try{x=JSON.parse(r.responseText)}catch{x={message:r.responseText}}r.status<300?ok(x):fail(Object.assign(Error(x.message||r.status),{status:r.status,data:x}))},onerror:fail}))}
function queue(e){let q=JSON.parse(localStorage[OUT]||'[]');if(!q.some(x=>x.eventId===e.eventId))q.push(e);localStorage[OUT]=JSON.stringify(q.slice(-5000));flush()}
async function flush(){let q=JSON.parse(localStorage[OUT]||'[]');if(!q.length)return;try{let r=await req('POST','/api/v200/events/batch',{events:q.slice(0,50)});let accepted=new Set(r.results.filter(x=>x.ok||x.code==='VERSION_CONFLICT'||x.code==='EVENT_ID_REUSED').map(x=>x.eventId));q=q.filter(x=>!accepted.has(x.eventId));localStorage[OUT]=JSON.stringify(q)}catch{}finally{setTimeout(flush,Math.min(60000,2000+q.length*200))}}
function identity(){return location.host+':'+(document.querySelector('header [title],header h1,header h2')?.textContent?.trim()||'default')}
async function register(){let r=await req('POST','/api/v200/sources/register',{channel,accountIdentity:identity(),sourceName:identity(),deviceName:navigator.userAgent.slice(0,80),metadata:{url:location.origin}});sourceId=r.sourceId}
function candidate(el){let name=(el.querySelector('[title]')?.getAttribute('title')||el.querySelector('span,div')?.textContent||'').trim().slice(0,120);if(!name||name.length>120)return null;let link=el.closest('a')?.href||el.querySelector('a')?.href||'';let key=link||el.getAttribute('data-peer-id')||el.getAttribute('data-testid')||name;if(key.length<2)return null;return {externalContactId:channel+':'+btoa(unescape(encodeURIComponent(key))).slice(0,120),channel,displayName:name,avatarUrl:el.querySelector('img')?.src||'',observed:{pageUrl:link||location.href,capturedAt:Date.now()}}}
const selectors={whatsapp:'[role=listitem], [data-testid=cell-frame-container]',instagram:'a[href^="/direct/t/"]',facebook:'a[href*="/messages/t/"]',telegram:'.chatlist-chat, .ListItem'};
let seen=new Map();function scan(){if(!sourceId)return;document.querySelectorAll(selectors[channel]).forEach(el=>{let x=candidate(el);if(!x)return;let sig=JSON.stringify(x);if(seen.get(x.externalContactId)===sig)return;seen.set(x.externalContactId,sig);queue({eventId:crypto.randomUUID(),deviceId:C.deviceId,sourceId,entityType:'contact',operation:'contact.observe',payload:x})})}
GM_registerMenuCommand('聚宝盆 V200 配置',()=>{C.server=prompt('中心服务地址',C.server)||C.server;C.token=prompt('Token（本机可留空）',C.token||'')||'';save(C);location.reload()});
(async()=>{try{await register();scan();new MutationObserver(()=>clearTimeout(window.__juboTimer)||(window.__juboTimer=setTimeout(()=>{window.__juboTimer=0;scan()},700))).observe(document.documentElement,{subtree:true,childList:true});setInterval(scan,15000);flush()}catch(e){console.error('[聚宝盆 V200]',e)}})();})();
