# -*- coding: utf-8 -*-
"""聚宝盆本地同步服务 v129.0.0-alpha2
兼容 Alpha 1/V126 全部接口；新增服务端影子聚合快照，不修改旧业务表。
"""
import hashlib, json, shutil, sqlite3, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HOST='127.0.0.1'; PORT=8765
APP_VERSION='129.2.1'; SCHEMA_VERSION=2
DB_PATH=Path(__file__).resolve().parent/'wa_remark_local_sync.sqlite'
CONTACT_WRITE_LOCK=threading.RLock()
AGGREGATE_SINGLE_FLIGHT_LOCK=threading.Lock()
AGGREGATE_WAKE_EVENT=threading.Event()
SERVICE_STOP_EVENT=threading.Event()
CHANGE_CONDITION=threading.Condition()
AGGREGATE_DEBOUNCE_SECONDS=0.2
AGGREGATE_MAX_WAIT_SECONDS=1.0
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
 c=sqlite3.connect(str(DB_PATH),timeout=15); c.row_factory=sqlite3.Row
 c.execute('PRAGMA busy_timeout=15000'); c.execute('PRAGMA foreign_keys=ON')
 return c
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

def _backup_and_check():
 if DB_PATH.exists():
  backup=DB_PATH.with_name(DB_PATH.name+'.pre_v129_alpha2.bak')
  if not backup.exists(): shutil.copy2(str(DB_PATH),str(backup))
 c=conn()
 try:
  row=c.execute('PRAGMA quick_check').fetchone()
  if not row or str(row[0]).lower()!='ok': raise RuntimeError('SQLite quick_check failed: '+str(row[0] if row else 'no result'))
 finally:c.close()
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
  cur.execute("CREATE TABLE IF NOT EXISTS aggregate_state(workspace_id TEXT PRIMARY KEY,facts_revision INTEGER NOT NULL DEFAULT 0,aggregate_revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disabled',requested_at INTEGER,started_at INTEGER,completed_at INTEGER,last_error TEXT)")
  cur.execute("INSERT OR IGNORE INTO aggregate_state(workspace_id,status) VALUES('default','stale')")
  # Alpha 2：聚合快照独立存储，事实写入只令其失效，避免事实键与聚合键互相触发。
  cur.execute('CREATE TABLE IF NOT EXISTS aggregate_snapshots(workspace_id TEXT PRIMARY KEY,facts_revision INTEGER NOT NULL,aggregate_revision INTEGER NOT NULL,aggregate_hash TEXT NOT NULL,contact_count INTEGER NOT NULL,source_count INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,duration_ms INTEGER NOT NULL DEFAULT 0)')
  # Alpha 1 的 disabled 表示尚未生成；Alpha 2 统一视为 stale。
  cur.execute("UPDATE aggregate_state SET status='stale' WHERE workspace_id='default' AND status='disabled'")
  # Backfill hashes without changing facts revision.
  for r in cur.execute('SELECT source_id,contact_id,contact_json FROM contacts').fetchall():
   try:d=json.loads(r['contact_json'] or '{}')
   except Exception:d={}
   cur.execute('INSERT OR IGNORE INTO contact_fact_hashes(source_id,contact_id,fact_hash,updated_at) VALUES(?,?,?,?)',(r['source_id'],r['contact_id'],fact_hash(d),t))
  cur.execute('INSERT INTO schema_meta(schema_name,schema_version,migrated_at,app_version) VALUES(?,?,?,?) ON CONFLICT(schema_name) DO UPDATE SET schema_version=excluded.schema_version,migrated_at=excluded.migrated_at,app_version=excluded.app_version',('v129_sync',SCHEMA_VERSION,t,APP_VERSION))
  c.commit()
 finally:c.close()
def notify_facts_changed():
 AGGREGATE_WAKE_EVENT.set()
 with CHANGE_CONDITION:CHANGE_CONDITION.notify_all()
def notify_aggregate_changed():
 with CHANGE_CONDITION:CHANGE_CONDITION.notify_all()
