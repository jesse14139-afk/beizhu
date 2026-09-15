# -*- coding: utf-8 -*-
"""聚宝盆 V200 中心同步服务（标准库实现）。"""
from __future__ import annotations
import argparse, csv, hashlib, hmac, io, json, os, re, secrets, sys, uuid
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from V200_shared_db import Database, now_ms, dumps, loads
import V200_v134_compat as compat

VERSION="200.1.0"; WORKSPACE="default"
BASE=Path(__file__).resolve().parent
DB=Database(os.environ.get("JUBO_DB",str(BASE/"data"/"jubo_v200.sqlite")))
TOKEN=os.environ.get("JUBO_TOKEN","")
HOST=os.environ.get("JUBO_HOST","127.0.0.1"); PORT=int(os.environ.get("JUBO_PORT","8765"))
OBSERVED={"displayName":"display_name","observedPhone":"observed_phone","avatarUrl":"avatar_url","observed":"observed_json"}
MANUAL={"manualName":"manual_name","manualPhone":"manual_phone","remark":"remark","status":"status","business":"business_json"}

def uid(prefix): return prefix+"_"+uuid.uuid4().hex
def hash_obj(v): return hashlib.sha256(dumps(v).encode()).hexdigest()
TRANSIENT_OBS={"capturedAt","scanAt","observedAt","requestId","sessionTimestamp","timestamp"}
def stable_observed(v):
    """递归移除扫描时间等瞬态字段，避免旧客户端制造版本风暴。"""
    if isinstance(v,dict): return {k:stable_observed(x) for k,x in sorted(v.items()) if k not in TRANSIENT_OBS}
    if isinstance(v,list): return [stable_observed(x) for x in v]
    return v
def public_contact(row,c):
    d=dict(row); d["observed"]=loads(d.pop("observed_json"),{}) or {}; d["business"]=loads(d.pop("business_json"),{}) or {}
    d["tags"]=[dict(x) for x in c.execute("SELECT t.* FROM tags t JOIN contact_tags ct ON t.tag_id=ct.tag_id WHERE ct.contact_id=? ORDER BY t.sort_order,t.name",(d["contact_id"],))]
    d["customer_ids"]=[x[0] for x in c.execute("SELECT customer_id FROM customer_contacts WHERE contact_id=?",(d["contact_id"],))]
    d["customFields"]={x["field_key"]:loads(x["value_json"],None) for x in c.execute("SELECT field_key,value_json FROM contact_custom_values WHERE contact_id=?",(d["contact_id"],))}
    return d
def public_customer(c,cid):
    r=c.execute("SELECT * FROM customers WHERE customer_id=?",(cid,)).fetchone()
    if not r:return None
    d=dict(r); d["business"]=loads(d.pop("business_json"),{}) or {}; d["contact_ids"]=[x[0] for x in c.execute("SELECT contact_id FROM customer_contacts WHERE customer_id=?",(cid,))]; return d
def add_change(c,typ,eid,op,version,source,payload):
    c.execute("INSERT INTO changes(workspace_id,entity_type,entity_id,operation,version,source_id,changed_at,payload_json) VALUES(?,?,?,?,?,?,?,?)",(WORKSPACE,typ,eid,op,version,source,now_ms(),dumps(payload)))
