import { randomBytes } from 'node:crypto';

const ENTRY_ID_PREFIX = 'd_';
const GOAL_ID_PREFIX = 'g_';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIARY_PREVIEW_CHARS = 180;
const GOAL_STATUSES = new Set(['active', 'paused', 'completed', 'archived']);

function publicError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validationError(message = 'Diary entry validation failed') {
  return publicError('validation_failed', message);
}

function goalValidationError(message = 'Goal validation failed') {
  return publicError('validation_failed', message);
}

function nowIso() {
  return new Date().toISOString();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function id(prefix) {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacters(value) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedOptionalText(value, maxLength, fieldName) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw validationError(`${fieldName} must be a string`);
  const text = value.trim();
  if (text.length > maxLength || hasControlCharacters(text)) throw validationError(`${fieldName} is invalid`);
  return text;
}

function normalizedRequiredText(value, maxLength, fieldName) {
  if (typeof value !== 'string') throw validationError(`${fieldName} is required`);
  const text = value.trim();
  if (text.length < 1 || text.length > maxLength || hasControlCharacters(text)) throw validationError(`${fieldName} is invalid`);
  return text;
}

function normalizeEntryDate(value) {
  if (value === undefined || value === null || value === '') return todayIsoDate();
  if (typeof value !== 'string') throw validationError('entry_date must be a date string');
  const text = value.trim();
  if (!validCalendarDate(text)) throw validationError('entry_date is invalid');
  return text;
}

function normalizeGoalStatus(value, { fallback = 'active', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw goalValidationError('status is required');
    return fallback;
  }
  if (typeof value !== 'string') throw goalValidationError('status must be a string');
  const status = value.trim();
  if (!GOAL_STATUSES.has(status)) throw goalValidationError('status is invalid');
  return status;
}

function normalizeGoalStatusFilter(value = 'all') {
  if (value === undefined || value === null || value === '' || value === 'all') return 'all';
  return normalizeGoalStatus(value, { required: true });
}

function normalizeGoalTargetDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw goalValidationError('target_date must be a date string');
  const text = value.trim();
  if (!validCalendarDate(text)) throw goalValidationError('target_date is invalid');
  return text;
}

function normalizeGoalIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw validationError('goal_ids is invalid');
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !/^g_[0-9a-f]{8,64}$/.test(raw)) throw publicError('invalid_goal_ids', 'One or more linked goals are invalid');
    if (!seen.has(raw)) {
      seen.add(raw);
      ids.push(raw);
    }
  }
  return ids;
}

function preview(body) {
  const compact = String(body ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > DIARY_PREVIEW_CHARS ? `${compact.slice(0, DIARY_PREVIEW_CHARS - 1)}…` : compact;
}

function entryFromRow(row, { includeBody = false, goals = [] } = {}) {
  if (!row) return null;
  const entry = {
    id: row.id,
    entry_date: row.entry_date,
    title: row.title,
    preview: preview(row.body),
    mood: row.mood,
    goal_ids: Array.isArray(goals) ? goals.map((goal) => goal.id ?? goal.goal_id ?? goal).filter(Boolean) : [],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (includeBody) {
    entry.body = row.body;
    entry.goals = goals.map((goal) => ({ id: goal.id, title: goal.title, status: goal.status }));
  }
  return entry;
}

function goalFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    target_date: row.target_date ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    archived_at: row.archived_at ?? null
  };
}

function normalizeGoalCreateInput(input) {
  if (!isPlainObject(input)) throw goalValidationError('Request body must be an object');
  return {
    title: normalizedRequiredText(input.title, 160, 'title'),
    description: normalizedOptionalText(input.description, 5000, 'description'),
    status: normalizeGoalStatus(input.status),
    target_date: normalizeGoalTargetDate(input.target_date)
  };
}

function normalizeGoalUpdateInput(input) {
  if (!isPlainObject(input)) throw goalValidationError('Request body must be an object');
  const patch = {};
  if (Object.hasOwn(input, 'title')) patch.title = normalizedRequiredText(input.title, 160, 'title');
  if (Object.hasOwn(input, 'description')) patch.description = normalizedOptionalText(input.description, 5000, 'description');
  if (Object.hasOwn(input, 'status')) patch.status = normalizeGoalStatus(input.status, { required: true });
  if (Object.hasOwn(input, 'target_date')) patch.target_date = normalizeGoalTargetDate(input.target_date);
  if (Object.keys(patch).length === 0) throw goalValidationError('At least one goal field is required');
  return patch;
}


