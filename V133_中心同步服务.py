# -*- coding: utf-8 -*-
"""聚宝盆客户信息管理系统 中心同步服务 v133 安全修复版
v132（多机共用服务端）：
  · 共享库抽象层 shared_db.py：默认 SQLite 由中心服务独占（客户端只走 HTTP API），
    也可通过 JUBO_DB_TYPE=postgres + JUBO_PG_DSN 切换为 PostgreSQL 共享库；
  · 下行指令通道 commandChannelV1：服务端按 source 维护指令队列，
    各浏览器 Agent 轮询拉取并执行（contact.update / contact.delete / resync / shared-config.refresh），
    他源编辑/删除通过下行指令让来源浏览器收敛本地数据，覆盖层在数据收敛后自动清理；
  · 服务地址/令牌可通过环境变量配置，支持多台电脑指向同一中心服务。
兼容 V126~V131 全部接口；contacts 等旧表不改列，仅新增辅助表。
"""
import hashlib, hmac, json, os, secrets, shutil, sqlite3, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# 保证能从任意 cwd 找到同目录的 shared_db.py
_SELF_DIR = Path(__file__).resolve().parent
if str(_SELF_DIR) not in __import__('sys').path:
    __import__('sys').path.insert(0, str(_SELF_DIR))
import V133_shared_db as shared_db

HOST=(os.environ.get('JUBO_HOST') or '127.0.0.1').strip() or '127.0.0.1'
try:PORT=int(os.environ.get('JUBO_PORT') or 8765)
except Exception:PORT=8765
APP_VERSION='133'; SCHEMA_VERSION=2
DB_PATH=Path(os.environ.get('JUBO_DB') or (_SELF_DIR/'wa_remark_local_sync.sqlite')).resolve()
AUTH_TOKEN=(os.environ.get('JUBO_TOKEN') or '').strip()
MAX_BODY_BYTES=max(1024,int(os.environ.get('JUBO_MAX_BODY_BYTES') or 33554432))
MAX_DELETE_RATIO=min(1.0,max(0.0,float(os.environ.get('JUBO_MAX_DELETE_RATIO') or .30)))
MAX_DELETE_COUNT=max(1,int(os.environ.get('JUBO_MAX_DELETE_COUNT') or 100))
if not AUTH_TOKEN and HOST not in ('127.0.0.1','localhost','::1'): raise RuntimeError('未设置 JUBO_TOKEN 时只能监听回环地址')
shared_db.configure(db_path=DB_PATH)
CONTACT_WRITE_LOCK=threading.RLock()
SYNC_META_FIELDS={
 '_syncSourceId','_syncSourceName','_syncPreparedAt','_syncUploadedAt',
 '_presentation','_presentationVersion','__fromLocalSync','__syncSourceId',
 '__syncSourceName','__syncMergedKey','__rawId','__rawMainKey',
 '__rawInternalMainKey','__rawMemberIds','__sourceId','__sourceName'
}
def now_ms(): return int(time.time()*1000)
def jd(x): return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def canonical(x): return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def sha(x): return hashlib.sha256((x if isinstance(x,bytes) else str(x).encode('utf-8'))).hexdigest()
def conn():
 return shared_db.connect()
def _backup_and_check():
 if shared_db.db_type()=='postgres': return
 if DB_PATH.exists():
  backup=DB_PATH.with_name(DB_PATH.name+'.pre_v129_alpha1.bak')
  if not backup.exists(): shutil.copy2(str(DB_PATH),str(backup))
 c=conn()
 try:
  row=c.execute('PRAGMA quick_check').fetchone()
  if not row or str(row[0]).lower()!='ok': raise RuntimeError('SQLite quick_check failed: '+str(row[0] if row else 'no result'))
 finally:c.close()
def pick(o,ks,d=''):
 for k in ks:
  v=o.get(k)
  if v not in (None,''): return v
 return d
def norm_id_strict(i):
 v=i.get('id') or i.get('key') or i.get('uid') or i.get('contactId') or i.get('_localKey')
 return str(v).strip() if v not in (None,'') else ''
def norm_id(i): return norm_id_strict(i) or f"unknown:{now_ms()}"
def business_fact(i):
 if not isinstance(i,dict): return {}
 return {str(k):v for k,v in i.items() if str(k) not in SYNC_META_FIELDS}
def fact_hash(i): return sha(canonical(business_fact(i)))
def is_derived(i,cid=''):
 if 'MAIN::' in str(cid) or str(cid).startswith('sync::'): return True
 if not isinstance(i,dict): return True
 own=i.get('id') or i.get('_localKey') or i.get('key') or i.get('__id') or ''
 return ('MAIN::' in str(own) or str(own).startswith('sync::') or bool(i.get('isMainRecord') or i.get('__isMainRecord') or i.get('__isCrossSourceMain') or i.get('__isGroup') or i.get('platform')=='main' or i.get('__platform')=='main'))