def touch_source(cur,sid,sname,t,inc_upload=False):
 row=cur.execute('SELECT 1 FROM sources WHERE source_id=?',(sid,)).fetchone()
 if row:
  if inc_upload:cur.execute('UPDATE sources SET source_name=?,last_seen_at=?,last_upload_at=?,upload_count=upload_count+1 WHERE source_id=?',(sname,t,t,sid))
  else:cur.execute("UPDATE sources SET source_name=COALESCE(NULLIF(?,''),source_name),last_seen_at=? WHERE source_id=?",(sname,t,sid))
 else:cur.execute('INSERT INTO sources VALUES(?,?,?,?,?,?)',(sid,sname or sid,t,t,t if inc_upload else None,1 if inc_upload else 0))
def current_revision(cur):
 r=cur.execute("SELECT facts_revision FROM aggregate_state WHERE workspace_id='default'").fetchone();return int(r['facts_revision'] if r else 0)
def mark_changed(cur,changed,t):
 if changed:cur.execute("UPDATE aggregate_state SET facts_revision=facts_revision+1,status='stale',requested_at=?,last_error=NULL WHERE workspace_id='default'",(t,))
 return current_revision(cur)
def write_contact(cur,sid,sname,cid,i,t):
 j=dict(i);j['_syncSourceId']=sid;j['_syncSourceName']=sname;j['_syncUploadedAt']=t
 vals=(sid,sname,cid,str(pick(i,['platform','site','app'])),str(pick(i,['name','displayName','title','nickname'])),str(pick(i,['phone','tel','number'])),str(pick(i,['manualPhone','manual_phone','phoneManual'])),int(pick(i,['updatedAt','updateTime','mtime','lastModified'],0) or 0),int(pick(i,['createdAt','createTime','ctime'],0) or 0),t,jd(j))
 cur.execute('INSERT INTO contacts(source_id,source_name,contact_id,platform,name,phone,manual_phone,updated_at,created_at,last_seen_at,contact_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,contact_id) DO UPDATE SET source_name=excluded.source_name,platform=excluded.platform,name=excluded.name,phone=excluded.phone,manual_phone=excluded.manual_phone,updated_at=excluded.updated_at,created_at=excluded.created_at,last_seen_at=excluded.last_seen_at,contact_json=excluded.contact_json',vals)
def upsert(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;items=payload.get('items') or [];t=int(payload.get('uploadedAt') or now_ms())
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(items,list):return {'ok':False,'error':'items must be array'}
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
    saved+=1
   rev=mark_changed(cur,changed,t);c.commit();notify_facts_changed() if changed else None;return {'ok':True,'sourceId':sid,'sourceName':sname,'received':len(items),'saved':saved,'skipped':skipped,'unchanged':unchanged,'factsChanged':changed,'factsRevision':rev,'uploadedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':str(e),'trace':traceback.format_exc()}
  finally:c.close()
def delete_contacts(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;t=int(payload.get('deletedAt') or now_ms());ids=payload.get('contactIds')
 if ids is None:
  one=payload.get('contactId') or payload.get('id') or payload.get('key');ids=[one] if one else []
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(ids,list):return {'ok':False,'error':'contactIds must be array'}
 ids=list(dict.fromkeys(str(x) for x in ids if x not in (None,'')))
 if not ids:return {'ok':False,'error':'missing contactId/contactIds'}
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');touch_source(cur,sid,sname,t,False);deleted=0
   for cid in ids:
    cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));deleted+=max(cur.rowcount,0);cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
   rev=mark_changed(cur,deleted>0,t);c.commit();notify_facts_changed() if deleted>0 else None;return {'ok':True,'sourceId':sid,'requested':len(ids),'deleted':deleted,'factsChanged':deleted>0,'factsRevision':rev,'deletedAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':str(e),'trace':traceback.format_exc()}
  finally:c.close()
