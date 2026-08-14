export class FakePgClient {
  constructor(shared) {
    this.shared = shared;
    this.released = false;
  }

  async query(sql, params = []) {
    this.shared.queries.push({ sql, params });
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') return { rows: [] };
    if (compact.startsWith('CREATE TABLE') || compact.startsWith('CREATE INDEX')) return { rows: [] };
    if (compact.startsWith('INSERT INTO goals')) {
      const [id, title, description, status, targetDate, createdAt, updatedAt, completedAt, archivedAt] = params;
      this.shared.goals.set(id, { id, title, description, status, target_date: targetDate, created_at: createdAt, updated_at: updatedAt, completed_at: completedAt, archived_at: archivedAt });
      return { rows: [] };
    }
    if (compact.startsWith('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals WHERE id = $1')) {
      const row = this.shared.goals.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (compact.startsWith('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals ORDER BY')) {
      return { rows: [...this.shared.goals.values()] };
    }
    if (compact.startsWith('SELECT id, title, description, status, target_date, created_at, updated_at, completed_at, archived_at FROM goals WHERE status = $1')) {
      return { rows: [...this.shared.goals.values()].filter((goal) => goal.status === params[0]) };
    }
    if (compact.startsWith('UPDATE goals')) {
      const [title, description, status, targetDate, updatedAt, completedAt, archivedAt, goalId] = params;
      const existing = this.shared.goals.get(goalId);
      this.shared.goals.set(goalId, { ...existing, title, description, status, target_date: targetDate, updated_at: updatedAt, completed_at: completedAt, archived_at: archivedAt });
      return { rows: [] };
    }
    if (compact.startsWith('SELECT id FROM goals WHERE id = ANY')) {
      return { rows: params[0].filter((goalId) => this.shared.goals.has(goalId)).map((goalId) => ({ id: goalId })) };
    }
    if (compact.startsWith('INSERT INTO diary_entries')) {
      const [id, entryDate, title, body, mood, createdAt, updatedAt] = params;
      this.shared.entries.set(id, { id, entry_date: entryDate, title, body, mood, created_at: createdAt, updated_at: updatedAt });
      return { rows: [] };
    }
    if (compact.startsWith('INSERT INTO diary_entry_goals')) {
      const [diaryEntryId, goalId, linkType, createdAt] = params;
      this.shared.entryGoals.push({ diary_entry_id: diaryEntryId, goal_id: goalId, link_type: linkType, created_at: createdAt });
      return { rows: [] };
    }
    if (compact.startsWith('SELECT id, entry_date, title, body, mood, created_at, updated_at FROM diary_entries ORDER BY')) {
      const [limit, offset] = params;
      return { rows: [...this.shared.entries.values()].slice(offset, offset + limit) };
    }
    if (compact.startsWith('SELECT goal_id FROM diary_entry_goals WHERE diary_entry_id = $1')) {
      return { rows: this.shared.entryGoals.filter((link) => link.diary_entry_id === params[0]).map((link) => ({ goal_id: link.goal_id })) };
    }
    if (compact.startsWith('SELECT id, entry_date, title, body, mood, created_at, updated_at FROM diary_entries WHERE id = $1')) {
      const row = this.shared.entries.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (compact.startsWith('SELECT g.id, g.title, g.status FROM diary_entry_goals deg JOIN goals g ON g.id = deg.goal_id WHERE deg.diary_entry_id = $1')) {
      return {
        rows: this.shared.entryGoals
          .filter((link) => link.diary_entry_id === params[0])
          .map((link) => this.shared.goals.get(link.goal_id))
          .filter(Boolean)
          .map((goal) => ({ id: goal.id, title: goal.title, status: goal.status }))
      };
    }
    throw new Error(`Unhandled fake query: ${compact}`);
  }

  release() {
    this.released = true;
  }
}

export class FakePgPool {
  constructor({ failConnect = false } = {}) {
    this.failConnect = failConnect;
    this.shared = { goals: new Map(), entries: new Map(), entryGoals: [], queries: [] };
  }

  async connect() {
    if (this.failConnect) {
      const err = new Error('fake Postgres unavailable at /tmp/private/database');
      err.code = 'FAKE_PG_UNAVAILABLE';
      throw err;
    }
    return new FakePgClient(this.shared);
  }

  async end() {
    this.ended = true;
  }
}