def add_audit(c,actor,device,op,typ,eid,before,after,reason=""):
    c.execute("INSERT INTO audit_logs(workspace_id,actor_type,actor_id,device_id,operation,entity_type,entity_id,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(WORKSPACE,"device",actor or device,device,op,typ,eid,dumps(before),dumps(after),reason,now_ms()))
def ensure_device(c,did,name=""):
    t=now_ms(); c.execute("INSERT INTO devices(device_id,workspace_id,device_name,first_seen_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at",(did,WORKSPACE,name or did,t,t))
def register_source(payload,did):
    channel=str(payload.get("channel") or "").lower(); identity=str(payload.get("accountIdentity") or "").strip()
    if channel not in {"whatsapp","instagram","facebook","messenger","telegram"} or not identity:return {"ok":False,"code":"INVALID_SOURCE","message":"渠道或账号身份无效"},400
    with DB.tx() as c:
        ensure_device(c,did,payload.get("deviceName",did)); t=now_ms()
        old=c.execute("SELECT source_id FROM sources WHERE workspace_id=? AND channel=? AND account_identity=?",(WORKSPACE,channel,identity)).fetchone(); sid=old[0] if old else uid("src")
        c.execute("INSERT INTO sources(source_id,workspace_id,channel,account_identity,source_name,status,first_seen_at,last_seen_at,last_device_id,metadata_json) VALUES(?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(workspace_id,channel,account_identity) DO UPDATE SET source_name=excluded.source_name,status='active',last_seen_at=excluded.last_seen_at,last_device_id=excluded.last_device_id,metadata_json=excluded.metadata_json",(sid,WORKSPACE,channel,identity,str(payload.get("sourceName") or identity)[:120],t,t,did,dumps(payload.get("metadata") or {})))
        return {"ok":True,"sourceId":sid,"channel":channel,"accountIdentity":identity},200
def event_error(code,message,status=400,extra=None):
    x={"ok":False,"code":code,"message":message}; x.update(extra or {}); return x,status
def apply_event(e):
    required=("eventId","deviceId","entityType","operation")
    if any(not e.get(x) for x in required):return event_error("INVALID_EVENT","缺少必填事件字段")
    eid=str(e["eventId"]); payload=e.get("payload") or {}; ph=hash_obj({"deviceId":e.get("deviceId"),"sourceId":e.get("sourceId"),"entityType":e.get("entityType"),"entityId":e.get("entityId"),"operation":e.get("operation"),"baseVersion":e.get("baseVersion"),"payload":payload})
    with DB.tx() as c:
        existing=c.execute("SELECT payload_hash,result_json FROM events WHERE event_id=?",(eid,)).fetchone()
        if existing:
            if existing["payload_hash"]!=ph:return event_error("EVENT_ID_REUSED","eventId 已被不同载荷使用",409)
            result=loads(existing["result_json"],{}) or {}; result["idempotentReplay"]=True; return result,int(result.pop("_http",200))
        ensure_device(c,str(e["deviceId"]),str(e.get("deviceName") or "")); t=now_ms()
        c.execute("INSERT INTO events(event_id,workspace_id,device_id,source_id,session_id,entity_type,entity_id,operation,base_version,payload_json,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'processing',?)",(eid,WORKSPACE,str(e["deviceId"]),e.get("sourceId"),e.get("sessionId"),e["entityType"],e.get("entityId"),e["operation"],e.get("baseVersion"),dumps(payload),ph,t))
        if e["entityType"]=="contact": result,status=apply_contact(c,e)
        elif e["entityType"]=="customer": result,status=apply_customer(c,e)
        else: result,status=event_error("UNSUPPORTED_ENTITY","不支持的实体类型")
        stored=dict(result); stored["_http"]=status
        c.execute("UPDATE events SET status=?,result_version=?,error_code=?,applied_at=?,result_json=? WHERE event_id=?",("applied" if result.get("ok") else "rejected",result.get("version"),result.get("code"),now_ms(),dumps(stored),eid))
        return result,status
def find_contact(c,e):
    if e.get("entityId"):return c.execute("SELECT * FROM contacts WHERE contact_id=? AND workspace_id=?",(e["entityId"],WORKSPACE)).fetchone()
    p=e.get("payload") or {}; return c.execute("SELECT * FROM contacts WHERE workspace_id=? AND source_id=? AND channel=? AND external_contact_id=?",(WORKSPACE,e.get("sourceId"),p.get("channel"),p.get("externalContactId"))).fetchone()
def apply_contact(c,e):
    op=e["operation"]; p=e.get("payload") or {}; device=str(e["deviceId"]); row=find_contact(c,e)
    if op=="contact.observe":
        if not e.get("sourceId") or not p.get("channel") or not p.get("externalContactId"):return event_error("INVALID_OBSERVATION","观察事件缺少来源、渠道或外部联系人 ID")
        src=c.execute("SELECT * FROM sources WHERE source_id=? AND status='active'",(e["sourceId"],)).fetchone()
        if not src:return event_error("SOURCE_NOT_FOUND","来源不存在或未启用",404)
        # 自动观察事件只接受观察字段，明确忽略人工字段。
        obs={k:(stable_observed(p.get(k)) if k=="observed" else p.get(k)) for k in OBSERVED if k in p}; oh=hash_obj(obs); t=now_ms()
        if not row:
            cid=uid("ct"); c.execute("INSERT INTO contacts(contact_id,workspace_id,source_id,channel,external_contact_id,display_name,observed_phone,avatar_url,created_at,updated_at,last_seen_at,observed_json,observation_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",(cid,WORKSPACE,e["sourceId"],p["channel"],str(p["externalContactId"]),str(p.get("displayName") or ""),str(p.get("observedPhone") or ""),str(p.get("avatarUrl") or ""),t,t,t,dumps(stable_observed(p.get("observed") or {})),oh)); version=1; action="create"
        else:
            cid=row["contact_id"]
            if row["observation_hash"]==oh:
                c.execute("UPDATE contacts SET last_seen_at=? WHERE contact_id=?",(t,cid)); return {"ok":True,"eventId":e["eventId"],"entityId":cid,"version":row["version"],"unchanged":True},200
            version=row["version"]+1; c.execute("UPDATE contacts SET display_name=?,observed_phone=?,avatar_url=?,observed_json=?,observation_hash=?,version=?,updated_at=?,last_seen_at=? WHERE contact_id=?",(str(p.get("displayName") or ""),str(p.get("observedPhone") or ""),str(p.get("avatarUrl") or ""),dumps(stable_observed(p.get("observed") or {})),oh,version,t,t,cid)); action="observe"
        current=c.execute("SELECT * FROM contacts WHERE contact_id=?",(cid,)).fetchone(); data=public_contact(current,c); add_change(c,"contact",cid,action,version,e["sourceId"],data); return {"ok":True,"eventId":e["eventId"],"entityId":cid,"version":version,"contact":data},200
    if not row:return event_error("CONTACT_NOT_FOUND","联系人不存在",404)
    before=public_contact(row,c); base=e.get("baseVersion")
    if base is None or int(base)!=row["version"]:return event_error("VERSION_CONFLICT","联系人版本冲突",409,{"currentVersion":row["version"],"current":before})
    cid=row["contact_id"]; t=now_ms()
    if op=="contact.patch":
        sets=[]; vals=[]
        for api,col in MANUAL.items():
            if api in p: sets.append(col+"=?"); vals.append(dumps(p[api] or {}) if col=="business_json" else str(p[api] or ""))
        custom=p.get("customFields") if isinstance(p.get("customFields"),dict) else {}
        if not sets and not custom:return event_error("EMPTY_PATCH","没有可修改的人工字段")
        for key,value in custom.items():
            key=str(key)[:80]
            if not re.fullmatch(r"[A-Za-z0-9_.:-]+",key):return event_error("INVALID_CUSTOM_FIELD","自定义字段键无效")
            c.execute("INSERT INTO contact_custom_values(contact_id,field_key,value_json,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(contact_id,field_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",(cid,key,dumps(value),t,device))
        version=row["version"]+1; sets += ["version=?","updated_at=?"]; vals += [version,t,cid]; c.execute("UPDATE contacts SET "+",".join(sets)+" WHERE contact_id=?",vals); action="patch"
    elif op=="contact.tags.set":
        tids=list(dict.fromkeys(p.get("tagIds") or [])); valid={x[0] for x in c.execute("SELECT tag_id FROM tags WHERE workspace_id=? AND enabled=1",(WORKSPACE,))}
        if any(x not in valid for x in tids):return event_error("TAG_NOT_FOUND","包含不存在的标签",404)
        c.execute("DELETE FROM contact_tags WHERE contact_id=?",(cid,)); c.executemany("INSERT INTO contact_tags VALUES(?,?,?)",[(cid,x,t) for x in tids]); version=row["version"]+1; c.execute("UPDATE contacts SET version=?,updated_at=? WHERE contact_id=?",(version,t,cid)); action="tags.set"
    elif op=="contact.delete":
        conf=str(p.get("confirmationId") or ""); cr=c.execute("SELECT * FROM delete_confirmations WHERE confirmation_id=? AND entity_id=?",(conf,cid)).fetchone()
        if not cr or cr["used_at"] is not None or cr["expires_at"]<t or cr["expected_version"]!=row["version"]:return event_error("INVALID_CONFIRMATION","删除确认凭证无效、过期或已使用",409)
        c.execute("UPDATE delete_confirmations SET used_at=? WHERE confirmation_id=?",(t,conf)); version=row["version"]+1; c.execute("UPDATE contacts SET deleted_at=?,deleted_by=?,delete_reason=?,version=?,updated_at=? WHERE contact_id=?",(t,device,str(p.get("reason") or ""),version,t,cid)); action="delete"
    elif op=="contact.restore":
        if row["deleted_at"] is None:return event_error("NOT_DELETED","联系人未被删除",409)
        version=row["version"]+1; c.execute("UPDATE contacts SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,version=?,updated_at=? WHERE contact_id=?",(version,t,cid)); action="restore"
    else:return event_error("UNSUPPORTED_OPERATION","不支持的联系人操作")
    after=public_contact(c.execute("SELECT * FROM contacts WHERE contact_id=?",(cid,)).fetchone(),c); add_change(c,"contact",cid,action,version,row["source_id"],after); add_audit(c,device,device,action,"contact",cid,before,after,str(p.get("reason") or "")); return {"ok":True,"eventId":e["eventId"],"entityId":cid,"version":version,"contact":after},200
def apply_customer(c,e):
    op=e["operation"]; p=e.get("payload") or {}; device=str(e["deviceId"]); cid=str(e.get("entityId") or p.get("customerId") or "")
    if op=="customer.create":
        cid=cid or uid("cus"); t=now_ms(); c.execute("INSERT INTO customers(customer_id,workspace_id,display_name,primary_phone,created_at,updated_at,business_json) VALUES(?,?,?,?,?,?,?)",(cid,WORKSPACE,str(p.get("displayName") or ""),str(p.get("primaryPhone") or ""),t,t,dumps(p.get("business") or {}))); data=public_customer(c,cid); add_change(c,"customer",cid,"create",1,None,data); add_audit(c,device,device,"create","customer",cid,{},data); return {"ok":True,"eventId":e["eventId"],"entityId":cid,"version":1,"customer":data},201
    row=c.execute("SELECT * FROM customers WHERE customer_id=? AND deleted_at IS NULL",(cid,)).fetchone()
    if not row:return event_error("CUSTOMER_NOT_FOUND","主客户不存在",404)
    if e.get("baseVersion") is None or int(e["baseVersion"])!=row["version"]:return event_error("VERSION_CONFLICT","主客户版本冲突",409,{"currentVersion":row["version"]})
    before=public_customer(c,cid); t=now_ms()
    if op=="customer.patch":
        name=str(p.get("displayName",row["display_name"])); phone=str(p.get("primaryPhone",row["primary_phone"])); business=dumps(p.get("business",loads(row["business_json"],{}))); action="patch"
        c.execute("UPDATE customers SET display_name=?,primary_phone=?,business_json=?,version=version+1,updated_at=? WHERE customer_id=?",(name,phone,business,t,cid))
    elif op in ("customer.link","customer.unlink"):
        contact=str(p.get("contactId") or "")
        if not c.execute("SELECT 1 FROM contacts WHERE contact_id=?",(contact,)).fetchone():return event_error("CONTACT_NOT_FOUND","联系人不存在",404)
        if op.endswith("link") and op!="customer.unlink":c.execute("INSERT OR REPLACE INTO customer_contacts VALUES(?,?,?,?,?,?)",(cid,contact,"manual",1,device,t)); action="link"
        else:c.execute("DELETE FROM customer_contacts WHERE customer_id=? AND contact_id=?",(cid,contact)); action="unlink"
        c.execute("UPDATE customers SET version=version+1,updated_at=? WHERE customer_id=?",(t,cid))
    else:return event_error("UNSUPPORTED_OPERATION","不支持的主客户操作")
    row=c.execute("SELECT * FROM customers WHERE customer_id=?",(cid,)).fetchone(); data=public_customer(c,cid); add_change(c,"customer",cid,action,row["version"],None,data); add_audit(c,device,device,action,"customer",cid,before,data); return {"ok":True,"eventId":e["eventId"],"entityId":cid,"version":row["version"],"customer":data},200
def legacy_admin_update(payload,device):
    """把 V134 单联系人覆盖编辑转换为 V200 contact.patch；不接受快照。"""
    cid=str(payload.get("contactId") or ""); sid=str(payload.get("sourceId") or ""); fields=payload.get("fields") or {}
    if not cid or not isinstance(fields,dict):return event_error("INVALID_LEGACY_UPDATE","联系人或 fields 无效")
    with DB.tx(False) as c: row=c.execute("SELECT * FROM contacts WHERE contact_id=? AND workspace_id=?",(cid,WORKSPACE)).fetchone()
    if not row or (sid and row["source_id"]!=sid):return event_error("CONTACT_NOT_FOUND","联系人不存在",404)
    direct={"name":"manualName","manualName":"manualName","phone":"manualPhone","manualPhone":"manualPhone","remark":"remark","status":"status"}
    patch={}; custom={}; business={}
    for k,v in fields.items():
        if k in direct:patch[direct[k]]=v
        elif k in ("business",) and isinstance(v,dict):business.update(v)
        else:custom[str(k)]=v
    if business:patch["business"]=business
    if custom:patch["customFields"]=custom
    event={"eventId":uid("evt"),"deviceId":device,"sourceId":row["source_id"],"entityType":"contact","entityId":cid,"operation":"contact.patch","baseVersion":row["version"],"payload":patch}
    result,status=apply_event(event)
    if result.get("ok"): result={"ok":True,"data":result,"contact":result.get("contact"),"version":result.get("version")}
    return result,status

def delete_preview(cid,actor):
    with DB.tx() as c:
        r=c.execute("SELECT * FROM contacts WHERE contact_id=? AND workspace_id=?",(cid,WORKSPACE)).fetchone()
        if not r:return event_error("CONTACT_NOT_FOUND","联系人不存在",404)
        d=public_contact(r,c); impact={"contactId":cid,"displayName":d["manual_name"] or d["display_name"],"sourceId":d["source_id"],"phone":d["manual_phone"] or d["observed_phone"],"tagCount":len(d["tags"]),"customerCount":len(d["customer_ids"]),"version":d["version"]}; conf=uid("confirm"); exp=now_ms()+120000
        c.execute("INSERT INTO delete_confirmations VALUES(?,?,?,?,?,?,?,?,?)",(conf,WORKSPACE,"contact",cid,d["version"],hash_obj(impact),exp,None,actor or "unknown")); return {"ok":True,"confirmationId":conf,"expiresAt":exp,"impact":impact},200
def get_stats(c):
    one=lambda sql,args=():c.execute(sql,args).fetchone()[0]
    return {"contacts":one("SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND deleted_at IS NULL",(WORKSPACE,)),"customers":one("SELECT COUNT(*) FROM customers WHERE workspace_id=? AND deleted_at IS NULL",(WORKSPACE,)),"sources":one("SELECT COUNT(*) FROM sources WHERE workspace_id=? AND status='active'",(WORKSPACE,)),"devices":one("SELECT COUNT(*) FROM devices WHERE workspace_id=? AND enabled=1",(WORKSPACE,)),"deleted":one("SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND deleted_at IS NOT NULL",(WORKSPACE,)),"changeCursor":one("SELECT COALESCE(MAX(change_id),0) FROM changes WHERE workspace_id=?",(WORKSPACE,))}
def query_contacts(qs,trash=False):
    where=["workspace_id=?",("deleted_at IS NOT NULL" if trash else "deleted_at IS NULL")]; args=[WORKSPACE]
    for key,col in (("sourceId","source_id"),("channel","channel")):
        if qs.get(key):where.append(col+"=?");args.append(qs[key][0])
    if qs.get("q"): x="%"+qs["q"][0]+"%"; where.append("(display_name LIKE ? OR manual_name LIKE ? OR observed_phone LIKE ? OR manual_phone LIKE ? OR remark LIKE ?)"); args += [x]*5
    limit=min(max(int(qs.get("limit",["500"])[0]),1),2000); offset=max(int(qs.get("offset",["0"])[0]),0)
    with DB.tx(False) as c:
        rows=c.execute("SELECT * FROM contacts WHERE "+" AND ".join(where)+" ORDER BY updated_at DESC LIMIT ? OFFSET ?",args+[limit,offset]).fetchall(); total=c.execute("SELECT COUNT(*) FROM contacts WHERE "+" AND ".join(where),args).fetchone()[0]; return {"ok":True,"total":total,"contacts":[public_contact(x,c) for x in rows]}
def create_tag(p):
    name=str(p.get("name") or "").strip()
    if not name:return event_error("INVALID_TAG","标签名必填")
    try:
        with DB.tx() as c:
            tid=uid("tag"); t=now_ms(); c.execute("INSERT INTO tags VALUES(?,?,?,?,?,?,?,?,?)",(tid,WORKSPACE,name,str(p.get("color") or "#64748b"),str(p.get("category") or ""),int(p.get("sortOrder") or 0),1,t,t)); d=dict(c.execute("SELECT * FROM tags WHERE tag_id=?",(tid,)).fetchone()); add_change(c,"tag",tid,"create",1,None,d); return {"ok":True,"tag":d},201
    except Exception:return event_error("TAG_EXISTS","标签名称已存在",409)
def make_backup():
    target,digest=DB.backup(BASE/"data"/"backups"); bid=uid("backup")
    with DB.tx() as c:c.execute("INSERT INTO backup_records VALUES(?,?,?,?,?,?)",(bid,target.name,now_ms(),target.stat().st_size,digest,"ok"))
    return {"ok":True,"backupId":bid,"fileName":target.name,"sizeBytes":target.stat().st_size,"sha256":digest}
def csv_export():
    d=query_contacts({"limit":["2000"]})["contacts"]; out=io.StringIO(); w=csv.writer(out); w.writerow(["contact_id","source_id","channel","external_contact_id","name","phone","remark","status","version","updated_at"])
    for x in d:w.writerow([x["contact_id"],x["source_id"],x["channel"],x["external_contact_id"],x["manual_name"] or x["display_name"],x["manual_phone"] or x["observed_phone"],x["remark"],x["status"],x["version"],x["updated_at"]])
    return "\ufeff"+out.getvalue()
class Handler(BaseHTTPRequestHandler):
    server_version="JuboV200/200"
    def log_message(self,fmt,*args): sys.stdout.write("%s %s\n"%(self.log_date_time_string(),fmt%args))
    def auth(self):
        if not TOKEN:return True
        got=self.headers.get("X-Auth-Token",""); return hmac.compare_digest(got,TOKEN)
    def body(self):
        n=int(self.headers.get("Content-Length","0") or 0)
        if n>5_000_000:raise ValueError("请求体过大")
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
    def send_json(self,obj,status=200):
        b=dumps(obj).encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(b)
    def send_bytes(self,b,ctype,status=200,filename=None):
        self.send_response(status); self.send_header("Content-Type",ctype); self.send_header("Content-Length",str(len(b))); 
        if filename:self.send_header("Content-Disposition",'attachment; filename="'+filename+'"')
        self.end_headers(); self.wfile.write(b)
    def route(self):
        u=urlparse(self.path); path=u.path; qs=parse_qs(u.query); method=self.command
        if path in ("/","/dashboard","/dashboard/") and method=="GET":return self.send_bytes((BASE/"dashboard.html").read_bytes(),"text/html; charset=utf-8")
        if not path.startswith("/api/"):return self.send_json({"ok":False,"code":"NOT_FOUND"},404)
        if not self.auth():return self.send_json({"ok":False,"code":"UNAUTHORIZED","message":"Token 无效"},401)
        if path=="/api/health" and method=="GET":
            with DB.tx(False) as c:return self.send_json({"ok":True,"version":VERSION,"database":DB.quick_check(),"stats":get_stats(c)})
        # V134 像素级界面的只读兼容协议和带 revision 的共享配置。
        if path=="/api/sources" and method=="GET":return self.send_json(compat.get_sources(DB))
        if path=="/api/stats" and method=="GET":return self.send_json(compat.get_stats(DB))
        if path=="/api/contacts" and method=="GET":return self.send_json(compat.get_contacts(DB,qs))
        if path=="/api/shared-config" and method=="GET":return self.send_json(compat.get_config(DB))
        if path in ("/api/shared-config/update","/api/shared-config/initialize") and method=="POST":
            r,st=compat.update_config(DB,self.body(),self.headers.get("X-Device-Id","v134"));return self.send_json(r,st)
        if path=="/api/v133/admin/contacts/update" and method=="POST":
            r,st=legacy_admin_update(self.body(),self.headers.get("X-Device-Id","v134-admin"));return self.send_json(r,st)
        if path=="/api/v133/admin/contacts/delete" and method=="POST":
            return self.send_json({"ok":False,"code":"DELETE_PREVIEW_REQUIRED","message":"请由 V200 适配器先获取删除确认凭证"},409)
        if path in compat.DISABLED_WRITES and method in ("POST","PATCH","DELETE"):
            r,st=compat.disabled(path);return self.send_json(r,st)
        if path=="/api/v200/sources/register" and method=="POST":r,s=register_source(self.body(),self.headers.get("X-Device-Id","api"));return self.send_json(r,s)
        if path=="/api/v200/events" and method=="POST":r,s=apply_event(self.body());return self.send_json(r,s)
        if path=="/api/v200/events/batch" and method=="POST":
            results=[]
            for e in self.body().get("events",[]): r,s=apply_event(e); r["httpStatus"]=s; results.append(r)
            return self.send_json({"ok":True,"results":results})
        if path=="/api/v200/changes" and method=="GET":
            after=max(0,int(qs.get("after",["0"])[0])); limit=min(int(qs.get("limit",["500"])[0]),2000)
            with DB.tx(False) as c:
                rows=c.execute("SELECT * FROM changes WHERE workspace_id=? AND change_id>? ORDER BY change_id LIMIT ?",(WORKSPACE,after,limit)).fetchall(); changes=[]
                for x in rows:d=dict(x);d["payload"]=loads(d.pop("payload_json"),{});changes.append(d)
                cursor=changes[-1]["change_id"] if changes else after; return self.send_json({"ok":True,"after":after,"cursor":cursor,"changes":changes})
        if path=="/api/v200/contacts" and method=="GET":return self.send_json(query_contacts(qs))
        if path=="/api/v200/trash" and method=="GET":return self.send_json(query_contacts(qs,True))
        m=re.fullmatch(r"/api/v200/contacts/([^/]+)/delete-preview",path)
        if m and method=="POST":r,s=delete_preview(m.group(1),self.headers.get("X-Device-Id","api"));return self.send_json(r,s)
        m=re.fullmatch(r"/api/v200/contacts/([^/]+)",path)
        if m and method in ("PATCH","DELETE"):
            b=self.body(); op="contact.patch" if method=="PATCH" else "contact.delete"; e={"eventId":b.pop("eventId",uid("evt")),"deviceId":b.pop("deviceId",self.headers.get("X-Device-Id","api")),"entityType":"contact","entityId":m.group(1),"operation":op,"baseVersion":b.pop("baseVersion",None),"payload":b}; r,s=apply_event(e);return self.send_json(r,s)
        m=re.fullmatch(r"/api/v200/contacts/([^/]+)/restore",path)
        if m and method=="POST":
            b=self.body();e={"eventId":b.pop("eventId",uid("evt")),"deviceId":b.pop("deviceId",self.headers.get("X-Device-Id","api")),"entityType":"contact","entityId":m.group(1),"operation":"contact.restore","baseVersion":b.pop("baseVersion",None),"payload":b};r,st=apply_event(e);return self.send_json(r,st)
        if path=="/api/v200/tags" and method=="GET":
            with DB.tx(False) as c:return self.send_json({"ok":True,"tags":[dict(x) for x in c.execute("SELECT * FROM tags WHERE workspace_id=? ORDER BY sort_order,name",(WORKSPACE,))]})
        if path=="/api/v200/tags" and method=="POST":r,s=create_tag(self.body());return self.send_json(r,s)
        if path=="/api/v200/customers" and method=="GET":
            with DB.tx(False) as c:return self.send_json({"ok":True,"customers":[public_customer(c,x[0]) for x in c.execute("SELECT customer_id FROM customers WHERE workspace_id=? AND deleted_at IS NULL ORDER BY updated_at DESC",(WORKSPACE,))]})
        if path=="/api/v200/customers" and method=="POST":
            b=self.body(); e={"eventId":b.pop("eventId",uid("evt")),"deviceId":b.pop("deviceId","api"),"entityType":"customer","operation":"customer.create","payload":b};r,s=apply_event(e);return self.send_json(r,s)
        if path=="/api/v200/audit" and method=="GET":
            with DB.tx(False) as c:
                rows=[]
                for x in c.execute("SELECT * FROM audit_logs WHERE workspace_id=? ORDER BY audit_id DESC LIMIT 1000",(WORKSPACE,)):d=dict(x);d["before"]=loads(d.pop("before_json"),{});d["after"]=loads(d.pop("after_json"),{});rows.append(d)
                return self.send_json({"ok":True,"audit":rows})
        if path=="/api/v200/backup" and method=="POST":return self.send_json(make_backup(),201)
        if path=="/api/v200/backups" and method=="GET":
            with DB.tx(False) as c:return self.send_json({"ok":True,"backups":[dict(x) for x in c.execute("SELECT * FROM backup_records ORDER BY created_at DESC")]})
        if path=="/api/v200/export/json" and method=="GET":return self.send_json(query_contacts({"limit":["2000"]}))
        if path=="/api/v200/export/csv" and method=="GET":return self.send_bytes(csv_export().encode("utf-8"),"text/csv; charset=utf-8",filename="jubo_v200_contacts.csv")
        return self.send_json({"ok":False,"code":"NOT_FOUND","message":"接口不存在"},404)
    def do_GET(self):
        try:self.route()
        except Exception as e:self.send_json({"ok":False,"code":"INTERNAL_ERROR","message":str(e)},500)
    do_POST=do_GET; do_PATCH=do_GET; do_DELETE=do_GET

def main():
    global HOST,PORT,TOKEN,DB
    ap=argparse.ArgumentParser(); ap.add_argument("--host",default=HOST);ap.add_argument("--port",type=int,default=PORT);ap.add_argument("--token",default=TOKEN);ap.add_argument("--db",default=str(DB.path));a=ap.parse_args();HOST=a.host;PORT=a.port;TOKEN=a.token;DB=Database(a.db);DB.init()
    if HOST not in ("127.0.0.1","localhost","::1") and not TOKEN:raise SystemExit("非本机监听必须配置 --token 或 JUBO_TOKEN")
    print("聚宝盆 V200: http://%s:%s  DB=%s"%(HOST,PORT,DB.path)); ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
if __name__=="__main__":main()
