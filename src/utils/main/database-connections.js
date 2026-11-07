const fs = require("node:fs");
const path = require("node:path");

// Separate user storage directories must never reuse a connection by table name.
const createDatabaseConnections = (Database) => {
  const connections = new Map();
  const databasePath = (dbName, storagePath) => {
    if (
      !["books", "notes", "bookmarks", "words", "plugins"].includes(dbName) ||
      typeof storagePath !== "string" ||
      !path.isAbsolute(storagePath)
    ) {
      throw new Error("Invalid database location");
    }
    const folder = path.resolve(storagePath, "config");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(fs.realpathSync.native(folder), `${dbName}.db`);
    return process.platform === "win32" ? file.toLowerCase() : file;
  };
  return {
    getConnection(dbName, storagePath, sqlStatement) {
      const file = databasePath(dbName, storagePath);
      let db = connections.get(file);
      if (!db) {
        db = new Database(file, {});
        try {
          db.pragma("journal_mode = WAL");
          db.exec(sqlStatement.createTableStatement[dbName]);
          // Preserve legacy table handling. TXT schema migrations use their own
          // versioned transaction and propagate errors in txt-index-store.js.
          for (const sql of sqlStatement.migrateStatement[dbName] || []) {
            try {
              db.exec(sql);
            } catch (error) {}
          }
          connections.set(file, db);
        } catch (error) {
          db.close();
          throw error;
        }
      }
      return db;
    },
    removeConnection(dbName, storagePath) {
      connections.delete(databasePath(dbName, storagePath));
    },
  };
};
module.exports = { createDatabaseConnections };
