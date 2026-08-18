#!/usr/bin/env node
/**
 * Generates src/lib/types/database.ts from a live Postgres schema.
 *
 * Why not `supabase gen types`: that command shells out to Docker even when
 * given --db-url, and this project's local test loop deliberately runs on a
 * bare Postgres cluster so schema work needs no container runtime.
 *
 * Usage (normally via `npm run db:types`, which starts the cluster for you):
 *   node scripts/gen-types.mjs "postgresql://postgres@127.0.0.1:55432/ibtest"
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_URL = process.argv[2];
const OUT = resolve(process.argv[3] ?? "src/lib/types/database.ts");
if (!DB_URL) {
  console.error("usage: gen-types.mjs <db-url> [outfile]");
  process.exit(1);
}

const PSQL = process.env.PSQL ?? "psql";

function query(sql) {
  const out = execFileSync(PSQL, [DB_URL, "-t", "-A", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out.trim() || "[]");
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

const columns = query(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select c.table_name,
           c.column_name,
           c.ordinal_position,
           c.is_nullable = 'YES' as nullable,
           c.column_default is not null as has_default,
           c.is_identity = 'YES' as is_identity,
           c.data_type,
           c.udt_name,
           c.is_generated = 'ALWAYS' as generated
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_name = c.table_name and tb.table_schema = c.table_schema
     where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position
  ) t;
`);

const enums = query(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select ty.typname as name,
           array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type ty
      join pg_enum e on e.enumtypid = ty.oid
      join pg_namespace n on n.oid = ty.typnamespace
     where n.nspname = 'public'
     group by ty.typname
     order by ty.typname
  ) t;
`);

const foreignKeys = query(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select con.conname as name,
           src.relname as table_name,
           tgt.relname as referenced_relation,
           (select array_agg(a.attname order by k.ord)
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = src.oid and a.attnum = k.attnum
           ) as columns,
           (select array_agg(a.attname order by k.ord)
              from unnest(con.confkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = tgt.oid and a.attnum = k.attnum
           ) as referenced_columns
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class tgt on tgt.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
     where con.contype = 'f' and n.nspname = 'public'
     order by src.relname, con.conname
  ) t;
`);

// A FK is one-to-one when its own columns are covered by a unique constraint.
const uniqueSets = query(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select src.relname as table_name,
           (select array_agg(a.attname order by a.attname)
              from unnest(con.conkey) k(attnum)
              join pg_attribute a on a.attrelid = src.oid and a.attnum = k.attnum
           ) as columns
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_namespace n on n.oid = src.relnamespace
     where con.contype in ('u', 'p') and n.nspname = 'public'
  ) t;
`);

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

const enumNames = new Set(enums.map((e) => e.name));

const SCALARS = {
  uuid: "string", text: "string", varchar: "string", bpchar: "string",
  int2: "number", int4: "number", int8: "number",
  numeric: "number", float4: "number", float8: "number",
  bool: "boolean",
  json: "Json", jsonb: "Json",
  timestamptz: "string", timestamp: "string", date: "string",
  time: "string", timetz: "string", interval: "string",
  tstzrange: "string", tsrange: "string", daterange: "string",
  bytea: "string", inet: "string", cidr: "string",
};

function tsType(col) {
  const udt = col.udt_name;
  if (udt.startsWith("_")) {
    const inner = udt.slice(1);
    return `${resolveBase(inner)}[]`;
  }
  return resolveBase(udt);
}

function resolveBase(udt) {
  if (enumNames.has(udt)) return `Database["public"]["Enums"]["${udt}"]`;
  return SCALARS[udt] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const byTable = new Map();
for (const c of columns) {
  if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
  byTable.get(c.table_name).push(c);
}

const uniqueByTable = new Map();
for (const u of uniqueSets) {
  if (!uniqueByTable.has(u.table_name)) uniqueByTable.set(u.table_name, []);
  uniqueByTable.get(u.table_name).push([...u.columns].sort().join(","));
}

function isOneToOne(fk) {
  const sets = uniqueByTable.get(fk.table_name) ?? [];
  return sets.includes([...fk.columns].sort().join(","));
}

const lines = [];
lines.push("// AUTO-GENERATED by scripts/gen-types.mjs — do not edit by hand.");
lines.push("// Regenerate after any migration change: npm run db:types");
lines.push("");
lines.push("export type Json =");
lines.push("  | string");
lines.push("  | number");
lines.push("  | boolean");
lines.push("  | null");
lines.push("  | { [key: string]: Json | undefined }");
lines.push("  | Json[];");
lines.push("");
lines.push("export type Database = {");
lines.push("  public: {");
lines.push("    Tables: {");

for (const [table, cols] of [...byTable.entries()].sort()) {
  lines.push(`      ${table}: {`);

  lines.push("        Row: {");
  for (const c of cols) {
    lines.push(`          ${c.column_name}: ${tsType(c)}${c.nullable ? " | null" : ""};`);
  }
  lines.push("        };");

  lines.push("        Insert: {");
  for (const c of cols) {
    // Generated columns cannot be written at all; defaults and nullables are
    // optional. Everything else is genuinely required on insert.
    if (c.generated) continue;
    const optional = c.nullable || c.has_default || c.is_identity;
    lines.push(
      `          ${c.column_name}${optional ? "?" : ""}: ${tsType(c)}${c.nullable ? " | null" : ""};`,
    );
  }
  lines.push("        };");

  lines.push("        Update: {");
  for (const c of cols) {
    if (c.generated) continue;
    lines.push(`          ${c.column_name}?: ${tsType(c)}${c.nullable ? " | null" : ""};`);
  }
  lines.push("        };");

  const fks = foreignKeys.filter((f) => f.table_name === table);
  if (fks.length === 0) {
    lines.push("        Relationships: [];");
  } else {
    lines.push("        Relationships: [");
    for (const fk of fks) {
      lines.push("          {");
      lines.push(`            foreignKeyName: "${fk.name}";`);
      lines.push(`            columns: [${fk.columns.map((c) => `"${c}"`).join(", ")}];`);
      lines.push(`            isOneToOne: ${isOneToOne(fk)};`);
      lines.push(`            referencedRelation: "${fk.referenced_relation}";`);
      lines.push(
        `            referencedColumns: [${fk.referenced_columns.map((c) => `"${c}"`).join(", ")}];`,
      );
      lines.push("          },");
    }
    lines.push("        ];");
  }

  lines.push("      };");
}

lines.push("    };");
lines.push("    Views: { [_ in never]: never };");
lines.push("    Functions: { [_ in never]: never };");
lines.push("    Enums: {");
for (const e of enums) {
  lines.push(`      ${e.name}: ${e.labels.map((l) => `"${l}"`).join(" | ")};`);
}
lines.push("    };");
lines.push("    CompositeTypes: { [_ in never]: never };");
lines.push("  };");
lines.push("};");
lines.push("");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(
  `wrote ${OUT} — ${byTable.size} tables, ${enums.length} enums, ${foreignKeys.length} foreign keys`,
);
