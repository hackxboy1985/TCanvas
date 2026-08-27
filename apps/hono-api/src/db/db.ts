import type { PrismaClient } from "../types";

export type DbClient = {
	db: PrismaClient;
};

type TableInfoRow = {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
};

// SQLite json_extract(col, '$.field') → MySQL JSON_EXTRACT
function replaceSqliteJsonExtract(sql: string): string {
	return sql.replace(
		/json_extract\(\s*([a-zA-Z0-9_.]+)\s*,\s*'\$\.([a-zA-Z0-9_]+)'\s*\)/g,
		"JSON_UNQUOTE(JSON_EXTRACT($1, '$.$2'))",
	);
}

// SQLite datetime() → MySQL NOW() + INTERVAL
function replaceSqliteDatetime(sql: string): string {
	const withNow = sql
		.replace(
			/datetime\(\s*'now'\s*,\s*'(-?\d+)\s+day'\s*\)/g,
			"(NOW() + INTERVAL $1 DAY)",
		)
		.replace(
			/datetime\(\s*'now'\s*,\s*'(-?\d+)\s+minutes?'\s*\)/g,
			"(NOW() + INTERVAL $1 MINUTE)",
		)
		.replace(
			/datetime\(\s*'now'\s*,\s*'(-?\d+)\s+hour'\s*\)/g,
			"(NOW() + INTERVAL $1 HOUR)",
		);
	return withNow.replace(/datetime\(\s*([a-zA-Z0-9_.]+)\s*\)/g, "$1");
}

// SQLite INSERT OR IGNORE → MySQL INSERT IGNORE
function replaceSqliteInsertOrIgnore(sql: string): string {
	return sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT IGNORE INTO ");
}

// SQLite → MySQL（MySQL 与 SQLite 方言接近，仅处理差异点）
function toMySqlSql(rawSql: string): string {
	let sql = String(rawSql || "").trim();
	sql = replaceSqliteJsonExtract(sql);
	sql = replaceSqliteDatetime(sql);
	sql = replaceSqliteInsertOrIgnore(sql);
	sql = sql.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi, "CREATE $1INDEX");
	// 列类型 TEXT → VARCHAR(100)：MySQL 的 TEXT 不能做索引键；长文本列(*_json/*_text 等)保留 TEXT
	sql = sql.replace(/([a-z_]+)\s+TEXT\b/gi, (match, name) => {
		if (/(json|text|description|content|prompt|payload|summary|detail|note|reason|message|error|body|raw|data|meta)$/.test(name)) {
			return `${name} TEXT`;
		}
		return `${name} VARCHAR(100)`;
	});
	return sql;
}

function normalizeBigIntValue(value: unknown): unknown {
	if (typeof value === "bigint") return Number(value);
	if (Array.isArray(value)) return value.map((item) => normalizeBigIntValue(item));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			out[key] = normalizeBigIntValue(v);
		}
		return out;
	}
	return value;
}

function isTableExistsSql(sql: string): boolean {
	return /select\s+name\s+from\s+sqlite_master\s+where\s+type='table'\s+and\s+name=/i.test(sql);
}

function isPragmaTableInfoSql(sql: string): boolean {
	return /^PRAGMA\s+table_info\(/i.test(sql.trim());
}

function parsePragmaTableName(sql: string): string {
	const m = sql.trim().match(/^PRAGMA\s+table_info\(([^)]+)\)/i);
	if (!m) throw new Error(`Invalid PRAGMA table_info SQL: ${sql}`);
	return m[1].trim().replace(/^['"]|['"]$/g, "");
}

export async function queryAll<T = unknown>(
	db: PrismaClient,
	sql: string,
	bindings: unknown[] = [],
): Promise<T[]> {
	if (isTableExistsSql(sql)) {
		const table = String(bindings[0] ?? "");
		const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
			`SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
			table,
		);
		return (rows as T[]) ?? [];
	}
	if (isPragmaTableInfoSql(sql)) {
		const table = parsePragmaTableName(sql);
		const rows = await db.$queryRawUnsafe<TableInfoRow[]>(
			`SELECT
         ordinal_position - 1 AS cid,
         column_name AS name,
         data_type AS type,
         CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
         column_default AS dflt_value,
         CASE WHEN column_key = 'PRI' THEN 1 ELSE 0 END AS pk
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ordinal_position ASC`,
			table,
		);
		return (rows as T[]) ?? [];
	}
	const rows = await db.$queryRawUnsafe<unknown[]>(toMySqlSql(sql), ...bindings);
	if (!Array.isArray(rows)) return [];
	return rows.map((row) => normalizeBigIntValue(row) as T);
}

export async function queryOne<T = unknown>(
	db: PrismaClient,
	sql: string,
	bindings: unknown[] = [],
): Promise<T | null> {
	const rows = await queryAll<T>(db, sql, bindings);
	return rows.length > 0 ? rows[0] : null;
}

export async function execute(
	db: PrismaClient,
	sql: string,
	bindings: unknown[] = [],
): Promise<void> {
	// PG 全文索引(USING GIN/to_tsvector) MySQL 不支持，跳过
	if (/USING\s+GIN|to_tsvector/i.test(sql)) return;
	try {
		await db.$executeRawUnsafe(toMySqlSql(sql), ...bindings);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// MySQL 8.0 不支持 IF NOT EXISTS：重复索引(1061)/重复加列(1060)按幂等跳过
		const isDuplicateIndex = /CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql) && /1061|Duplicate key name/i.test(message);
		const isDuplicateColumn = /ALTER\s+TABLE/i.test(sql) && /1060|Duplicate column/i.test(message);
		if (isDuplicateIndex || isDuplicateColumn) return;
		throw error;
	}
}

export async function executeWithChanges(
	db: PrismaClient,
	sql: string,
	bindings: unknown[] = [],
): Promise<number> {
	const changes = await db.$executeRawUnsafe(toMySqlSql(sql), ...bindings);
	return Number(changes || 0);
}
