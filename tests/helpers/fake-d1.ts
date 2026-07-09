import { DatabaseSync } from "node:sqlite";

type SqlValue = string | number | null | Uint8Array;

class FakePreparedStatement {
  readonly database: FakeD1Database;
  readonly sql: string;
  readonly values: SqlValue[];

  constructor(database: FakeD1Database, sql: string, values: SqlValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: SqlValue[]) {
    return new FakePreparedStatement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.database.sqlite.prepare(this.sql).get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const results = this.database.sqlite.prepare(this.sql).all(...this.values) as T[];
    return {
      results,
      success: true,
      meta: { changes: 0, duration: 0 },
    };
  }

  async run<T = Record<string, unknown>>() {
    return this.execute<T>();
  }

  execute<T = Record<string, unknown>>() {
    const hasRows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
    if (hasRows) {
      const results = this.database.sqlite.prepare(this.sql).all(...this.values) as T[];
      const changed = this.database.sqlite.prepare("SELECT changes() AS count").get() as {
        count: number;
      };
      return {
        results,
        success: true,
        meta: { changes: changed.count, duration: 0 },
      };
    }
    const result = this.database.sqlite.prepare(this.sql).run(...this.values);
    return {
      results: [] as T[],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
      },
    };
  }
}

export class FakeD1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }

  async batch<T = unknown>(statements: FakePreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  query<T = Record<string, unknown>>(sql: string, ...values: SqlValue[]) {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }

  close() {
    this.sqlite.close();
  }

  asBinding() {
    return this as unknown as D1Database;
  }
}
