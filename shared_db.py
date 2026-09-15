# -*- coding: utf-8 -*-
"""聚宝盆共享库抽象层 v132
--------------------------------------------------------------
设计目标：把"本地单机 SQLite"平滑升级为"多机共用的共享库"，
同时让上层服务代码保持 sqlite 风格不变（? 占位符、PRAGMA、
INSERT OR IGNORE、AUTOINCREMENT、ON CONFLICT 等），由本层在
postgres 后端做自动翻译。

两种后端（通过环境变量切换，默认 sqlite）：
  sqlite   —— 库文件由"中心服务进程"独占。多机共享的正确形态是
              所有客户端通过 HTTP API 访问中心服务，而不是把
              SQLite 文件放到网盘/NFS 上共享（网络文件锁不可靠，
              极易损坏）。适合 2~10 台电脑的小团队。
  postgres —— 需要独立安装 PostgreSQL 服务端 + Python 依赖：
              pip install psycopg2-binary
              环境变量：
                JUBO_DB_TYPE=postgres
                JUBO_PG_DSN=postgresql://user:pass@host:5432/dbname
              适合更高并发、更大团队或需要异地容灾的场景。

环境变量：
  JUBO_DB_TYPE   sqlite | postgres（默认 sqlite）
  JUBO_PG_DSN    postgres 连接串（DB_TYPE=postgres 时必填）
"""
import os
import re

DB_TYPE = (os.environ.get('JUBO_DB_TYPE', 'sqlite') or 'sqlite').strip().lower()
if DB_TYPE not in ('sqlite', 'postgres'):
    DB_TYPE = 'sqlite'
PG_DSN = (os.environ.get('JUBO_PG_DSN', '') or '').strip()

_DB_PATH = None  # 由 configure() 注入（sqlite 模式使用）


def configure(db_path=None, db_type=None, pg_dsn=None):
    global DB_TYPE, PG_DSN, _DB_PATH
    if db_type is not None:
        DB_TYPE = str(db_type).strip().lower()
        if DB_TYPE not in ('sqlite', 'postgres'):
            DB_TYPE = 'sqlite'
    if pg_dsn is not None:
        PG_DSN = str(pg_dsn).strip()
    if db_path is not None:
        _DB_PATH = db_path


def db_type():
    return DB_TYPE


# ---------------------------------------------------------------
# postgres SQL 自动翻译（纯函数，便于单测）
# ---------------------------------------------------------------
_OR_REPLACE_PKS = {
    # 用到了 INSERT OR REPLACE 的表及其主键列（按 CREATE TABLE 定义）
    'sync_batches': ('source_id', 'client_epoch', 'batch_id'),
}


def translate_pg_sql(sql):
    """把 sqlite 风格 SQL 翻译成 PostgreSQL 语法；返回 None 表示无需执行（PRAGMA 等）。"""
    if sql is None:
        return None
    s = sql.strip()
    if not s:
        return None
    low = s.lower()
    # PRAGMA：postgres 无对应概念，跳过
    if low.startswith('pragma '):
        return None
    # 事务指令
    if low.startswith('begin immediate'):
        return 'BEGIN'
    # INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
    if low.startswith('insert or ignore into'):
        s = re.sub(r'^INSERT OR IGNORE INTO', 'INSERT INTO', s, flags=re.I)
        s = s.rstrip().rstrip(';').rstrip()
        s += ' ON CONFLICT DO NOTHING'
    # INSERT OR REPLACE -> INSERT ... ON CONFLICT(pk) DO UPDATE SET 非主键列
    if low.startswith('insert or replace into'):
        m = re.match(r'INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES', s, flags=re.I)
        if not m:
            raise ValueError('无法翻译 INSERT OR REPLACE: ' + sql)
        tbl = m.group(1)
        pks = _OR_REPLACE_PKS.get(tbl)
        if not pks:
            raise ValueError('未配置 OR REPLACE 主键的表: ' + tbl)
        cols = [c.strip() for c in m.group(2).split(',')]
        nonpk = [c for c in cols if c not in pks]
        upd = ', '.join('%s=EXCLUDED.%s' % (c, c) for c in nonpk) if nonpk else 'source_id=EXCLUDED.source_id'
        s = re.sub(r'^INSERT\s+OR\s+REPLACE\s+INTO', 'INSERT INTO', s, flags=re.I)
        s = s.rstrip().rstrip(';').rstrip()
        s += ' ON CONFLICT (' + ','.join(pks) + ') DO UPDATE SET ' + upd
    # ON CONFLICT( 需要空格（PG 语法）
    s = re.sub(r'ON CONFLICT\(', 'ON CONFLICT (', s, flags=re.I)
    # sqlite 自增主键 -> PG 序列
    s = re.sub(r'INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGSERIAL PRIMARY KEY', s, flags=re.I)
    # ? 占位符 -> %s
    s = re.sub(r'\?', '%s', s)
    return s


