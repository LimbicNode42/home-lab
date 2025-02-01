-- Add your migration SQL here
CREATE TABLE IF NOT EXISTS state (
  id SERIAL PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now()
);
