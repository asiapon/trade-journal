-- ============================================================================
-- 操作日记 · Cloudflare D1 schema（v3.19.0，从 deploy/schema.sql 逐函数移植）
-- ----------------------------------------------------------------------------
-- 与 PG 版差异（语义对齐、方言改写）：
--   · jsonb → TEXT（JSON.stringify/parse 由 Worker 层处理）
--   · bcrypt(crypt bf) → PBKDF2-SHA256（WebCrypto，Worker 层实现，格式
--     pbkdf2$<iter>$<salt_b64>$<hash_b64>，自描述可平滑升迭代数）
--   · RLS / SECURITY DEFINER → 全部访问经 Worker，owner_id 隔离在 SQL WHERE 里
--   · timestamptz → TEXT（ISO 8601）；numeric → REAL；boolean → INTEGER 0/1
--   · 新增 net_log：前端调用日志（对应自托管的 deploy/logs/app-日期.log）
-- 幂等：可重复执行。
-- ============================================================================

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  transaction_time TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  market TEXT NOT NULL DEFAULT 'sh',
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  gross_amount REAL,
  fee TEXT NOT NULL DEFAULT '{}',
  net_amount REAL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades(owner_id, id);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  group_name TEXT DEFAULT '默认',
  note TEXT,
  cur_price REAL,
  prev_close REAL,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_watchlist_owner ON watchlist(owner_id, id);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  price REAL,
  prev_close REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quotes_owner ON quotes(owner_id, id);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_settings_owner ON settings(owner_id, id);

CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT,
  ref_table TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_oplogs_owner ON op_logs(owner_id, id);

CREATE TABLE IF NOT EXISTS qa_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_qahist_owner ON qa_history(owner_id, id);

CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  must_change_pwd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS app_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON app_sessions(expires_at);

-- 全市场日K库（每股一行，bars 为紧凑数组 JSON；动量筛选数据底座）
CREATE TABLE IF NOT EXISTS kline_cache (
  code TEXT PRIMARY KEY,
  name TEXT,
  bars TEXT NOT NULL DEFAULT '[]',
  days INTEGER NOT NULL DEFAULT 0,
  updated TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 前端调用日志（对应自托管 deploy/logs/app-日期.log，按 day 分组可下载）
CREATE TABLE IF NOT EXISTS net_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT,
  name TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  src TEXT
);
CREATE INDEX IF NOT EXISTS idx_netlog_day ON net_log(day, id);
