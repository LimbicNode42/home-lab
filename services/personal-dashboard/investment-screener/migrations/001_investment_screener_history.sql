-- Investment screener Postgres historical storage schema.
-- Review-safe: CREATE IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS investment_screener_runs (
  id BIGSERIAL PRIMARY KEY,
  run_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'completed',
  market TEXT NOT NULL DEFAULT 'ASX',
  mode TEXT NOT NULL,
  universe_version TEXT,
  source_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
  code_version TEXT,
  config_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  universe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_failures JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_runs_run_key
  ON investment_screener_runs(run_key);

CREATE TABLE IF NOT EXISTS investment_screener_companies (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  asx_code TEXT,
  name TEXT,
  market TEXT,
  exchange TEXT,
  region TEXT,
  sector TEXT,
  industry TEXT,
  currency TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  identity_provenance JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS investment_screener_observations (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  period_end DATE,
  data_as_of DATE,
  currency TEXT,
  source_quality TEXT,
  raw_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  derived_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  alternates JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS investment_screener_scores (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  rank INTEGER,
  excluded BOOLEAN NOT NULL DEFAULT false,
  composite_score NUMERIC,
  sub_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_penalty_points NUMERIC,
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  caveats JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_caps JSONB NOT NULL DEFAULT '{}'::jsonb,
  exclusion_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS investment_screener_provenance (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES investment_screener_companies(id),
  field_name TEXT,
  source_family TEXT,
  source_url TEXT,
  retrieved_at TIMESTAMPTZ,
  source_reported_at DATE,
  data_as_of DATE,
  trust_level TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'not_attempted',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_provenance_dedupe
  ON investment_screener_provenance(run_id, company_id, field_name, source_family, source_url, data_as_of);

CREATE TABLE IF NOT EXISTS investment_screener_price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  trading_date DATE,
  price NUMERIC,
  currency TEXT,
  source_family TEXT,
  source_quality TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, observed_at, source_family)
);

ALTER TABLE investment_screener_runs
  ADD COLUMN IF NOT EXISTS run_key TEXT,
  ADD COLUMN IF NOT EXISTS universe_version TEXT,
  ADD COLUMN IF NOT EXISTS source_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS code_version TEXT,
  ADD COLUMN IF NOT EXISTS config_hash TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS universe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_failures JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE investment_screener_companies
  ADD COLUMN IF NOT EXISTS asx_code TEXT,
  ADD COLUMN IF NOT EXISTS sector TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS identity_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE investment_screener_observations
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS source_quality TEXT,
  ADD COLUMN IF NOT EXISTS derived_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS selected_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS alternates JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS field_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_confidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE investment_screener_scores
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES investment_screener_companies(id),
  ADD COLUMN IF NOT EXISTS score_version TEXT;

CREATE INDEX IF NOT EXISTS idx_iss_scores_ticker_created ON investment_screener_scores(ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_iss_obs_ticker_asof ON investment_screener_observations(ticker, data_as_of DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_obs_run_company ON investment_screener_observations(run_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_scores_run_company ON investment_screener_scores(run_id, company_id);
CREATE INDEX IF NOT EXISTS idx_iss_price_ticker_observed ON investment_screener_price_snapshots(ticker, observed_at DESC);