def init_db():
 _backup_and_check(); c=conn(); cur=c.cursor(); t=now_ms()
 try:
  cur.execute('PRAGMA journal_mode=WAL'); cur.execute('PRAGMA synchronous=NORMAL')
  # V126 legacy schema, unchanged.
  cur.execute('CREATE TABLE IF NOT EXISTS sources(source_id TEXT PRIMARY KEY,source_name TEXT,first_seen_at INTEGER,last_seen_at INTEGER,last_upload_at INTEGER,upload_count INTEGER DEFAULT 0)')
  cur.execute('CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,source_name TEXT,contact_id TEXT NOT NULL,platform TEXT,name TEXT,phone TEXT,manual_phone TEXT,updated_at INTEGER,created_at INTEGER,last_seen_at INTEGER,contact_json TEXT NOT NULL,UNIQUE(source_id,contact_id))')
  for sql in ['CREATE INDEX IF NOT EXISTS idx_contacts_source_id ON contacts(source_id)','CREATE INDEX IF NOT EXISTS idx_contacts_contact_id ON contacts(contact_id)','CREATE INDEX IF NOT EXISTS idx_contacts_platform ON contacts(platform)']:cur.execute(sql)
  cur.execute('CREATE TABLE IF NOT EXISTS shared_config_meta(workspace_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,schema_version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER,updated_by TEXT)')
  cur.execute('CREATE TABLE IF NOT EXISTS shared_config_items(workspace_id TEXT NOT NULL,category TEXT NOT NULL,item_key TEXT NOT NULL,label TEXT NOT NULL,color TEXT,sort_order INTEGER DEFAULT 0,enabled INTEGER DEFAULT 1,archived_at INTEGER,updated_at INTEGER,updated_by TEXT,item_json TEXT,PRIMARY KEY(workspace_id,category,item_key))')
  cur.execute('CREATE TABLE IF NOT EXISTS shared_config_conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT,base_revision INTEGER,server_revision INTEGER,source_id TEXT,created_at INTEGER,payload_json TEXT)')
  cur.execute('CREATE INDEX IF NOT EXISTS idx_shared_config_items_workspace ON shared_config_items(workspace_id,category,sort_order)')
  # v129 additive schema.
  cur.execute('CREATE TABLE IF NOT EXISTS schema_meta(schema_name TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,migrated_at INTEGER NOT NULL,app_version TEXT NOT NULL)')
  cur.execute('CREATE TABLE IF NOT EXISTS source_sync_heads(source_id TEXT PRIMARY KEY,active_client_epoch TEXT NOT NULL,ack_seq INTEGER NOT NULL DEFAULT 0,last_batch_id TEXT,last_snapshot_hash TEXT,activated_at INTEGER NOT NULL,last_received_at INTEGER,last_error TEXT)')
  cur.execute('CREATE TABLE IF NOT EXISTS source_sync_state(source_id TEXT NOT NULL,client_epoch TEXT NOT NULL,ack_seq INTEGER NOT NULL DEFAULT 0,last_batch_id TEXT,last_snapshot_hash TEXT,last_received_at INTEGER,last_error TEXT,PRIMARY KEY(source_id,client_epoch))')
  cur.execute('CREATE TABLE IF NOT EXISTS sync_batches(source_id TEXT NOT NULL,client_epoch TEXT NOT NULL,batch_id TEXT NOT NULL,snapshot_seq INTEGER NOT NULL,received_at INTEGER NOT NULL,completed_at INTEGER,status TEXT NOT NULL,request_hash TEXT NOT NULL,snapshot_hash TEXT,item_count INTEGER NOT NULL DEFAULT 0,saved_count INTEGER NOT NULL DEFAULT 0,unchanged_count INTEGER NOT NULL DEFAULT 0,deleted_count INTEGER NOT NULL DEFAULT 0,facts_changed INTEGER NOT NULL DEFAULT 0,facts_revision INTEGER NOT NULL DEFAULT 0,response_json TEXT,error_text TEXT,PRIMARY KEY(source_id,client_epoch,batch_id))')
  cur.execute('CREATE INDEX IF NOT EXISTS idx_sync_batches_seq ON sync_batches(source_id,client_epoch,snapshot_seq)')
  cur.execute('CREATE TABLE IF NOT EXISTS contact_fact_hashes(source_id TEXT NOT NULL,contact_id TEXT NOT NULL,fact_hash TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(source_id,contact_id))')
  # v131 additive schema：他源数据管理端覆盖层。快照/上传/校准协议不触碰本表，
  # 管理端（Dashboard）对任意 source 的编辑/删除只写入本表，读取时合并展示。
  cur.execute('CREATE TABLE IF NOT EXISTS contact_overrides(source_id TEXT NOT NULL,contact_id TEXT NOT NULL,source_name TEXT,updated_at INTEGER NOT NULL,updated_by TEXT,overrides_json TEXT NOT NULL DEFAULT \'{}\',deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,contact_id))')
  cur.execute('CREATE INDEX IF NOT EXISTS idx_contact_overrides_deleted ON contact_overrides(source_id,deleted)')
  # v132 additive schema：下行指令通道。服务端按 source 排队指令，浏览器 Agent
  # 轮询 /api/commands/poll 拉取执行后 /api/commands/ack 回执；status: pending->done|error。
  cur.execute('CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,client_epoch TEXT,kind TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'pending\',created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,acked_at INTEGER,ack_note TEXT)')
  cur.execute('CREATE INDEX IF NOT EXISTS idx_commands_source_id ON commands(source_id,id)')
  cur.execute('CREATE TABLE IF NOT EXISTS source_leases(source_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,lease_generation INTEGER NOT NULL,lease_token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)')
  cur.execute('CREATE TABLE IF NOT EXISTS destructive_confirmations(token_hash TEXT PRIMARY KEY,source_id TEXT NOT NULL,client_epoch TEXT NOT NULL,snapshot_seq INTEGER NOT NULL,snapshot_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)')
  cur.execute('CREATE TABLE IF NOT EXISTS contact_tombstones(source_id TEXT NOT NULL,contact_id TEXT NOT NULL,client_epoch TEXT,source_seq INTEGER NOT NULL DEFAULT 0,delete_revision INTEGER NOT NULL DEFAULT 0,deleted_at INTEGER NOT NULL,expires_at INTEGER,PRIMARY KEY(source_id,contact_id))')
  cur.execute("CREATE TABLE IF NOT EXISTS aggregate_state(workspace_id TEXT PRIMARY KEY,facts_revision INTEGER NOT NULL DEFAULT 0,aggregate_revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disabled',requested_at INTEGER,started_at INTEGER,completed_at INTEGER,last_error TEXT)")
  cur.execute("INSERT OR IGNORE INTO aggregate_state(workspace_id,status) VALUES('default','disabled')")
  # Backfill hashes without changing facts revision.
  for r in cur.execute('SELECT source_id,contact_id,contact_json FROM contacts').fetchall():
   try:d=json.loads(r['contact_json'] or '{}')
   except Exception:d={}
   cur.execute('INSERT OR IGNORE INTO contact_fact_hashes(source_id,contact_id,fact_hash,updated_at) VALUES(?,?,?,?)',(r['source_id'],r['contact_id'],fact_hash(d),t))
  cur.execute('INSERT INTO schema_meta(schema_name,schema_version,migrated_at,app_version) VALUES(?,?,?,?) ON CONFLICT(schema_name) DO UPDATE SET schema_version=excluded.schema_version,migrated_at=excluded.migrated_at,app_version=excluded.app_version',('v129_sync',SCHEMA_VERSION,t,APP_VERSION))
  c.commit()
 finally:c.close()
def touch_source(cur,sid,sname,t,inc_upload=False):
 row=cur.execute('SELECT 1 FROM sources WHERE source_id=?',(sid,)).fetchone()
 if row:
  if inc_upload:cur.execute('UPDATE sources SET source_name=?,last_seen_at=?,last_upload_at=?,upload_count=upload_count+1 WHERE source_id=?',(sname,t,t,sid))
  else:cur.execute("UPDATE sources SET source_name=COALESCE(NULLIF(?,''),source_name),last_seen_at=? WHERE source_id=?",(sname,t,sid))
 else:cur.execute('INSERT INTO sources VALUES(?,?,?,?,?,?)',(sid,sname or sid,t,t,t if inc_upload else None,1 if inc_upload else 0))
def current_revision(cur):
 r=cur.execute("SELECT facts_revision FROM aggregate_state WHERE workspace_id='default'").fetchone();return int(r['facts_revision'] if r else 0)
def mark_changed(cur,changed,t):
 if changed:cur.execute("UPDATE aggregate_state SET facts_revision=facts_revision+1,status='disabled',requested_at=?,last_error=NULL WHERE workspace_id='default'",(t,))
 return current_revision(cur)
def write_contact(cur,sid,sname,cid,i,t):
 j=dict(i);j['_syncSourceId']=sid;j['_syncSourceName']=sname;j['_syncUploadedAt']=t
 vals=(sid,sname,cid,str(pick(i,['platform','site','app'])),str(pick(i,['name','displayName','title','nickname'])),str(pick(i,['phone','tel','number'])),str(pick(i,['manualPhone','manual_phone','phoneManual'])),int(pick(i,['updatedAt','updateTime','mtime','lastModified'],0) or 0),int(pick(i,['createdAt','createTime','ctime'],0) or 0),t,jd(j))
 cur.execute('INSERT INTO contacts(source_id,source_name,contact_id,platform,name,phone,manual_phone,updated_at,created_at,last_seen_at,contact_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET source_name=excluded.source_name,platform=excluded.platform,name=excluded.name,phone=excluded.phone,manual_phone=excluded.manual_phone,updated_at=excluded.updated_at,created_at=excluded.created_at,last_seen_at=excluded.last_seen_at,contact_json=excluded.contact_json',vals)