async function assertExistingGoalIdsPg(client, goalIds) {
  if (goalIds.length === 0) return;
  const result = await client.query('SELECT id FROM goals WHERE id = ANY($1::text[])', [goalIds]);
  const found = new Set(result.rows.map((row) => row.id));
  if (found.size !== goalIds.length) throw publicError('invalid_goal_ids', 'One or more linked goals are invalid');
}

async function withPgClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withPgTransaction(pool, fn) {
  return withPgClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function migratePostgres(pool) {
  await withPgClient(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),
        description TEXT NOT NULL DEFAULT '' CHECK(char_length(description) <= 5000),
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'archived')),
        target_date DATE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS goals_status_updated_idx ON goals(status, updated_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS diary_entries (
        id TEXT PRIMARY KEY,
        entry_date DATE NOT NULL,
        title TEXT NOT NULL DEFAULT '' CHECK(char_length(title) <= 160),
        body TEXT NOT NULL CHECK(char_length(body) BETWEEN 1 AND 20000),
        mood TEXT NOT NULL DEFAULT '' CHECK(char_length(mood) <= 64),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS diary_entries_entry_date_idx ON diary_entries(entry_date DESC, created_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS diary_entry_goals (
        diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL DEFAULT 'manual' CHECK(link_type IN ('manual', 'future_assessment')),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (diary_entry_id, goal_id)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS diary_entry_goals_goal_idx ON diary_entry_goals(goal_id, diary_entry_id)');
  });
}

function pgRow(row) {
  if (!row) return null;
  const normalized = { ...row };
  for (const key of ['entry_date', 'target_date']) {
    if (normalized[key] instanceof Date) normalized[key] = normalized[key].toISOString().slice(0, 10);
  }
  for (const key of ['created_at', 'updated_at', 'completed_at', 'archived_at']) {
    if (normalized[key] instanceof Date) normalized[key] = normalized[key].toISOString();
  }
  return normalized;
}

export async function createPostgresPersonalDataStore({ connectionString, pool, ssl } = {}) {
  let ownedPool = null;
  let activePool = pool;
  if (!activePool) {
    if (!connectionString || typeof connectionString !== 'string') throw publicError('personal_data_not_configured', 'Personal dashboard data store is not configured');
    const { Pool } = await import('pg');
    ownedPool = new Pool({ connectionString, ssl });
    activePool = ownedPool;
  }
  await migratePostgres(activePool);

  return {
    async createGoal(input = {}) {
      const goalInput = normalizeGoalCreateInput(input);
      const created_at = nowIso();
      const goal = {
        id: id(GOAL_ID_PREFIX),
        ...goalInput,
        created_at,
        updated_at: created_at,
        completed_at: goalInput.status === 'completed' ? created_at : null,
        archived_at: goalInput.status === 'archived' ? created_at : null
      };
      await withPgClient(activePool, (client) => client.query(`
        INSERT INTO goals (id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [goal.id, goal.title, goal.description, goal.status, goal.target_date, goal.created_at, goal.updated_at, goal.completed_at, goal.archived_at]));
      return goalFromRow(goal);
    },

    async listGoals({ status = 'all' } = {}) {
      const normalizedStatus = normalizeGoalStatusFilter(status);
      const result = normalizedStatus === 'all'
        ? await withPgClient(activePool, (client) => client.query('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals ORDER BY status ASC, updated_at DESC, created_at DESC'))
        : await withPgClient(activePool, (client) => client.query('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals WHERE status = $1 ORDER BY updated_at DESC, created_at DESC', [normalizedStatus]));
      return result.rows.map((row) => goalFromRow(pgRow(row)));
    },

    async getGoal(goalId) {
      if (typeof goalId !== 'string' || !/^g_[0-9a-f]{8,64}$/.test(goalId)) return null;
      const result = await withPgClient(activePool, (client) => client.query('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals WHERE id = $1', [goalId]));
      return goalFromRow(pgRow(result.rows[0]));
    },

    async updateGoal(goalId, input = {}) {
      const patch = normalizeGoalUpdateInput(input);
      if (typeof goalId !== 'string' || !/^g_[0-9a-f]{8,64}$/.test(goalId)) return null;
      const existing = await this.getGoal(goalId);
      if (!existing) return null;
      const updated_at = nowIso();
      const next = { ...existing, ...patch, updated_at };
      if (next.status === 'completed' && !next.completed_at) next.completed_at = updated_at;
      if (next.status === 'archived' && !next.archived_at) next.archived_at = updated_at;
      await withPgClient(activePool, (client) => client.query(`
        UPDATE goals
        SET title = $1, description = $2, status = $3, target_date = $4, updated_at = $5, completed_at = $6, archived_at = $7
        WHERE id = $8
      `, [next.title, next.description, next.status, next.target_date, next.updated_at, next.completed_at, next.archived_at, goalId]));
      return this.getGoal(goalId);
    },

    async createDiaryEntry(input = {}) {
      if (!isPlainObject(input)) throw validationError('Request body must be an object');
      const entry_date = normalizeEntryDate(input.entry_date);
      const title = normalizedOptionalText(input.title, 160, 'title');
      const body = normalizedRequiredText(input.body, 20000, 'body');
      const mood = normalizedOptionalText(input.mood, 64, 'mood');
      const goalIds = normalizeGoalIds(input.goal_ids);
      return withPgTransaction(activePool, async (client) => {
        await assertExistingGoalIdsPg(client, goalIds);
        const created_at = nowIso();
        const entry = { id: id(ENTRY_ID_PREFIX), entry_date, title, body, mood, created_at, updated_at: created_at };
        await client.query('INSERT INTO diary_entries (id, entry_date, title, body, mood, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [entry.id, entry.entry_date, entry.title, entry.body, entry.mood, entry.created_at, entry.updated_at]);
        for (const goalId of goalIds) {
          await client.query('INSERT INTO diary_entry_goals (diary_entry_id, goal_id, link_type, created_at) VALUES ($1, $2, $3, $4)', [entry.id, goalId, 'manual', created_at]);
        }
        return entryFromRow(entry, { includeBody: true, goals: goalIds.map((goalId) => ({ id: goalId, title: '', status: '' })) });
      });
    },

    async listDiaryEntries({ limit = 20, offset = 0 } = {}) {
      const boundedLimit = Number(limit);
      const boundedOffset = Number(offset);
      if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 100) throw validationError('limit is invalid');
      if (!Number.isInteger(boundedOffset) || boundedOffset < 0 || boundedOffset > 10000) throw validationError('offset is invalid');
      const result = await withPgClient(activePool, (client) => client.query('SELECT id, entry_date, title, body, mood, created_at, updated_at FROM diary_entries ORDER BY entry_date DESC, created_at DESC LIMIT $1 OFFSET $2', [boundedLimit, boundedOffset]));
      const entries = [];
      for (const row of result.rows) {
        const goals = await withPgClient(activePool, (client) => client.query('SELECT goal_id FROM diary_entry_goals WHERE diary_entry_id = $1 ORDER BY goal_id ASC', [row.id]));
        entries.push(entryFromRow(pgRow(row), { goals: goals.rows.map((goal) => goal.goal_id) }));
      }
      return entries;
    },

    async getDiaryEntry(entryId) {
      if (typeof entryId !== 'string' || !/^d_[0-9a-f]{8,64}$/.test(entryId)) return null;
      const result = await withPgClient(activePool, (client) => client.query('SELECT id, entry_date, title, body, mood, created_at, updated_at FROM diary_entries WHERE id = $1', [entryId]));
      const row = result.rows[0];
      if (!row) return null;
      const goals = await withPgClient(activePool, (client) => client.query(`
        SELECT g.id, g.title, g.status
        FROM diary_entry_goals deg
        JOIN goals g ON g.id = deg.goal_id
        WHERE deg.diary_entry_id = $1
        ORDER BY g.title ASC, g.id ASC
      `, [entryId]));
      return entryFromRow(pgRow(row), { includeBody: true, goals: goals.rows.map(pgRow) });
    },

    async close() {
      if (ownedPool) await ownedPool.end();
    }
  };
}


export const __private = { validCalendarDate, preview, GOAL_ID_PREFIX };
