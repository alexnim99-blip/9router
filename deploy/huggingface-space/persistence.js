const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");

const SNAPSHOT_NAME = /^snapshot-\d{13}\.sqlite$/;

function isMountPoint(directory) {
  if (process.platform !== "linux") return true;
  const escaped = directory.replace(/ /g, "\\040");
  return fs.readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .some((line) => line.split(" ")[4] === escaped);
}

function checkDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok";
  } finally {
    db.close();
  }
}

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function createPersistence({ dataDir, persistDir, requireMount = true, keep = 3 }) {
  const dbDir = path.join(dataDir, "db");
  const dbFile = path.join(dbDir, "data.sqlite");
  let pending = Promise.resolve();

  function assertStorage() {
    if (!fs.existsSync(persistDir)) throw new Error(`Persistent volume missing: ${persistDir}`);
    if (requireMount && !isMountPoint(persistDir)) {
      throw new Error(`Persistent volume is not mounted: ${persistDir}`);
    }
    fs.accessSync(persistDir, fs.constants.R_OK | fs.constants.W_OK);
  }

  function snapshots() {
    return fs.readdirSync(persistDir)
      .filter((name) => SNAPSHOT_NAME.test(name))
      .sort()
      .reverse();
  }

  function restore() {
    assertStorage();
    fs.mkdirSync(dbDir, { recursive: true });
    if (fs.existsSync(dbFile)) {
      if (!checkDatabase(dbFile)) throw new Error("Existing SQLite database failed integrity_check");
      console.log("[Persistence] Existing local SQLite database retained");
      return false;
    }
    for (const name of snapshots()) {
      const temporary = path.join(dbDir, "restore.sqlite.tmp");
      try {
        fs.copyFileSync(path.join(persistDir, name), temporary);
        if (!checkDatabase(temporary)) throw new Error("integrity_check failed");
        fs.renameSync(temporary, dbFile);
        console.log(`[Persistence] Restored ${name}`);
        return true;
      } catch (error) {
        console.error(`[Persistence] Skipping ${name}: ${error.message}`);
        try { fs.unlinkSync(temporary); } catch {}
      }
    }
    if (snapshots().length) throw new Error("No valid persistent SQLite snapshot available");
    console.log("[Persistence] Empty volume; starting with a new database");
    return false;
  }

  async function save() {
    assertStorage();
    if (!fs.existsSync(dbFile)) return false;
    const temporary = path.join(dbDir, `snapshot-${process.pid}.tmp.sqlite`);
    try {
      const source = new DatabaseSync(dbFile, { readOnly: true });
      try {
        await backup(source, temporary);
      } finally {
        source.close();
      }
      if (!checkDatabase(temporary)) throw new Error("Snapshot failed integrity_check");
      const target = path.join(persistDir, `snapshot-${Date.now()}.sqlite`);
      fs.copyFileSync(temporary, target);
      if (sha256(temporary) !== sha256(target)) {
        try { fs.unlinkSync(target); } catch {}
        throw new Error("Persistent snapshot checksum mismatch");
      }
      console.log(`[Persistence] Saved ${path.basename(target)}`);
      for (const old of snapshots().slice(keep)) {
        try { fs.unlinkSync(path.join(persistDir, old)); }
        catch (error) { console.warn(`[Persistence] Could not remove ${old}: ${error.message}`); }
      }
      return true;
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  function backupNow() {
    pending = pending.catch(() => {}).then(save);
    return pending;
  }

  return { restore, backupNow };
}

module.exports = { createPersistence };
