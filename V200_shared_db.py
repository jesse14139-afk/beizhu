# -*- coding: utf-8 -*-
"""聚宝盆 V200 数据层。仅中心服务可访问 SQLite。"""
from __future__ import annotations
import sqlite3, contextlib, json, time, hashlib, shutil
from pathlib import Path

SCHEMA_VERSION=200
SCHEMA=r"""
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(workspace_id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,device_name TEXT NOT NULL,first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,last_change_cursor INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sources(source_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,channel TEXT NOT NULL,account_identity TEXT NOT NULL,source_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,last_device_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',UNIQUE(workspace_id,channel,account_identity));
CREATE TABLE IF NOT EXISTS contacts(contact_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,channel TEXT NOT NULL,external_contact_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',observed_phone TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',manual_name TEXT NOT NULL DEFAULT '',manual_phone TEXT NOT NULL DEFAULT '',remark TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,deleted_at INTEGER,deleted_by TEXT,delete_reason TEXT,observed_json TEXT NOT NULL DEFAULT '{}',business_json TEXT NOT NULL DEFAULT '{}',observation_hash TEXT NOT NULL DEFAULT '',UNIQUE(workspace_id,source_id,channel,external_contact_id));
CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(workspace_id,source_id,deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(workspace_id,observed_phone,manual_phone);
CREATE TABLE IF NOT EXISTS tags(tag_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#64748b',category TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(workspace_id,name));
CREATE TABLE IF NOT EXISTS contact_tags(contact_id TEXT NOT NULL,tag_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(contact_id,tag_id),FOREIGN KEY(contact_id) REFERENCES contacts(contact_id),FOREIGN KEY(tag_id) REFERENCES tags(tag_id));
CREATE TABLE IF NOT EXISTS customers(customer_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',primary_phone TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,business_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS customer_contacts(customer_id TEXT NOT NULL,contact_id TEXT NOT NULL,link_type TEXT NOT NULL DEFAULT 'manual',confidence REAL NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(customer_id,contact_id),FOREIGN KEY(customer_id) REFERENCES customers(customer_id),FOREIGN KEY(contact_id) REFERENCES contacts(contact_id));
CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,device_id TEXT NOT NULL,source_id TEXT,session_id TEXT,entity_type TEXT NOT NULL,entity_id TEXT,operation TEXT NOT NULL,base_version INTEGER,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result_version INTEGER,error_code TEXT,created_at INTEGER NOT NULL,applied_at INTEGER,result_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_events_time ON events(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS changes(change_id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,operation TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT,changed_at INTEGER NOT NULL,payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_changes_cursor ON changes(workspace_id,change_id);
CREATE TABLE IF NOT EXISTS audit_logs(audit_id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT,operation TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS delete_confirmations(confirmation_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,expected_version INTEGER NOT NULL,impact_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_records(backup_id TEXT PRIMARY KEY,file_name TEXT NOT NULL,created_at INTEGER NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL);
"""

def now_ms(): return int(time.time()*1000)
def dumps(v): return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def loads(v,default=None):
    try: return json.loads(v) if v else default
    except Exception: return default
def sha256_bytes(b): return hashlib.sha256(b).hexdigest()

class Database:
    def __init__(self,path): self.path=Path(path).resolve(); self.path.parent.mkdir(parents=True,exist_ok=True)
    def connect(self):
        c=sqlite3.connect(str(self.path),timeout=30,isolation_level=None,check_same_thread=False)
        c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); c.execute('PRAGMA busy_timeout=30000'); c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA synchronous=FULL')
        return c
    @contextlib.contextmanager
    def tx(self,immediate=True):
        c=self.connect()
        try:
            c.execute('BEGIN IMMEDIATE' if immediate else 'BEGIN')
            yield c; c.execute('COMMIT')
        except Exception:
            c.execute('ROLLBACK'); raise
        finally: c.close()
    def init(self):
        c=self.connect()
        try:
            c.executescript(SCHEMA); t=now_ms()
            c.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?)',('default','默认工作区',t,t))
            c.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('schema_version',str(SCHEMA_VERSION)))
            if c.execute('PRAGMA quick_check').fetchone()[0] != 'ok': raise RuntimeError('SQLite quick_check 失败')
        finally: c.close()
    def quick_check(self):
        c=self.connect()
        try: return c.execute('PRAGMA quick_check').fetchone()[0]
        finally: c.close()
    def backup(self,directory):
        directory=Path(directory); directory.mkdir(parents=True,exist_ok=True)
        name='jubo_v200_'+time.strftime('%Y%m%d_%H%M%S')+'.sqlite'; target=directory/name
        src=self.connect(); dst=sqlite3.connect(str(target))
        try: src.backup(dst)
        finally: dst.close(); src.close()
        digest=sha256_bytes(target.read_bytes())
        return target,digest