# ---------------------------------------------------------------
# postgres 行包装：支持按列名访问（兼容 sqlite3.Row 用法）
# ---------------------------------------------------------------
class _PgRow(object):
    __slots__ = ('_values', '_keys')

    def __init__(self, values, keys):
        self._values = tuple(values)
        self._keys = tuple(keys)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        for i, k in enumerate(self._keys):
            if k == key:
                return self._values[i]
        raise KeyError(key)

    def __iter__(self):
        return iter(self._keys)

    def __len__(self):
        return len(self._values)

    def keys(self):
        return self._keys

    def get(self, key, default=None):
        try:
            return self[key]
        except (KeyError, IndexError):
            return default


class _PgCursor(object):
    def __init__(self, raw_cursor):
        self._c = raw_cursor
        self._keys = None

    def _translate(self, sql):
        t = translate_pg_sql(sql)
        if t is None:
            return None
        self._keys = None
        return t

    def execute(self, sql, params=None):
        t = self._translate(sql)
        if t is None:
            return self
        if params is None:
            self._c.execute(t)
        else:
            self._c.execute(t, tuple(params) if not isinstance(params, tuple) else params)
        if self._c.description is not None:
            self._keys = [d.name for d in self._c.description]
        else:
            self._keys = None
        return self

    def fetchone(self):
        row = self._c.fetchone()
        if row is None:
            return None
        return _PgRow(row, self._keys or [])

    def fetchall(self):
        rows = self._c.fetchall()
        keys = self._keys or []
        return [_PgRow(r, keys) for r in rows]

    @property
    def rowcount(self):
        return self._c.rowcount

    @property
    def lastrowid(self):
        return getattr(self._c, 'lastrowid', 0)

    @property
    def description(self):
        return self._c.description


class _PgConnection(object):
    def __init__(self, raw_conn):
        self._c = raw_conn

    def cursor(self):
        return _PgCursor(self._c.cursor())

    def commit(self):
        self._c.commit()

    def rollback(self):
        self._c.rollback()

    def close(self):
        try:
            self._c.close()
        except Exception:
            pass


def _pg_connect():
    if not PG_DSN:
        raise RuntimeError('DB_TYPE=postgres 但未设置 JUBO_PG_DSN（例如 JUBO_PG_DSN=postgresql://user:pass@127.0.0.1:5432/dbname）')
    try:
        import psycopg2
        return _PgConnection(psycopg2.connect(PG_DSN, autocommit=True))
    except Exception as e:
        if 'No module named' in str(e):
            raise RuntimeError('DB_TYPE=postgres 需要安装 psycopg2：pip install psycopg2-binary（原始错误：%s）' % e)
        raise


def connect():
    """返回一个与 sqlite3.Connection 用法兼容的连接对象（sqlite 原样 / postgres 包装）。"""
    if DB_TYPE == 'postgres':
        return _pg_connect()
    import sqlite3
    if _DB_PATH is None:
        raise RuntimeError('shared_db.configure(db_path=...) 尚未调用')
    c = sqlite3.connect(str(_DB_PATH), timeout=15)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA busy_timeout=15000')
    c.execute('PRAGMA foreign_keys=ON')
    return c
#（注：内容由AI生成）