def reconcile_source(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;t=int(payload.get('reconciledAt') or now_ms());ids=payload.get('contactIds') if 'contactIds' in payload else payload.get('ids')
 if not sid:return {'ok':False,'error':'missing sourceId'}
 if not isinstance(ids,list):return {'ok':False,'error':'contactIds must be array'}
 keep=set(str(x) for x in ids if x not in (None,''))
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE');touch_source(cur,sid,sname,t,False);all_ids=[r['contact_id'] for r in cur.execute('SELECT contact_id FROM contacts WHERE source_id=?',(sid,)).fetchall()];remove=[x for x in all_ids if x not in keep]
   for cid in remove:cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
   rev=mark_changed(cur,bool(remove),t);c.commit();notify_facts_changed() if remove else None;return {'ok':True,'sourceId':sid,'kept':len(keep),'before':len(all_ids),'after':len(all_ids)-len(remove),'deleted':len(remove),'factsChanged':bool(remove),'factsRevision':rev,'reconciledAt':t}
  except Exception as e:c.rollback();return {'ok':False,'error':str(e),'trace':traceback.format_exc()}
  finally:c.close()

def _validate_snapshot(payload):
 sid=str(payload.get('sourceId') or '').strip();sname=str(payload.get('sourceName') or '').strip() or sid;epoch=str(payload.get('clientEpoch') or '').strip();bid=str(payload.get('batchId') or '').strip();items=payload.get('items');t=int(payload.get('uploadedAt') or now_ms())
 try:seq=int(payload.get('snapshotSeq'))
 except Exception:return None,({'ok':False,'error':'snapshotSeq must be integer'},400)
 if not sid:return None,({'ok':False,'error':'missing sourceId'},400)
 if not epoch:return None,({'ok':False,'error':'missing clientEpoch'},400)
 if not bid:return None,({'ok':False,'error':'missing batchId'},400)
 if seq<1:return None,({'ok':False,'error':'snapshotSeq must be positive'},400)
 if not isinstance(items,list):return None,({'ok':False,'error':'items must be array'},400)
 clean=[];seen=set()
 for i in items:
  if not isinstance(i,dict):return None,({'ok':False,'error':'snapshot item must be object'},400)
  cid=norm_id_strict(i)
  if not cid:return None,({'ok':False,'error':'snapshot item missing contactId'},400)
  if is_derived(i,cid):continue
  if cid in seen:return None,({'ok':False,'error':'duplicate contactId in snapshot','contactId':cid},400)
  seen.add(cid);clean.append((cid,i,fact_hash(i)))
 clean.sort(key=lambda x:x[0]);snap=sha(canonical([[cid,business_fact(i)] for cid,i,_ in clean]));req=sha(canonical({'sourceId':sid,'clientEpoch':epoch,'snapshotSeq':seq,'snapshotHash':snap}))
 return (sid,sname,epoch,bid,seq,t,clean,snap,req),None
def sync_snapshot(payload):
 v,err=_validate_snapshot(payload)
 if err:return err
 sid,sname,epoch,bid,seq,t,clean,snap,req=v
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE')
   oldbatch=cur.execute('SELECT * FROM sync_batches WHERE source_id=? AND client_epoch=? AND batch_id=?',(sid,epoch,bid)).fetchone()
   if oldbatch:
    if oldbatch['request_hash']!=req:c.rollback();return {'ok':False,'conflict':True,'reason':'batch-content-mismatch'},409
    if oldbatch['status']=='completed' and oldbatch['response_json']:
     response=json.loads(oldbatch['response_json']);response['idempotent']=True;c.rollback();return response,200
   head=cur.execute('SELECT * FROM source_sync_heads WHERE source_id=?',(sid,)).fetchone()
   if head and head['active_client_epoch']!=epoch:
    c.rollback();return {'ok':False,'conflict':True,'reason':'client-epoch-mismatch','activeClientEpoch':head['active_client_epoch'],'serverAckSeq':int(head['ack_seq'])},409
   ack=int(head['ack_seq']) if head else 0;server_snap=str(head['last_snapshot_hash'] or '') if head else ''
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
   remove=[cid for cid in oldhash if cid not in newids]
   for cid in remove:cur.execute('DELETE FROM contacts WHERE source_id=? AND contact_id=?',(sid,cid));cur.execute('DELETE FROM contact_fact_hashes WHERE source_id=? AND contact_id=?',(sid,cid))
   changed=bool(saved or remove);rev=mark_changed(cur,changed,t)
   cur.execute('INSERT INTO source_sync_heads(source_id,active_client_epoch,ack_seq,last_batch_id,last_snapshot_hash,activated_at,last_received_at,last_error) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(source_id) DO UPDATE SET ack_seq=excluded.ack_seq,last_batch_id=excluded.last_batch_id,last_snapshot_hash=excluded.last_snapshot_hash,last_received_at=excluded.last_received_at,last_error=NULL',(sid,epoch,seq,bid,snap,t,t))
   cur.execute('INSERT INTO source_sync_state(source_id,client_epoch,ack_seq,last_batch_id,last_snapshot_hash,last_received_at,last_error) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(source_id,client_epoch) DO UPDATE SET ack_seq=excluded.ack_seq,last_batch_id=excluded.last_batch_id,last_snapshot_hash=excluded.last_snapshot_hash,last_received_at=excluded.last_received_at,last_error=NULL',(sid,epoch,seq,bid,snap,t))
   response={'ok':True,'applied':True,'sourceId':sid,'sourceName':sname,'clientEpoch':epoch,'batchId':bid,'snapshotSeq':seq,'serverAckSeq':seq,'serverSnapshotHash':snap,'received':len(clean),'saved':saved,'unchanged':unchanged,'deleted':len(remove),'factsChanged':changed,'factsRevision':rev,'aggregateStatus':'stale','serverTime':now_ms()}
   cur.execute("UPDATE sync_batches SET completed_at=?,status='completed',saved_count=?,unchanged_count=?,deleted_count=?,facts_changed=?,facts_revision=?,response_json=? WHERE source_id=? AND client_epoch=? AND batch_id=?",(now_ms(),saved,unchanged,len(remove),1 if changed else 0,rev,jd(response),sid,epoch,bid));c.commit();notify_facts_changed() if changed else None;return response,200
  except Exception as e:
   c.rollback();return {'ok':False,'error':str(e),'trace':traceback.format_exc()},500
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
def capabilities():return {'snapshotSyncV1':True,'syncStatusV1':True,'factsRevisionV1':True,'serverAggregateV1':True,'aggregateHashV1':True,'epochFenceV1':True,'aggregateWorkerV1':True,'changesLongPollV1':True}


def _aggregate_bundle(cur, facts_revision):
 """在同一 SQLite 事务中构造与旧接口同形的数据。排序增加稳定的次级键。"""
 contact_rows=cur.execute('SELECT * FROM contacts ORDER BY updated_at DESC,last_seen_at DESC,source_id ASC,contact_id ASC').fetchall()
 contact_items=[]
 for r in contact_rows:
  try:data=json.loads(r['contact_json'] or '{}')
  except Exception:data={}
  contact_items.append({'sourceId':r['source_id'],'sourceName':r['source_name'],'contactId':r['contact_id'],'platform':r['platform'],'name':r['name'],'phone':r['phone'],'manualPhone':r['manual_phone'],'updatedAt':r['updated_at'],'createdAt':r['created_at'],'lastSeenAt':r['last_seen_at'],'data':data})
 source_rows=cur.execute('SELECT s.*,COUNT(c.id) contact_count FROM sources s LEFT JOIN contacts c ON c.source_id=s.source_id GROUP BY s.source_id ORDER BY s.last_seen_at DESC,s.source_id ASC').fetchall()
 source_items=[{'sourceId':r['source_id'],'sourceName':r['source_name'],'firstSeenAt':r['first_seen_at'],'lastSeenAt':r['last_seen_at'],'lastUploadAt':r['last_upload_at'],'uploadCount':r['upload_count'],'count':r['contact_count']} for r in source_rows]
 stats_data={'ok':True,'totalContacts':len(contact_items),'totalSources':len(source_items),'factsRevision':facts_revision}
 return {'contacts':contact_items,'sources':source_items,'stats':stats_data}

def _server_aggregate_once(force=False,allow_empty=False):
 """按 facts_revision 原子读取、生成并发布快照；旧 Revision 永不覆盖新事实。"""
 started=now_ms()
 with CONTACT_WRITE_LOCK:
  c=conn();cur=c.cursor()
  try:
   cur.execute('BEGIN IMMEDIATE')
   state=cur.execute("SELECT * FROM aggregate_state WHERE workspace_id='default'").fetchone()
   facts_rev=int(state['facts_revision'] if state else 0)
   snap=cur.execute("SELECT * FROM aggregate_snapshots WHERE workspace_id='default'").fetchone()
   if not force and snap and int(snap['facts_revision'])==facts_rev and state and state['status']=='ready':
    payload=json.loads(snap['payload_json']);c.commit()
    return {'ok':True,'cached':True,'status':'ready','factsRevision':facts_rev,'aggregateRevision':int(snap['aggregate_revision']),'aggregateHash':snap['aggregate_hash'],'contactCount':int(snap['contact_count']),'sourceCount':int(snap['source_count']),'createdAt':int(snap['created_at']),'durationMs':int(snap['duration_ms']),'payload':payload}
   cur.execute("UPDATE aggregate_state SET status='building',started_at=?,last_error=NULL WHERE workspace_id='default'",(started,))
   bundle=_aggregate_bundle(cur,facts_rev)
   # 空结果围栏：已有非空快照时，异常空结果不得覆盖；合法清空需显式 allowEmpty=1。
   if not bundle['contacts'] and snap and int(snap['contact_count'])>0 and not allow_empty:
    finished=now_ms();cur.execute("UPDATE aggregate_state SET status='stale',completed_at=?,last_error=? WHERE workspace_id='default'",(finished,'empty aggregate blocked; retry with allowEmpty=1 only for confirmed clear'));c.commit()
    return {'ok':False,'status':'stale','error':'empty aggregate blocked','emptyBlocked':True,'retainedSnapshot':True,'factsRevision':facts_rev,'aggregateRevision':int(snap['aggregate_revision']),'aggregateHash':snap['aggregate_hash'],'contactCount':int(snap['contact_count']),'sourceCount':int(snap['source_count'])}
   digest=sha(canonical(bundle));finished=now_ms();duration=max(0,finished-started)
   aggregate_rev=max(facts_rev,int(state['aggregate_revision'] if state else 0))
   payload_json=jd(bundle)
   cur.execute('INSERT INTO aggregate_snapshots(workspace_id,facts_revision,aggregate_revision,aggregate_hash,contact_count,source_count,payload_json,created_at,duration_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET facts_revision=excluded.facts_revision,aggregate_revision=excluded.aggregate_revision,aggregate_hash=excluded.aggregate_hash,contact_count=excluded.contact_count,source_count=excluded.source_count,payload_json=excluded.payload_json,created_at=excluded.created_at,duration_ms=excluded.duration_ms',('default',facts_rev,aggregate_rev,digest,len(bundle['contacts']),len(bundle['sources']),payload_json,finished,duration))
   # 同一写事务内再次读取 Revision，形成显式一致性围栏。
   if current_revision(cur)!=facts_rev:raise RuntimeError('facts revision changed during aggregate')
   cur.execute("UPDATE aggregate_state SET aggregate_revision=?,status='ready',completed_at=?,last_error=NULL WHERE workspace_id='default'",(aggregate_rev,finished));c.commit()
   return {'ok':True,'cached':False,'status':'ready','factsRevision':facts_rev,'aggregateRevision':aggregate_rev,'aggregateHash':digest,'contactCount':len(bundle['contacts']),'sourceCount':len(bundle['sources']),'createdAt':finished,'durationMs':duration,'payload':bundle}
  except Exception as e:
   c.rollback()
   try:
    c.execute("UPDATE aggregate_state SET status='error',completed_at=?,last_error=? WHERE workspace_id='default'",(now_ms(),str(e)));c.commit()
   except Exception:c.rollback()
   return {'ok':False,'status':'error','error':str(e),'trace':traceback.format_exc()}
  finally:c.close()

def server_aggregate(force=False,allow_empty=False):
 with AGGREGATE_SINGLE_FLIGHT_LOCK:result=_server_aggregate_once(force,allow_empty)
 notify_aggregate_changed();return result

def aggregate_change_state():
 c=conn();cur=c.cursor()
 try:
  state=cur.execute("SELECT * FROM aggregate_state WHERE workspace_id='default'").fetchone()
  snap=cur.execute("SELECT aggregate_hash,contact_count,source_count,created_at FROM aggregate_snapshots WHERE workspace_id='default'").fetchone()
  return {'factsRevision':int(state['facts_revision'] if state else 0),'aggregateRevision':int(state['aggregate_revision'] if state else 0),'status':str(state['status'] if state else 'stale'),'aggregateHash':str(snap['aggregate_hash'] if snap else ''),'contactCount':int(snap['contact_count'] if snap else 0),'sourceCount':int(snap['source_count'] if snap else 0),'createdAt':int(snap['created_at'] if snap else 0),'lastError':state['last_error'] if state else None}
 finally:c.close()

def wait_for_changes(q):
 def qint(name,default):
  try:return int((q.get(name) or [default])[0])
  except Exception:return default
 sf=qint('sinceFactsRevision',-1);sa=qint('sinceAggregateRevision',-1);sh=str((q.get('sinceHash') or [''])[0]);ss=str((q.get('sinceStatus') or [''])[0]);deadline=time.monotonic()+max(1,min(qint('timeout',25),25))
 while not SERVICE_STOP_EVENT.is_set():
  state=aggregate_change_state();changed=state['factsRevision']!=sf or state['aggregateRevision']!=sa or state['aggregateHash']!=sh or (bool(ss) and state['status']!=ss)
  if changed:return dict({'ok':True,'changed':True,'serverTime':now_ms()},**state)
  remaining=deadline-time.monotonic()
  if remaining<=0:return dict({'ok':True,'changed':False,'serverTime':now_ms()},**state)
  with CHANGE_CONDITION:CHANGE_CONDITION.wait(timeout=min(remaining,1.0))
 state=aggregate_change_state();return dict({'ok':True,'changed':False,'stopping':True,'serverTime':now_ms()},**state)

def aggregate_worker():
 while not SERVICE_STOP_EVENT.is_set():
  if not AGGREGATE_WAKE_EVENT.wait(0.5):continue
  AGGREGATE_WAKE_EVENT.clear();first=time.monotonic();last=first
  while not SERVICE_STOP_EVENT.is_set():
   remaining=min(AGGREGATE_DEBOUNCE_SECONDS-(time.monotonic()-last),AGGREGATE_MAX_WAIT_SECONDS-(time.monotonic()-first))
   if remaining<=0:break
   if AGGREGATE_WAKE_EVENT.wait(remaining):AGGREGATE_WAKE_EVENT.clear();last=time.monotonic()
   else:break
  if not SERVICE_STOP_EVENT.is_set():
   result=server_aggregate(False,False)
   if not result.get('ok') and not result.get('emptyBlocked'):time.sleep(0.5);AGGREGATE_WAKE_EVENT.set()

def start_background_services():
 SERVICE_STOP_EVENT.clear();thread=threading.Thread(target=aggregate_worker,name='v129-aggregate-worker',daemon=True);thread.start();state=aggregate_change_state()
 if state['status']!='ready' or state['aggregateRevision']!=state['factsRevision']:AGGREGATE_WAKE_EVENT.set()
 return thread

def stop_background_services(thread=None):
 SERVICE_STOP_EVENT.set();AGGREGATE_WAKE_EVENT.set()
 with CHANGE_CONDITION:CHANGE_CONDITION.notify_all()
 if thread and thread.is_alive():thread.join(timeout=3)

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
    except Exception as e:c.rollback();return {'ok':False,'error':str(e),'trace':traceback.format_exc()},500
    finally:c.close()
def re_match_color(v):
    import re
    return bool(re.match(r'^#[0-9a-fA-F]{6}$',v))


def sources():
 c=conn();rows=c.execute('SELECT s.*,COUNT(c.id) contact_count FROM sources s LEFT JOIN contacts c ON c.source_id=s.source_id GROUP BY s.source_id ORDER BY s.last_seen_at DESC,s.source_id ASC').fetchall();c.close();return {'ok':True,'items':[{'sourceId':r['source_id'],'sourceName':r['source_name'],'firstSeenAt':r['first_seen_at'],'lastSeenAt':r['last_seen_at'],'lastUploadAt':r['last_upload_at'],'uploadCount':r['upload_count'],'count':r['contact_count']} for r in rows]}
def contacts(q):
 sid=(q.get('sourceId') or [''])[0];c=conn();rows=(c.execute('SELECT * FROM contacts WHERE source_id=? ORDER BY updated_at DESC,last_seen_at DESC,source_id ASC,contact_id ASC',(sid,)).fetchall() if sid else c.execute('SELECT * FROM contacts ORDER BY updated_at DESC,last_seen_at DESC,source_id ASC,contact_id ASC').fetchall());c.close();out=[]
 for r in rows:
  try:data=json.loads(r['contact_json'] or '{}')
  except Exception:data={}
  out.append({'sourceId':r['source_id'],'sourceName':r['source_name'],'contactId':r['contact_id'],'platform':r['platform'],'name':r['name'],'phone':r['phone'],'manualPhone':r['manual_phone'],'updatedAt':r['updated_at'],'createdAt':r['created_at'],'lastSeenAt':r['last_seen_at'],'data':data})
 return {'ok':True,'count':len(out),'items':out}
def stats():
 c=conn();cur=c.cursor();tc=cur.execute('SELECT COUNT(*) n FROM contacts').fetchone()['n'];ts=cur.execute('SELECT COUNT(*) n FROM sources').fetchone()['n'];rev=current_revision(cur);c.close();return {'ok':True,'totalContacts':tc,'totalSources':ts,'factsRevision':rev}
class H(BaseHTTPRequestHandler):
 def log_message(self,fmt,*args):print('[HTTP]',fmt%args)
 def sendj(self,d,st=200):
  b=jd(d).encode('utf-8');self.send_response(st);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Requested-With');self.end_headers();self.wfile.write(b)
 def do_OPTIONS(self):self.send_response(204);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Requested-With');self.end_headers()
 def do_GET(self):
  try:
   p=urlparse(self.path);q=parse_qs(p.query)
   if p.path=='/api/health':return self.sendj({'ok':True,'service':'wa-remark-local-sync','version':APP_VERSION,'sharedConfig':True,'time':now_ms(),'dbPath':str(DB_PATH),'capabilities':capabilities()})
   if p.path=='/api/v129/sync/status':return self.sendj(sync_status(q))
   if p.path=='/api/v129/changes':return self.sendj(wait_for_changes(q))
   if p.path=='/api/v129/aggregate':
    r=server_aggregate((q.get('force') or ['0'])[0]=='1',(q.get('allowEmpty') or ['0'])[0]=='1');return self.sendj(r,200 if r.get('ok') else 409 if r.get('emptyBlocked') else 500)
   if p.path=='/api/shared-config':return self.sendj(get_shared_config((q.get('workspaceId') or ['default'])[0],(q.get('includeArchived') or ['0'])[0]=='1'))
   if p.path=='/api/sources':return self.sendj(sources())
   if p.path=='/api/contacts':return self.sendj(contacts(q))
   if p.path=='/api/stats':return self.sendj(stats())
   return self.sendj({'ok':False,'error':'not found','path':p.path},404)
  except Exception as e:return self.sendj({'ok':False,'error':str(e),'trace':traceback.format_exc()},500)
 def do_POST(self):
  try:
   p=urlparse(self.path);n=int(self.headers.get('Content-Length','0') or 0);payload=json.loads(self.rfile.read(n).decode('utf-8') if n else '{}')
   if p.path=='/api/v129/sync/snapshot':r,st=sync_snapshot(payload);return self.sendj(r,st)
   if p.path in ('/api/shared-config/update','/api/shared-config/initialize'):r,st=update_shared_config(payload);return self.sendj(r,st)
   if p.path=='/api/contacts/batch-upsert':r=upsert(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path in ('/api/contacts/delete','/api/contacts/batch-delete'):r=delete_contacts(payload);return self.sendj(r,200 if r.get('ok') else 400)
   if p.path in ('/api/contacts/source-reconcile','/api/contacts/reconcile','/api/contacts/full-sync-clean'):r=reconcile_source(payload);return self.sendj(r,200 if r.get('ok') else 400)
   return self.sendj({'ok':False,'error':'not found','path':p.path},404)
  except Exception as e:return self.sendj({'ok':False,'error':str(e),'trace':traceback.format_exc()},500)
def main():
 init_db();worker=start_background_services();server=ThreadingHTTPServer((HOST,PORT),H)
 print('='*70);print('聚宝盆客户信息管理系统 - 本地同步服务 v'+APP_VERSION);print(f'服务地址：http://{HOST}:{PORT}');print(f'数据库：{DB_PATH}');print('v129.0.1 Alpha：后台聚合、长轮询通知、Revision/SHA-256 围栏与本地回退');print('='*70)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:server.server_close();stop_background_services(worker)
if __name__=='__main__':main()
