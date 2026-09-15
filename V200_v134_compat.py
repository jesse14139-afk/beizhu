# -*- coding: utf-8 -*-
"""V134 响应兼容层。读取 V200 唯一事实源；危险快照写入永不恢复。"""
from V200_shared_db import now_ms, dumps, loads
WORKSPACE="default"
DISABLED_WRITES={
 "/api/contacts/batch-upsert","/api/contacts/batch-delete","/api/contacts/delete",
 "/api/contacts/full-sync-clean","/api/contacts/reconcile","/api/contacts/source-reconcile",
 "/api/contacts/override","/api/contacts/override-delete","/api/contacts/override/delete",
 "/api/v129/sync/snapshot","/api/v130/sync/snapshot","/api/v133/sync/snapshot"
}
def source_item(r):
 d=dict(r); return {"sourceId":d["source_id"],"id":d["source_id"],"sourceName":d["source_name"],"name":d["source_name"],"channel":d["channel"],"accountIdentity":d["account_identity"],"lastSeenAt":d["last_seen_at"],"status":d["status"]}
def contact_item(row,tags,custom):
 d=dict(row); business=loads(d.get("business_json"),{}) or {}; observed=loads(d.get("observed_json"),{}) or {}
 name=d.get("manual_name") or d.get("display_name") or ""; phone=d.get("manual_phone") or d.get("observed_phone") or ""
 payload={"id":d["contact_id"],"contactId":d["contact_id"],"_localKey":d["contact_id"],"sourceId":d["source_id"],"channel":d["channel"],"externalContactId":d["external_contact_id"],"name":name,"displayName":name,"phone":phone,"avatar":d.get("avatar_url",''),"avatarUrl":d.get("avatar_url",''),"remark":d.get("remark",''),"status":d.get("status",''),"version":d["version"],"updatedAt":d["updated_at"],"lastSeenAt":d["last_seen_at"],"tags":[x.get("name",'') for x in tags],"tagObjects":tags,"business":business,"observed":observed}
 payload.update(business); payload.update(custom)
 return {"id":d["contact_id"],"contactId":d["contact_id"],"sourceId":d["source_id"],"sourceName":"","updatedAt":d["updated_at"],"data":payload,"payload":payload,"contact":payload}
def get_sources(db):
 with db.tx(False) as c:return {"ok":True,"items":[source_item(x) for x in c.execute("SELECT * FROM sources WHERE workspace_id=? ORDER BY source_name",(WORKSPACE,))]}
def get_stats(db):
 with db.tx(False) as c:
  one=lambda q,a=():c.execute(q,a).fetchone()[0]
  total=one("SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND deleted_at IS NULL",(WORKSPACE,)); sources=one("SELECT COUNT(*) FROM sources WHERE workspace_id=? AND status='active'",(WORKSPACE,))
  return {"ok":True,"totalContacts":total,"totalSources":sources,"deletedContacts":one("SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND deleted_at IS NOT NULL",(WORKSPACE,)),"updatedAt":now_ms()}
def get_contacts(db,qs):
 source=(qs.get("sourceId") or [None])[0]; where="c.workspace_id=? AND c.deleted_at IS NULL"; args=[WORKSPACE]
 if source:where+=" AND c.source_id=?";args.append(source)
 limit=min(max(int((qs.get('limit') or ['2000'])[0]),1),5000)
 with db.tx(False) as c:
  rows=c.execute("SELECT c.*,s.source_name FROM contacts c LEFT JOIN sources s ON s.source_id=c.source_id WHERE "+where+" ORDER BY c.updated_at DESC LIMIT ?",args+[limit]).fetchall(); items=[]
  for r in rows:
   tags=[dict(x) for x in c.execute("SELECT t.* FROM tags t JOIN contact_tags ct ON t.tag_id=ct.tag_id WHERE ct.contact_id=? ORDER BY t.sort_order,t.name",(r['contact_id'],))]
   custom={x['field_key']:loads(x['value_json'],None) for x in c.execute("SELECT field_key,value_json FROM contact_custom_values WHERE contact_id=?",(r['contact_id'],))}
   item=contact_item(r,tags,custom);item['sourceName']=r['source_name'] or '';items.append(item)
  return {"ok":True,"items":items,"count":len(items),"total":len(items)}
def get_config(db):
 with db.tx(False) as c:r=c.execute("SELECT * FROM workspace_configs WHERE workspace_id=?",(WORKSPACE,)).fetchone();return {"ok":True,"workspaceId":WORKSPACE,"revision":r['revision'] if r else 0,"items":loads(r['items_json'],[]) if r else [],"updatedAt":r['updated_at'] if r else 0}
def update_config(db,payload,actor):
 base=int(payload.get('baseRevision',0)); items=payload.get('items') or []
 if not isinstance(items,list):return {"ok":False,"code":"INVALID_CONFIG","message":"items 必须是数组"},400
 with db.tx() as c:
  r=c.execute("SELECT * FROM workspace_configs WHERE workspace_id=?",(WORKSPACE,)).fetchone(); current=r['revision'] if r else 0
  if base!=current:return {"ok":False,"code":"REVISION_CONFLICT","message":"公共配置版本冲突","current":{"workspaceId":WORKSPACE,"revision":current,"items":loads(r['items_json'],[]) if r else []}},409
  rev=current+1;t=now_ms();c.execute("INSERT INTO workspace_configs VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",(WORKSPACE,rev,dumps(items),t,actor))
  return {"ok":True,"workspaceId":WORKSPACE,"revision":rev,"items":items,"updatedAt":t},200
def disabled(path):return {"ok":False,"code":"LEGACY_WRITE_DISABLED","message":"V134 旧快照/覆盖写入已停用；请使用 V200 事件接口","path":path},410
