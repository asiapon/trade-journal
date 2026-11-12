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

-- v3.23.2 持仓表（当前持仓的持久化实体）：每笔交易/基线变动后由前端
-- 增量 upsert（没有就 INSERT，有就 UPDATE）；UI 首屏与导出直接读表，
-- 不再每次全量重放流水。qty=0 表示已清仓（清仓当日保留展示）。
-- v3.23.3 base_qty/base_cost：基线快照（is_base=1 行专用）——「基线日期收盘」
-- 的数量与成本价（最多 8 位小数）；行上的 qty/cost_price 是基线叠加后续
-- 流水后的当前值，两层含义分开存。settings.pos_base 中转层退役。
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  market TEXT NOT NULL DEFAULT 'sh',
  qty INTEGER NOT NULL DEFAULT 0,
  cost_price REAL,
  cost_value REAL,
  diluted_cost REAL,
  realized REAL,
  realized_op REAL,
  is_base INTEGER NOT NULL DEFAULT 0,
  base_date TEXT,
  base_qty REAL,
  base_cost REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_owner_code ON positions(owner_id, stock_code);

-- v3.23.3 已建过库的存量补列（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，
-- 重复执行报 duplicate column name 属正常；放文件末尾保证前面的建表先落地）
ALTER TABLE positions ADD COLUMN base_qty REAL;
ALTER TABLE positions ADD COLUMN base_cost REAL;
