-- D1 schema for VIPONLYTRADER Scanner
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS universe (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER);
CREATE TABLE IF NOT EXISTS bars5 (key TEXT NOT NULL, day TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (key, day));
CREATE TABLE IF NOT EXISTS daily (key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, profile TEXT, date TEXT, status TEXT, score INTEGER, json TEXT NOT NULL, updated INTEGER);
CREATE INDEX IF NOT EXISTS cards_profile_date ON cards(profile, date);
CREATE INDEX IF NOT EXISTS cards_date_status ON cards(date, status);
CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, date TEXT, agent TEXT, setup TEXT, root TEXT, horizon TEXT, structure TEXT, score INTEGER, result TEXT, r REAL);
CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, json TEXT, profile TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS ivhist (key TEXT NOT NULL, day TEXT NOT NULL, iv REAL, PRIMARY KEY (key, day));
CREATE TABLE IF NOT EXISTS scanners (id TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS greeks (key TEXT NOT NULL, day TEXT NOT NULL, ts TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (key, day, ts));
-- Signal ledger: append-only, hash-chained (src/ledger.ts). Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, json TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_kind_ts ON ledger(kind, ts);
-- Your real trades (src/journal.ts). Every change is also written to the ledger.
CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, card_id TEXT, key TEXT, status TEXT, created INTEGER, updated INTEGER, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS journal_status ON journal(status);
-- Reserved for commercial use (not used while COMMERCIAL.mode = "personal"); see COMMERCIAL.md.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, profile TEXT, role TEXT, created INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT, plan TEXT, status TEXT, starts TEXT, ends TEXT, json TEXT);
