
import * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";

let db;

async function getDatabase() {
  if (!db) {
    db = await SQLite.openDatabaseAsync("activity_logs.db");

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        module TEXT NOT NULL,
        description TEXT,
        record_id TEXT,
        result TEXT NOT NULL DEFAULT 'PENDING',
        metadata TEXT,
        occurred_at TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  return db;
}

// Save an activity locally before relying on the internet.
export async function logActivity({
  userId = null,
  action,
  module,
  description = "",
  recordId = null,
  result = "PENDING",
  metadata = {},
}) {
  try {
    const database = await getDatabase();

    const id = Crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    await database.runAsync(
      `INSERT INTO activity_logs (
        id,
        user_id,
        action,
        module,
        description,
        record_id,
        result,
        metadata,
        occurred_at,
        synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id,
        userId,
        action,
        module,
        description,
        recordId,
        result,
        JSON.stringify(metadata),
        occurredAt,
      ]
    );

    return {
      success: true,
      id,
    };
  } catch (error) {
    console.error("LOCAL ACTIVITY LOG ERROR:", error);

    return {
      success: false,
      error: error.message,
    };
  }
}

// Update the result after the requested operation finishes.
export async function updateActivityLogResult(
  id,
  result,
  metadata = {}
) {
  try {
    const database = await getDatabase();

    await database.runAsync(
      `UPDATE activity_logs
       SET result = ?, metadata = ?
       WHERE id = ?`,
      [
        result,
        JSON.stringify(metadata),
        id,
      ]
    );

    return { success: true };
  } catch (error) {
    console.error("UPDATE ACTIVITY LOG ERROR:", error);

    return {
      success: false,
      error: error.message,
    };
  }
}

// Get records that have not yet been synchronized.
export async function getPendingActivityLogs() {
  const database = await getDatabase();

  return database.getAllAsync(`
    SELECT * FROM activity_logs
    WHERE synced = 0
    ORDER BY occurred_at ASC
  `);
}

// Mark a record as synchronized after a successful upload.
export async function markActivityLogSynced(id) {
  const database = await getDatabase();

  await database.runAsync(
    `UPDATE activity_logs
     SET synced = 1
     WHERE id = ?
    `,
    [id]
  );
}

// Retrieve all local activity records for testing.
export async function getAllActivityLogs() {
  const database = await getDatabase();

  return database.getAllAsync(`
    SELECT * FROM activity_logs
    ORDER BY occurred_at DESC
  `);
}