def upsert(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;items=payload.get('items') or [];t=int(payload.get('uploadedAt') or now_ms())
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(items,list):return {'ok':False,'error':'items must be array'}
 c0=conn();fenced=bool(c0.execute('SELECT 1 FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone());c0.close()
 if fenced:return {'ok':False,'error':'fenced-source-requires-snapshot','conflict':True}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');touch_source(cur,sid,sname,t,True);saved=skipped=unchanged=0;changed=False
   for i in items:
    if not isinstance(i,dict):skipped+=1;continue
    cid=norm_id(i)
    if is_derived(i,cid):skipped+=1;continue
    fh=fact_hash(i);old=cur.execute('SELECT fact_hash FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
    if old and old['fact_hash']==fh:unchanged+=1
    else:
     write_contact(cur,sid,sname,cid,i,t);cur.execute('INSERT INTO contact_fact_hashes VALUES(?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET fact_hash=excluded.fact_hash,updated_at=excluded.updated_at',(sid,cid,fh,t));changed=True
     _auto_clear_override(cur,sid,cid)
    saved+=1
   rev=mark_changed(cur,changed,t);c.commit();return {'ok':True,'sourceId':sid,'sourceName':sname,'received':len(items),'saved':saved,'skipped':skipped,'unchanged':unchanged,'factsChanged':changed,'factsRevision':rev,'uploadedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()
def delete_contacts(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;t=int(payload.get('deletedAt') or now_ms());ids=payload.get('contactIds')
 if ids is None:
  one=payload.get('contactId') or payload.get('id') or payload.get('key');ids=[one] if one else []
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(ids,list):return {'ok':False,'error':'contactIds must be array'}
 ids=list(dict.fromkeys(str(x) for x in ids if x not in (None,'')))
 if not ids:return {'ok':False,'error':'missing contactId/contactIds'}
 c0=conn();fenced=bool(c0.execute('SELECT 1 FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone());c0.close()
 if fenced:return {'ok':False,'error':'fenced-source-requires-snapshot','conflict':True}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');touch_source(cur,sid,sname,t,False);deleted=0
   for cid in ids:
    cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));deleted+=max(cur.rowcount,0);cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
    _auto_clear_tombstone(cur,sid,cid)
   rev=mark_changed(cur,deleted>0,t);c.commit();return {'ok':True,'sourceId':sid,'requested':len(ids),'deleted':deleted,'factsChanged':deleted>0,'factsRevision':rev,'deletedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()
def _override_source_name(cur,sid,sname):
 sname=str(sname or '').strip()
 if not sname:
  r=cur.execute('SELECT source_name FROM sources WHERE source_id=?',(sid,)).fetchone()
  if r and r['source_name']:sname=str(r['source_name'])
 return sname or sid
def upsert_contact_override(payload):
 sid=str(payload.get('sourceId') or '').strip();cid=str(payload.get('contactId') or '').strip();sname=str(payload.get('sourceName') or '').strip();by=str(payload.get('updatedBy') or '').strip();fields=payload.get('fields');t=now_ms()
 if not sid or not cid:return {'ok':False,'error':'missing sourceId/contactId'}
 if not isinstance(fields,dict):return {'ok':False,'error':'fields must be object'}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE')
   row=cur.execute('SELECT 1 FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
   if not row:c.rollback();return {'ok':False,'error':'contact not found (source may have deleted it)','sourceId':sid,'contactId':cid}
   sname=_override_source_name(cur,sid,sname)
   old=cur.execute('SELECT overrides_json FROM contact_overrides WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
   try:ovd=json.loads(old['overrides_json']) if old else {}
   except Exception:ovd={}
   for k,v in fields.items():
    if v is None:ovd.pop(str(k),None)
    else:ovd[str(k)]=v
   cur.execute('INSERT INTO contact_overrides(source_id,contact_id,source_name,updated_at,updated_by,overrides_json,deleted) VALUES(?,?,?,?,?,?,0) ON CONFLICT(source_id,contact_id) DO UPDATE SET source_name=excluded.source_name,updated_at=excluded.updated_at,updated_by=excluded.updated_by,overrides_json=excluded.overrides_json,deleted=0',(sid,cid,sname,t,by,jd(ovd)))
   rev=mark_changed(cur,True,t);c.commit();return {'ok':True,'sourceId':sid,'contactId':cid,'sourceName':sname,'overrides':ovd,'factsRevision':rev,'updatedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()
def delete_contact_override(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip();by=str(payload.get('updatedBy') or '').strip();t=now_ms();restore=bool(payload.get('restore'));ids=payload.get('contactIds')
 if ids is None:
  one=payload.get('contactId') or payload.get('id') or payload.get('key');ids=[one] if one else []
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(ids,list):return {'ok':False,'error':'contactIds must be array'}
 ids=list(dict.fromkeys(str(x) for x in ids if x not in (None,'')))
 if not ids:return {'ok':False,'error':'missing contactId/contactIds'}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');sname=_override_source_name(cur,sid,sname);flag=0 if restore else 1
   for cid in ids:
    cur.execute('INSERT INTO contact_overrides(source_id,contact_id,source_name,updated_at,updated_by,overrides_json,deleted) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET source_name=excluded.source_name,updated_at=excluded.updated_at,updated_by=excluded.updated_by,deleted=excluded.deleted',(sid,cid,sname,t,by,'{}',flag))
   rev=mark_changed(cur,bool(ids),t);c.commit();return {'ok':True,'sourceId':sid,'sourceName':sname,'requested':len(ids),'applied':len(ids),'deleted':0 if restore else len(ids),'restored':len(ids) if restore else 0,'factsRevision':rev,'updatedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()
# ==================== v132 收敛自动清理 ====================
# 覆盖层是"管理端先行视图"：当来源浏览器通过下行指令把本地数据改到与覆盖一致，
# 并重新上传后，contacts 行已等于覆盖值，此时覆盖层可以自动清除，避免永久叠加。
def _auto_clear_override(cur,sid,cid):
 try:
  ov=cur.execute('SELECT overrides_json FROM contact_overrides WHERE source_id=? AND contact_id=? AND deleted=0',(sid,cid)).fetchone()
  if not ov:return False
  try:ovd=json.loads(ov['overrides_json'] or '{}')
  except Exception:ovd={}
  if not ovd:return False
  row=cur.execute('SELECT contact_json FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
  if not row:return False
  try:data=json.loads(row['contact_json'] or '{}')
  except Exception:data={}
  for k,v in ovd.items():
   if data.get(str(k))!=v:return False
  cur.execute('DELETE FROM contact_overrides WHERE source_id=? AND contact_id=? AND deleted=0',(sid,cid));return True
 except Exception:return False
def _auto_clear_tombstone(cur,sid,cid):
 try:
  row=cur.execute('SELECT 1 FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
  if not row:
   cur.execute('DELETE FROM contact_overrides WHERE source_id=? AND contact_id=? AND deleted=1',(sid,cid));return True
  return False
 except Exception:return False
# ==================== v132 下行指令通道 ====================
def create_command(payload):
 sid=str(payload.get('sourceId') or '').strip();kind=str(payload.get('kind') or '').strip();pl=payload.get('payload');by=str(payload.get('createdBy') or '').strip();t=now_ms()
 if not sid or not kind:return {'ok':False,'error':'missing sourceId/kind'}
 if pl is None:pl={}
 if not isinstance(pl,dict):return {'ok':False,'error':'payload must be object'}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE')
   epoch=''
   h=cur.execute('SELECT active_client_epoch FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone()
   if h and h['active_client_epoch']:epoch=str(h['active_client_epoch'])
   row=None
   try:
    cur.execute('INSERT INTO commands(source_id,client_epoch,kind,payload_json,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id',(sid,epoch,kind,jd(pl),'pending',by,t,t))
    row=cur.fetchone()
   except Exception:
    # 旧版 SQLite（<3.35）不支持 RETURNING：回退 lastrowid
    cur.execute('INSERT INTO commands(source_id,client_epoch,kind,payload_json,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(sid,epoch,kind,jd(pl),'pending',by,t,t))
    row=None
   cid=int(row[0]) if row is not None else int(cur.lastrowid or 0)
   c.commit();return {'ok':True,'commandId':cid,'sourceId':sid,'kind':kind,'clientEpoch':epoch,'createdAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()
def poll_commands(q):
 sid=(q.get('sourceId') or [''])[0].strip();epoch=(q.get('clientEpoch') or [''])[0].strip()
 try:after=int((q.get('afterId') or ['0'])[0] or 0)
 except Exception:return {'ok':False,'error':'afterId must be integer','status':400}
 if not sid:return {'ok':False,'error':'missing sourceId','status':400}
 c=conn();cur=c.cursor()
 try:
  head=cur.execute('SELECT active_client_epoch FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone()
  active=str(head['active_client_epoch'] or '') if head else ''
  if active and not epoch:return {'ok':False,'conflict':True,'reason':'client-epoch-required','status':409}
  if active and epoch!=active:return {'ok':False,'conflict':True,'reason':'client-epoch-mismatch','activeClientEpoch':active,'status':409}
  if active:
   rows=cur.execute("SELECT id,client_epoch,kind,payload_json,created_at FROM commands WHERE source_id=? AND status=? AND id>? AND COALESCE(client_epoch, '')=? ORDER BY id ASC LIMIT 200",(sid,'pending',after,active)).fetchall()
  else:
   rows=cur.execute('SELECT id,client_epoch,kind,payload_json,created_at FROM commands WHERE source_id=? AND status=? AND id>? ORDER BY id ASC LIMIT 200',(sid,'pending',after)).fetchall()
  items=[]
  for r in rows:
   if epoch and r['client_epoch'] and r['client_epoch']!=epoch:continue
   try:pl=json.loads(r['payload_json'] or '{}')
   except Exception:pl={}
   items.append({'id':r['id'],'kind':r['kind'],'payload':pl if isinstance(pl,dict) else {},'clientEpoch':r['client_epoch'] or '','createdAt':r['created_at']})
  return {'ok':True,'sourceId':sid,'clientEpoch':active or epoch,'count':len(items),'items':items}
 except Exception:return {'ok':False,'error':'internal server error','status':500}
 finally:c.close()

def ack_commands(payload):
 sid=str(payload.get('sourceId') or '').strip();epoch=str(payload.get('clientEpoch') or '').strip();ids=payload.get('commandIds');status=str(payload.get('status') or 'done');note=str(payload.get('note') or '')[:500];t=now_ms()
 if not sid or not epoch or not isinstance(ids,list) or not ids:return {'ok':False,'error':'invalid sourceId/clientEpoch/commandIds'}
 try:ids=list(dict.fromkeys(int(x) for x in ids if str(x).isdigit()))
 except Exception:ids=[]
 status=status if status in ('done','error') else 'done'
 if not ids:return {'ok':False,'error':'invalid commandIds'}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');updated=0
   for i in ids:
    cur.execute("UPDATE commands SET status=?,acked_at=?,ack_note=?,updated_at=? WHERE source_id=? AND id=? AND status='pending' AND COALESCE(client_epoch,'')=?",(status,t,note,t,sid,i,epoch));updated+=max(cur.rowcount,0)
   if updated!=len(ids):c.rollback();return {'ok':False,'conflict':True,'reason':'command-ack-epoch-or-state-mismatch','requested':len(ids),'updated':0}
   c.commit();return {'ok':True,'sourceId':sid,'clientEpoch':epoch,'updated':updated}
  except Exception:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()

def admin_mutation(payload,deleted=False):
 sid=str(payload.get('sourceId') or '').strip();cid=str(payload.get('contactId') or '').strip();fields=payload.get('fields') or {};t=now_ms();by=str(payload.get('updatedBy') or '')[:200]
 if not sid or not cid:return {'ok':False,'error':'missing sourceId/contactId'},400
 forbidden={'id','key','uid','contactId','_localKey','_syncSourceId','_syncSourceName','_presentation','_presentationVersion'}
 if not deleted and (not isinstance(fields,dict) or any(str(k) in forbidden or str(k).startswith('__') for k in fields)):return {'ok':False,'error':'invalid or forbidden fields'},422
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');row=cur.execute('SELECT 1 FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone()
   if not row:c.rollback();return {'ok':False,'error':'contact not found'},404
   old=cur.execute('SELECT overrides_json FROM contact_overrides WHERE source_id=? AND contact_id=?',(sid,cid)).fetchone();ov={}
   try:ov=json.loads(old['overrides_json'] or '{}') if old else {}
   except Exception:ov={}
   if not deleted:
    for k,v in fields.items():ov.pop(str(k),None) if v is None else ov.__setitem__(str(k),v)
   sn=_override_source_name(cur,sid,'');cur.execute('INSERT INTO contact_overrides VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET source_name=excluded.source_name,updated_at=excluded.updated_at,updated_by=excluded.updated_by,overrides_json=excluded.overrides_json,deleted=excluded.deleted',(sid,cid,sn,t,by,jd({} if deleted else ov),1 if deleted else 0))
   h=cur.execute('SELECT active_client_epoch FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone();ep=str(h['active_client_epoch'] or '') if h else '';kind='contact.delete' if deleted else 'contact.update';pl={'contactId':cid} if deleted else {'contactId':cid,'fields':fields}
   cur.execute('INSERT INTO commands(source_id,client_epoch,kind,payload_json,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(sid,ep,kind,jd(pl),'pending',by,t,t));cmd=int(cur.lastrowid or 0);rev=mark_changed(cur,True,t);c.commit();return {'ok':True,'commandId':cmd,'factsRevision':rev},200
  except Exception:c.rollback();return {'ok':False,'error':'internal server error'},500
  finally:c.close()
def reconcile_source(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;t=int(payload.get('reconciledAt') or now_ms());ids=payload.get('contactIds') if 'contactIds' in payload else payload.get('ids')
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(ids,list):return {'ok':False,'error':'contactIds must be array'}
 keep=set(str(x) for x in ids if x not in (None,''))
 c0=conn();fenced=bool(c0.execute('SELECT 1 FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone());c0.close()
 if fenced:return {'ok':False,'error':'fenced-source-requires-snapshot','conflict':True}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');touch_source(cur,sid,sname,t,False);all_ids=[r['contact_id'] for r in cur.execute('SELECT contact_id FROM contacts WHERE source_id=?',(sid,)).fetchall()];remove=[x for x in all_ids if x not in keep]
   for cid in remove:
    cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
    _auto_clear_tombstone(cur,sid,cid)
   rev=mark_changed(cur,bool(remove),t);c.commit();return {'ok':True,'sourceId':sid,'kept':len(keep),'before':len(all_ids),'after':len(all_ids)-len(remove),'deleted':len(remove),'factsChanged':bool(remove),'factsRevision':rev,'reconciledAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'}
  finally:c.close()

def _token_hash(x):return sha('lease:'+str(x or ''))
def claim_lease(payload):
 sid=str(payload.get('sourceId') or '').strip();inst=str(payload.get('installationId') or '').strip();t=now_ms()
 if not sid or not inst:return {'ok':False,'error':'missing sourceId/installationId'},400
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');r=cur.execute('SELECT * FROM source_leases WHERE source_id=?',(sid,)).fetchone()
   if r and int(r['expires_at'] or 0)>t and str(r['installation_id'])!=inst:c.rollback();return {'ok':False,'conflict':True,'reason':'source-lease-held','leaseExpiresAt':int(r['expires_at'])},409
   g=(int(r['lease_generation']) if r and str(r['installation_id'])==inst else (int(r['lease_generation'])+1 if r else 1));token=secrets.token_urlsafe(32);exp=t+30000
   cur.execute('INSERT INTO source_leases VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET installation_id=excluded.installation_id,lease_generation=excluded.lease_generation,lease_token_hash=excluded.lease_token_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at',(sid,inst,g,_token_hash(token),exp,t));c.commit()
   return {'ok':True,'sourceId':sid,'installationId':inst,'leaseGeneration':g,'leaseToken':token,'leaseExpiresAt':exp},200
  except Exception:c.rollback();return {'ok':False,'error':'internal server error'},500
  finally:c.close()
def _valid_lease(cur,p,sid):
 r=cur.execute('SELECT * FROM source_leases WHERE source_id=?',(sid,)).fetchone()
 try:g=int(p.get('leaseGeneration') or 0)
 except Exception:g=0
 ok=bool(r and int(r['expires_at'] or 0)>now_ms() and str(r['installation_id'])==str(p.get('installationId') or '') and int(r['lease_generation'])==g and hmac.compare_digest(str(r['lease_token_hash']),_token_hash(p.get('leaseToken'))))
 return ok
def _validate_snapshot(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;epoch=str(payload.get('clientEpoch') or '').strip();bid=str(payload.get('batchId') or '').strip();items=payload.get('items');t=int(payload.get('uploadedAt') or now_ms())
 try:seq=int(payload.get('snapshotSeq'))
 except Exception:return None,({'ok':False,'error':'snapshotSeq must be integer'},400)
 if not sid or not epoch or not bid:return None,({'ok':False,'error':'missing sourceId/clientEpoch/batchId'},400)
 if seq<1 or not isinstance(items,list):return None,({'ok':False,'error':'invalid snapshotSeq/items'},400)
 if payload.get('itemCount') is not None and int(payload.get('itemCount'))!=len(items):return None,({'ok':False,'error':'itemCount mismatch'},400)
 clean=[];seen=set()
 for i in items:
  if not isinstance(i,dict):return None,({'ok':False,'error':'snapshot item must be object'},400)
  cid=norm_id_strict(i)
  if not cid:return None,({'ok':False,'error':'snapshot item missing contactId'},400)
  if is_derived(i,cid):continue
  if cid in seen:return None,({'ok':False,'error':'duplicate contactId','contactId':cid},400)
  seen.add(cid);clean.append((cid,i,fact_hash(i)))
 clean.sort(key=lambda x:x[0]);snap=sha(canonical([[cid,business_fact(i)] for cid,i,_ in clean]));req=sha(canonical({'sourceId':sid,'clientEpoch':epoch,'snapshotSeq':seq,'snapshotHash':snap}))
 return (sid,sname,epoch,bid,seq,t,clean,snap,req),None
def sync_snapshot(payload,require_v133=False):
 v,err=_validate_snapshot(payload)
 if err:return err
 sid,sname,epoch,bid,seq,t,clean,snap,req=v
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE')
   lease_exists=bool(cur.execute('SELECT 1 FROM source_leases WHERE source_id=?',(sid,)).fetchone())
   if require_v133:
    if payload.get('protocolVersion')!=133 or not _valid_lease(cur,payload,sid):c.rollback();return {'ok':False,'conflict':True,'reason':'stale-writer-fenced'},409
   elif lease_exists:
    c.rollback();return {'ok':False,'conflict':True,'reason':'protocol-upgrade-required'},409
   oldbatch=cur.execute('SELECT * FROM sync_batches WHERE source_id=? AND client_epoch=? AND batch_id=?',(sid,epoch,bid)).fetchone()
   if oldbatch:
    if oldbatch['request_hash']!=req:c.rollback();return {'ok':False,'conflict':True,'reason':'batch-content-mismatch'},409
    if oldbatch['status']=='completed' and oldbatch['response_json']:
     response=json.loads(oldbatch['response_json']);response['idempotent']=True;c.rollback();return response,200
   head=cur.execute('SELECT * FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone()
   if head and head['active_client_epoch']!=epoch:
    c.rollback();return {'ok':False,'conflict':True,'reason':'client-epoch-mismatch','activeClientEpoch':head['active_client_epoch'],'serverAckSeq':int(head['ack_seq'])},409
   ack=int(head['ack_seq']) if head else 0;server_snap=str(head['last_snapshot_hash'] or '') if head else ''
   if seq>ack+1:c.rollback();return {'ok':False,'conflict':True,'reason':'snapshot-sequence-gap','serverAckSeq':ack},409
   if seq<ack:
    c.rollback();return {'ok':True,'stale':True,'applied':False,'sourceId':sid,'clientEpoch':epoch,'serverAckSeq':ack,'serverSnapshotHash':server_snap},200
   if seq==ack:
    if snap!=server_snap:c.rollback();return {'ok':False,'conflict':True,'reason':'snapshot-sequence-conflict','serverAckSeq':ack,'serverSnapshotHash':server_snap},409
    c.rollback();return {'ok':True,'idempotent':True,'applied':False,'sourceId':sid,'clientEpoch':epoch,'batchId':bid,'serverAckSeq':ack,'serverSnapshotHash':server_snap},200
   cur.execute('INSERT OR REPLACE INTO sync_batches(source_id,client_epoch,batch_id,snapshot_seq,received_at,status,request_hash,snapshot_hash,item_count) VALUES(?,?,?,?,?,?,?,?,?)',(sid,epoch,bid,seq,t,'processing',req,snap,len(clean)))
   touch_source(cur,sid,sname,t,True)
   oldhash={r['contact_id']:r['fact_hash'] for r in cur.execute('SELECT contact_id,fact_hash FROM contact_fact_hashes WHERE source_id=?',(sid,)).fetchall()};newids={x[0] for x in clean};saved=unchanged=0
   for cid,i,fh in clean:
    if oldhash.get(cid)==fh:unchanged+=1
    else:write_contact(cur,sid,sname,cid,i,t);saved+=1
    cur.execute('INSERT INTO contact_fact_hashes VALUES(?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET fact_hash=excluded.fact_hash,updated_at=excluded.updated_at',(sid,cid,fh,t))
    _auto_clear_override(cur,sid,cid)
   remove=[cid for cid in oldhash if cid not in newids]
   delete_ratio=(len(remove)/float(len(oldhash))) if oldhash else 0.0
   destructive=bool(oldhash) and (not clean or len(remove)>MAX_DELETE_COUNT or delete_ratio>MAX_DELETE_RATIO)
   if destructive:
    supplied=str(payload.get('destructiveConfirmationToken') or '')
    confirmation=cur.execute('SELECT * FROM destructive_confirmations WHERE token_hash=?',(_token_hash('destructive:'+supplied),)).fetchone() if supplied else None
    confirmed=bool(confirmation and str(confirmation['source_id'])==sid and str(confirmation['client_epoch'])==epoch and int(confirmation['snapshot_seq'])==seq and str(confirmation['snapshot_hash'])==snap and int(confirmation['expires_at'])>now_ms())
    if not confirmed:
     c.rollback();token=secrets.token_urlsafe(32);c2=conn();c2.execute('DELETE FROM destructive_confirmations WHERE expires_at<=?',(now_ms(),));c2.execute('INSERT INTO destructive_confirmations VALUES(?,?,?,?,?,?,?)',(_token_hash('destructive:'+token),sid,epoch,seq,snap,now_ms()+300000,now_ms()));c2.commit();c2.close()
     return {'ok':False,'conflict':True,'reason':'destructive-snapshot-requires-confirmation','beforeCount':len(oldhash),'deleteCount':len(remove),'deleteRatio':delete_ratio,'confirmationToken':token,'confirmationExpiresInMs':300000},409
    cur.execute('DELETE FROM destructive_confirmations WHERE token_hash=?',(_token_hash('destructive:'+supplied),))
   for cid in remove:
    cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
    cur.execute('INSERT INTO contact_tombstones VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET client_epoch=excluded.client_epoch,source_seq=excluded.source_seq,delete_revision=excluded.delete_revision,deleted_at=excluded.deleted_at,expires_at=excluded.expires_at',(sid,cid,epoch,seq,current_revision(cur)+1,t,t+2592000000))
   changed=bool(saved or remove);rev=mark_changed(cur,changed,t)
   cur.execute('INSERT INTO source_sync_heads(source_id,active_client_epoch,ack_seq,last_batch_id,last_snapshot_hash,activated_at,last_received_at,last_error) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(source_id) DO UPDATE SET ack_seq=excluded.ack_seq,last_batch_id=excluded.last_batch_id,last_snapshot_hash=excluded.last_snapshot_hash,last_received_at=excluded.last_received_at,last_error=NULL',(sid,epoch,seq,bid,snap,t,t))
   cur.execute('INSERT INTO source_sync_state(source_id,client_epoch,ack_seq,last_batch_id,last_snapshot_hash,last_received_at,last_error) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(source_id,client_epoch) DO UPDATE SET ack_seq=excluded.ack_seq,last_batch_id=excluded.last_batch_id,last_snapshot_hash=excluded.last_snapshot_hash,last_received_at=excluded.last_received_at,last_error=NULL',(sid,epoch,seq,bid,snap,t))
   response={'ok':True,'applied':True,'sourceId':sid,'sourceName':sname,'clientEpoch':epoch,'batchId':bid,'snapshotSeq':seq,'serverAckSeq':seq,'serverSnapshotHash':snap,'received':len(clean),'saved':saved,'unchanged':unchanged,'deleted':len(remove),'factsChanged':changed,'factsRevision':rev,'aggregateStatus':'disabled','serverTime':now_ms()}
   cur.execute("UPDATE sync_batches SET completed_at=?,status='completed',saved_count=?,unchanged_count=?,deleted_count=?,facts_changed=?,facts_revision=?,response_json=? WHERE source_id=? AND client_epoch=? AND batch_id=?",(now_ms(),saved,unchanged,len(remove),1 if changed else 0,rev,jd(response),sid,epoch,bid));c.commit();return response,200
  except Exception as e:
   c.rollback();return {'ok':False,'error':'internal server error'},500
  finally:c.close()
def sync_status(q):
 sid=(q.get('sourceId') or [''])[0].strip();epoch=(q.get('clientEpoch') or [''])[0].strip();c=conn();cur=c.cursor()
 try:
  a=cur.execute("SELECT * FROM aggregate_state WHERE workspace_id='default'").fetchone()
  if not sid:return {'ok':True,'serverTime':now_ms(),'aggregate':dict(a) if a else None,'capabilities':capabilities()}
  h=cur.execute('SELECT * FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone();ret={'ok':True,'sourceId':sid,'exists':bool(h),'serverTime':now_ms(),'capabilities':capabilities(),'aggregate':dict(a) if a else None}
  if h:ret.update({'activeClientEpoch':h['active_client_epoch'],'serverAckSeq':int(h['ack_seq']),'lastBatchId':h['last_batch_id'],'serverSnapshotHash':h['last_snapshot_hash'],'lastReceivedAt':h['last_received_at'],'epochMatches':not epoch or epoch==h['active_client_epoch']})
  return ret
 finally:c.close()
def capabilities():return {'snapshotSyncV2':True,'leaseFenceV1':True,'destructiveGuardV1':True,'atomicAdminMutationV1':True,'snapshotSyncV1':True,'syncStatusV1':True,'factsRevisionV1':True,'serverAggregateV1':False,'epochFenceV1':True,'remoteOverrideV1':True,'commandChannelV1':True}

SHARED_CATEGORIES={'tag','persona','field_label','stage_label','custom_field'}
FIELD_KEYS={'f1','f2','f3','f4','f5','f6','f7','f8','remark'}
STAGE_KEYS={'s1','s2','s3'}
CUSTOM_FIELD_TYPES={'text','textarea','number','date'}
def _clean_text(v,max_len=50):
    v=str(v if v is not None else '').strip()
    if not v or len(v)>max_len or any(ord(ch)<32 for ch in v): raise ValueError('invalid label')
    return v
def _norm_label(v): return ' '.join(str(v or '').replace('\u3000',' ').strip().casefold().split())
def _valid_shared_key(cat,key):
    if cat=='field_label': return key in FIELD_KEYS
    if cat=='stage_label': return key in STAGE_KEYS
    if cat=='custom_field': return bool(__import__('re').fullmatch(r'cf_[A-Za-z0-9_-]{6,96}',key))
    return bool(key or cat=='tag') and len(key)<=100 and not any(ord(ch)<32 for ch in key)
def get_shared_config(workspace_id='default',include_archived=False):
    wid=str(workspace_id or 'default').strip()[:100] or 'default'; c=conn(); cur=c.cursor()
    meta=cur.execute('SELECT * FROM shared_config_meta WHERE workspace_id=?',(wid,)).fetchone();sql='SELECT * FROM shared_config_items WHERE workspace_id=?';args=[wid]
    if not include_archived: sql+=' AND archived_at IS NULL AND enabled=1'
    sql+=' ORDER BY category,sort_order,item_key';rows=cur.execute(sql,args).fetchall();c.close();items=[]
    for r in rows:
        try: raw=json.loads(r['item_json'] or '{}')
        except Exception: raw={}
        item={'category':r['category'],'key':r['item_key'],'label':r['label'],'sortOrder':r['sort_order'] or 0,'enabled':bool(r['enabled']),'archivedAt':r['archived_at']}
        if r['color'] is not None:item['color']=r['color']
        if r['category']=='custom_field': item['fieldType']=str(raw.get('fieldType') or raw.get('type') or 'text')
        items.append(item)
    return {'ok':True,'workspaceId':wid,'schemaVersion':2,'revision':int(meta['revision']) if meta else 0,'updatedAt':meta['updated_at'] if meta else None,'updatedBy':meta['updated_by'] if meta else None,'capabilities':{'customFieldV1':True,'orderedBusinessConfigV1':True},'items':items}
def update_shared_config(payload):
    wid=str(payload.get('workspaceId') or 'default').strip()[:100] or 'default';sid=str(payload.get('sourceId') or '').strip()[:200];items=payload.get('items');base=payload.get('baseRevision');t=now_ms();caps=payload.get('capabilities') or {};supports_cf=caps.get('customFieldV1') is True
    if not sid:return {'ok':False,'error':'missing sourceId'},400
    if not isinstance(items,list):return {'ok':False,'error':'items must be array'},400
    try:base=int(base)
    except Exception:return {'ok':False,'error':'baseRevision must be integer'},400
    normalized=[];seen=set();stage_labels=[];label_seen={'tag':set(),'persona':set(),'custom_field':set()}
    try:
        for idx,x in enumerate(items):
            if not isinstance(x,dict):raise ValueError('item must be object')
            cat=str(x.get('category') or '').strip();key=str(x.get('key') if x.get('key') is not None else '').strip()
            if cat not in SHARED_CATEGORIES or not _valid_shared_key(cat,key):raise ValueError('invalid category/key: '+cat+'/'+key)
            if (cat,key) in seen:raise ValueError('duplicate category/key')
            seen.add((cat,key));label=_clean_text(x.get('label'));color=None;enabled=bool(x.get('enabled',True));archived=x.get('archivedAt')
            if cat in ('tag','persona'):
                color=str(x.get('color') or '#78909c').strip()
                if not re_match_color(color):raise ValueError('invalid color')
            if cat=='custom_field':
                ft=str(x.get('fieldType') or x.get('type') or 'text')
                if ft not in CUSTOM_FIELD_TYPES:raise ValueError('invalid custom field type')
                x=dict(x);x['fieldType']=ft
            if cat=='stage_label':stage_labels.append(_norm_label(label))
            if cat in label_seen and enabled and not archived:
                nl=_norm_label(label)
                if nl in label_seen[cat]:raise ValueError('duplicate label in category: '+cat+'/'+label)
                label_seen[cat].add(nl)
            normalized.append((cat,key,label,color,int(x.get('sortOrder') if x.get('sortOrder') is not None else idx),1 if enabled else 0,int(archived) if archived else None,jd(x)))
        if len(stage_labels)!=len(set(stage_labels)):raise ValueError('duplicate stage labels')
    except Exception as e:return {'ok':False,'error':str(e)},400
    c=conn();cur=c.cursor()
    try:
        cur.execute('BEGIN IMMEDIATE');meta=cur.execute('SELECT revision FROM shared_config_meta WHERE workspace_id=?',(wid,)).fetchone();server=int(meta['revision']) if meta else 0
        if base!=server:
            cur.execute('INSERT INTO shared_config_conflicts(workspace_id,base_revision,server_revision,source_id,created_at,payload_json) VALUES(?,?,?,?,?,?)',(wid,base,server,sid,t,jd(payload)));c.commit();return {'ok':False,'error':'revision conflict','conflict':True,'revision':server,'current':get_shared_config(wid,True)},409
        newrev=server+1
        if not meta:cur.execute('INSERT INTO shared_config_meta(workspace_id,revision,schema_version,updated_at,updated_by) VALUES(?,?,?,?,?)',(wid,newrev,2,t,sid))
        else:cur.execute('UPDATE shared_config_meta SET revision=?,schema_version=2,updated_at=?,updated_by=? WHERE workspace_id=?',(newrev,t,sid,wid))
        snapshot=['tag','persona']+(['custom_field'] if supports_cf else [])
        for cat in snapshot:
            keys=[k for ccat,k,*_ in normalized if ccat==cat];existing=[r['item_key'] for r in cur.execute('SELECT item_key FROM shared_config_items WHERE workspace_id=? AND category=? AND archived_at IS NULL',(wid,cat)).fetchall()]
            for key in existing:
                if key not in keys:cur.execute('UPDATE shared_config_items SET enabled=0,archived_at=?,updated_at=?,updated_by=? WHERE workspace_id=? AND category=? AND item_key=?',(t,t,sid,wid,cat,key))
        for cat,key,label,color,order,enabled,archived,item_json in normalized:
            cur.execute('INSERT INTO shared_config_items(workspace_id,category,item_key,label,color,sort_order,enabled,archived_at,updated_at,updated_by,item_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,category,item_key) DO UPDATE SET label=excluded.label,color=excluded.color,sort_order=excluded.sort_order,enabled=excluded.enabled,archived_at=excluded.archived_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by,item_json=excluded.item_json',(wid,cat,key,label,color,order,enabled,archived,t,sid,item_json))
        c.commit();return get_shared_config(wid,True),200
    except Exception as e:c.rollback();return {'ok':False,'error':'internal server error'},500
    finally:c.close()
def re_match_color(v):
    import re
    return bool(re.match(r'^#[0-9a-fA-F]{6}$',v))


def sources():
 c=conn();rows=c.execute('SELECT s.*,COUNT(c.id) contact_count FROM sources s LEFT JOIN contacts c ON c.source_id=s.source_id AND NOT EXISTS(SELECT 1 FROM contact_overrides o WHERE o.source_id=c.source_id AND o.contact_id=c.contact_id AND o.deleted=1) GROUP BY s.source_id ORDER BY s.last_seen_at DESC').fetchall();c.close();return {'ok':True,'items':[{'sourceId':r['source_id'],'sourceName':r['source_name'],'firstSeenAt':r['first_seen_at'],'lastSeenAt':r['last_seen_at'],'lastUploadAt':r['last_upload_at'],'uploadCount':r['upload_count'],'count':r['contact_count']} for r in rows]}
def contacts(q):
 sid=(q.get('sourceId') or [''])[0];c=conn();cur=c.cursor();sql='SELECT c.*,o.overrides_json,o.updated_at AS ov_updated_at FROM contacts c LEFT JOIN contact_overrides o ON o.source_id=c.source_id AND o.contact_id=c.contact_id WHERE (o.deleted IS NULL OR o.deleted=0)';args=[]
 if sid:sql+=' AND c.source_id=?';args=[sid]
 sql+=' ORDER BY c.updated_at DESC,c.last_seen_at DESC'
 rows=cur.execute(sql,args).fetchall();c.close();out=[]
 for r in rows:
  try:data=json.loads(r['contact_json'] or '{}')
  except Exception:data={}
  platform=r['platform'];name=r['name'];phone=r['phone'];manual=r['manual_phone'];upd=r['updated_at']
  if r['overrides_json']:
   try:ovd=json.loads(r['overrides_json'] or '{}')
   except Exception:ovd={}
   for k,v in ovd.items():
    if v is None:data.pop(str(k),None)
    else:data[str(k)]=v
   # 覆盖后不再信任来源端 presentation，回落到原始业务字段，保证覆盖值可见。
   data.pop('_presentation',None);data.pop('_presentationVersion',None)
   if r['ov_updated_at']:data['updatedAt']=r['ov_updated_at']
   platform=pick(data,['platform','site','app']) or platform
   name=pick(data,['name','displayName','title','nickname']) or name
   phone=pick(data,['phone','tel','number']) or phone
   manual=pick(data,['manualPhone','manual_phone','phoneManual']) or manual
   upd=int(pick(data,['updatedAt','updateTime','mtime','lastModified'],0) or 0) or upd
  out.append({'sourceId':r['source_id'],'sourceName':r['source_name'],'contactId':r['contact_id'],'platform':platform,'name':name,'phone':phone,'manualPhone':manual,'updatedAt':upd,'createdAt':r['created_at'],'lastSeenAt':r['last_seen_at'],'data':data})
 return {'ok':True,'count':len(out),'items':out}
def stats():
 c=conn();cur=c.cursor();tc=cur.execute('SELECT COUNT(*) n FROM contacts').fetchone()['n'];ts=cur.execute('SELECT COUNT(*) n FROM sources').fetchone()['n'];rev=current_revision(cur);c.close();return {'ok':True,'totalContacts':tc,'totalSources':ts,'factsRevision':rev}
class H(BaseHTTPRequestHandler):
 def log_message(self,fmt,*args):print('[HTTP]',fmt%args)
 def _auth_ok(self):
  if not AUTH_TOKEN:return True
  return hmac.compare_digest((self.headers.get('X-Auth-Token') or ''),AUTH_TOKEN)
 def sendj(self,d,st=200):
  b=jd(d).encode('utf-8');self.send_response(st);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Requested-With, X-Auth-Token');self.end_headers();self.wfile.write(b)
 def sendhtml(self,html,st=200):
  b=html.encode('utf-8');self.send_response(st);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(b)
 def dashboard_html(self):
  return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>聚宝盆客户信息管理系统 v133 · 独立 Dashboard</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#f0f2f5;color:#54656f;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.boot{padding:24px 30px;background:#fff;border:1px solid #d9dee3;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.08);text-align:center}.boot b{display:block;color:#8f2118;font-size:19px;margin-bottom:8px}</style></head><body><div class="boot"><b>聚宝盆客户信息管理系统 v133</b>正在加载独立 Dashboard…<br><small>若页面长时间未变化，请确认 Tampermonkey 中已启用 v133 Userscript。</small></div></body></html>"""
 def do_OPTIONS(self):self.send_response(204);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Requested-With, X-Auth-Token');self.end_headers()
 def do_GET(self):
  try:
   p=urlparse(self.path);q=parse_qs(p.query)
   if p.path in ('/dashboard','/dashboard/'):return self.sendhtml(self.dashboard_html())
   if not self._auth_ok():return self.sendj({'ok':False,'error':'unauthorized','hint':'missing or wrong X-Auth-Token (JUBO_TOKEN)'},401)
   if p.path=='/api/health':return self.sendj({'ok':True,'service':'wa-remark-local-sync','version':APP_VERSION,'sharedConfig':True,'time':now_ms(),'dbType':shared_db.db_type(),'auth':bool(AUTH_TOKEN),'capabilities':capabilities()})
   if p.path in ('/api/v129/sync/status','/api/v130/sync/status','/api/v133/sync/status'):return self.sendj(sync_status(q))
   if p.path=='/api/shared-config':return self.sendj(get_shared_config((q.get('workspaceId') or ['default'])[0],(q.get('includeArchived') or ['0'])[0]=='1'))
   if p.path=='/api/sources':return self.sendj(sources())
   if p.path=='/api/contacts':return self.sendj(contacts(q))
   if p.path=='/api/stats':return self.sendj(stats())
   if p.path=='/api/commands/poll':
     r=poll_commands(q);st=int(r.pop('status',200));return self.sendj(r,st)
   return self.sendj({'ok':False,'error':'not found','path':p.path},404)
  except Exception as e:return self.sendj({'ok':False,'error':'internal server error'},500)
 def do_POST(self):
  try:
   p=urlparse(self.path);n=int(self.headers.get('Content-Length','0') or 0)
   if n<0 or n>MAX_BODY_BYTES:return self.sendj({'ok':False,'error':'request entity too large'},413)
   try:payload=json.loads(self.rfile.read(n).decode('utf-8') if n else '{}')
   except Exception:return self.sendj({'ok':False,'error':'invalid json'},400)
   if not self._auth_ok():return self.sendj({'ok':False,'error':'unauthorized','hint':'missing or wrong X-Auth-Token (JUBO_TOKEN)'},401)
   if p.path=='/api/v133/sync/lease/claim':r,st=claim_lease(payload);return self.sendj(r,st)
   if p.path in ('/api/v129/sync/snapshot','/api/v130/sync/snapshot','/api/v133/sync/snapshot'):r,st=sync_snapshot(payload,p.path=='/api/v133/sync/snapshot');return self.sendj(r,st)
   if p.path in ('/api/shared-config/update','/api/shared-config/initialize'):r,st=update_shared_config(payload);return self.sendj(r,st)
   if p.path=='/api/contacts/batch-upsert':r=upsert(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path in ('/api/contacts/delete','/api/contacts/batch-delete'):r=delete_contacts(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path=='/api/v133/admin/contacts/update':r,st=admin_mutation(payload,False);return self.sendj(r,st)
   if p.path=='/api/v133/admin/contacts/delete':r,st=admin_mutation(payload,True);return self.sendj(r,st)
   if p.path=='/api/contacts/override':r=upsert_contact_override(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path in ('/api/contacts/override-delete','/api/contacts/override/delete'):r=delete_contact_override(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path in ('/api/contacts/source-reconcile','/api/contacts/reconcile','/api/contacts/full-sync-clean'):r=reconcile_source(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path=='/api/commands/create':r=create_command(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path=='/api/commands/ack':r=ack_commands(payload);return self.sendj(r,200 if r.get('ok') else 400)
   return self.sendj({'ok':False,'error':'not found','path':p.path},404)
  except Exception as e:return self.sendj({'ok':False,'error':'internal server error'},500)
def lan_ips():
 out=[]
 try:
  import socket
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect(('8.8.8.8',80));out.append(s.getsockname()[0]);s.close()
 except Exception:
  try:
   import socket
   out.append(socket.gethostbyname(socket.gethostname()))
  except Exception:pass
 return out
def main():
 init_db();print('='*70);print('聚宝盆客户信息管理系统 - 中心同步服务 v'+APP_VERSION)
 print('服务地址：http://'+HOST+':'+str(PORT))
 for ip in lan_ips():
  if HOST in ('0.0.0.0','::',''):print('局域网地址（其他电脑/浏览器用这个）：http://'+ip+':'+str(PORT))
 print('数据库：'+str(DB_PATH)+'（后端：'+shared_db.db_type()+'）')
 if not AUTH_TOKEN:print('⚠️  未设置 JUBO_TOKEN：局域网内任何设备都可访问 API。多机部署强烈建议设置令牌。')
 print('v133：Lease 围栏 + 原子管理写入 + Epoch 命令 ACK；旧只读接口兼容')
 print('='*70);ThreadingHTTPServer((HOST,PORT),H).serve_forever()
if __name__=='__main__':main()
#（注：内容由AI生成）
