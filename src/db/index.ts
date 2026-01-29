import fs from 'node:fs';
import path from 'node:path';

import DatabaseDriver from 'better-sqlite3';
import type { Database as BetterSqlite3Database, RunResult } from 'better-sqlite3';

type BindParams = unknown[] | Record<string, unknown>;

export class Database {
  private db?: BetterSqlite3Database;

  constructor(private readonly dbPath: string) {}

  private ensureDirectory(): void {
    if (this.dbPath === ':memory:' || this.dbPath.startsWith('file:')) {
      return;
    }

    const directory = path.dirname(this.dbPath);
    if (directory && directory !== '.' && directory !== path.sep) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  private ensureOpen(): BetterSqlite3Database {
    if (this.db) {
      return this.db;
    }

    this.ensureDirectory();
    const db = new DatabaseDriver(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    this.db = db;
    return db;
  }

  get<T = unknown>(sql: string, params?: BindParams): T | undefined {
    const statement = this.ensureOpen().prepare(sql);
    if (params === undefined) {
      return statement.get() as T | undefined;
    }
    if (Array.isArray(params)) {
      return statement.get(...params) as T | undefined;
    }
    return statement.get(params) as T | undefined;
  }

  all<T = unknown>(sql: string, params?: BindParams): T[] {
    const statement = this.ensureOpen().prepare(sql);
    if (params === undefined) {
      return statement.all() as T[];
    }
    if (Array.isArray(params)) {
      return statement.all(...params) as T[];
    }
    return statement.all(params) as T[];
  }

  run(sql: string, params?: BindParams): RunResult {
    const statement = this.ensureOpen().prepare(sql);
    if (params === undefined) {
      return statement.run();
    }
    if (Array.isArray(params)) {
      return statement.run(...params);
    }
    return statement.run(params);
  }

  exec(sql: string): void {
    this.ensureOpen().exec(sql);
  }

  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = undefined;
  }
}
