import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIRECTORY = "infra/db/migrations";

function normalizeDefinition(value) {
  return value === null || value === undefined
    ? null
    : String(value).replace(/\s+/g, " ").trim();
}

export async function loadRepositoryMigrations(root) {
  const directory = resolve(root, MIGRATION_DIRECTORY);
  const filenames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(resolve(directory, filename), "utf8");
    return {
      filename,
      sha256: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  }));
}

export async function collectDatabaseSchemaManifest(query) {
  const schemas = await query(`
      select nspname as schema_name
        from pg_catalog.pg_namespace
       where nspname = 'metrics'
       order by nspname
    `);
  const tables = await query(`
      select n.nspname as schema_name,
             c.relname as table_name,
             c.relkind as relation_kind
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'metrics'
         and c.relkind in ('r', 'p')
       order by n.nspname, c.relname
    `);
  const columns = await query(`
      select n.nspname as schema_name,
             c.relname as table_name,
             a.attnum::integer as ordinal_position,
             a.attname as column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable,
             pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) as column_default
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = 'metrics'
         and c.relkind in ('r', 'p')
         and a.attnum > 0
         and not a.attisdropped
       order by n.nspname, c.relname, a.attnum
    `);
  const constraints = await query(`
      select n.nspname as schema_name,
             c.relname as table_name,
             con.conname as constraint_name,
             con.contype as constraint_type,
             pg_catalog.pg_get_constraintdef(con.oid, true) as definition
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'metrics'
       order by n.nspname, c.relname, con.conname
    `);
  const indexes = await query(`
      select schemaname as schema_name,
             tablename as table_name,
             indexname as index_name,
             indexdef as definition
        from pg_catalog.pg_indexes
       where schemaname = 'metrics'
       order by schemaname, tablename, indexname
    `);
  const migrations = await query(`
      select filename, sha256
        from metrics.schema_migrations
       order by filename
    `);

  return {
    schemaVersion: 1,
    schemas: schemas.rows.map((row) => ({ name: row.schema_name })),
    tables: tables.rows.map((row) => ({
      schema: row.schema_name,
      name: row.table_name,
      relationKind: row.relation_kind,
    })),
    columns: columns.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      ordinal: Number(row.ordinal_position),
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === true,
      default: normalizeDefinition(row.column_default),
    })),
    constraints: constraints.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      name: row.constraint_name,
      type: row.constraint_type,
      definition: normalizeDefinition(row.definition),
    })),
    indexes: indexes.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      name: row.index_name,
      definition: normalizeDefinition(row.definition),
    })),
    migrations: migrations.rows.map((row) => ({ filename: row.filename, sha256: row.sha256 })),
  };
}

export async function generateRepositoryDatabaseSchemaManifest(root) {
  const migrations = await loadRepositoryMigrations(root);
  if (migrations.length === 0) throw new Error("Repository contains no PostgreSQL migrations");
  const database = new PGlite();
  try {
    for (const [index, migration] of migrations.entries()) {
      await database.exec(migration.sql);
      if (index === 0) {
        await database.exec(`
          create table if not exists metrics.schema_migrations (
            filename text primary key,
            sha256 text not null,
            applied_at timestamptz not null default now()
          )
        `);
      }
      await database.query(
        "insert into metrics.schema_migrations (filename, sha256) values ($1, $2)",
        [migration.filename, migration.sha256],
      );
    }
    return await collectDatabaseSchemaManifest((sql) => database.query(sql));
  } finally {
    await database.close();
  }
}

function firstDifference(actual, expected, path = "manifest") {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(actual[index], expected[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return path;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return `${path}.${key}`;
      const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return path;
}

export function assertExactDatabaseSchemaManifest(actual, expected) {
  const difference = firstDifference(actual, expected);
  if (difference) throw new Error(`Restored database schema manifest differs at ${difference}`);
  return {
    exactMatch: true,
    schemaCount: expected.schemas.length,
    tableCount: expected.tables.length,
    columnCount: expected.columns.length,
    constraintCount: expected.constraints.length,
    indexCount: expected.indexes.length,
    migrations: expected.migrations,
  };
}
