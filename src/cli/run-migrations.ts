import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { loadEnvironment } from "../config/env.js";
import { postgresPoolOptions } from "../config/runtime.js";

const environment = loadEnvironment();
const pool = new Pool(postgresPoolOptions(environment));
const migrationDirectory = join(process.cwd(), "db", "init");
const migrationFiles = (await readdir(migrationDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

if (migrationFiles.length === 0) throw new Error("Nenhuma migration SQL encontrada.");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const file of migrationFiles) {
    console.log(`[migration] aplicando ${file}`);
    await client.query(await readFile(join(migrationDirectory, file), "utf8"));
  }
  await client.query("COMMIT");
  console.log(`[migration] ${migrationFiles.length} arquivos aplicados.`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
