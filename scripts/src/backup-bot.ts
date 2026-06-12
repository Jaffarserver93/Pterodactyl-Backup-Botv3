import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import axios from "axios";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..");

// Config
if (!process.env.TELEGRAM_API_ID) throw new Error("TELEGRAM_API_ID is required");
if (!process.env.TELEGRAM_API_HASH) throw new Error("TELEGRAM_API_HASH is required");
if (!process.env.TELEGRAM_PHONE) throw new Error("TELEGRAM_PHONE is required");
if (!process.env.PTERO_URL) throw new Error("PTERO_URL is required");
if (!process.env.PTERO_API_KEY) throw new Error("PTERO_API_KEY is required");
if (!process.env.PTERO_SERVER_ID) throw new Error("PTERO_SERVER_ID is required");

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const PHONE = process.env.TELEGRAM_PHONE;
const PTERO_URL = process.env.PTERO_URL.replace(/\/$/, "");
const PTERO_KEY = process.env.PTERO_API_KEY;
const SERVER_ID = process.env.PTERO_SERVER_ID;
const INTERVAL_MS = 5 * 60 * 1000;

const SESSION_FILE = path.join(SCRIPTS_ROOT, ".telegram_session");
const STATE_FILE = path.join(SCRIPTS_ROOT, ".bot_state.json");
const OTP_FILE = "/tmp/bot_otp.txt";
const STATUS_FILE = "/tmp/bot_status.json";
const TMP_BACKUP = "/tmp/ptero_backup.tar.gz";

// ─── State ────────────────────────────────────────────────────────────────────

interface BotState {
  previousBackupUuid: string | null;
  previousTelegramMsgId: number | null;
}

function loadState(): BotState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { previousBackupUuid: null, previousTelegramMsgId: null };
  }
}

function saveState(state: BotState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function setStatus(data: Record<string, unknown>): void {
  const payload = { ...data, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Pterodactyl API ──────────────────────────────────────────────────────────

const ptero = axios.create({
  baseURL: `${PTERO_URL}/api/client`,
  headers: {
    Authorization: `Bearer ${PTERO_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  timeout: 60_000,
});

// Files/dirs to EXCLUDE — everything except world*, plugins/
const IGNORED_PATHS = [
  "*.jar",
  "*.log",
  "logs",
  "crash-reports",
  "cache",
  "libraries",
  "versions",
  "server.properties",
  "bukkit.yml",
  "spigot.yml",
  "paper.yml",
  "paper-global.yml",
  "paper-world-defaults.yml",
  "config",
  "ops.json",
  "whitelist.json",
  "banned-ips.json",
  "banned-players.json",
  "eula.txt",
  "usercache.json",
  "usernamecache.json",
  "server-icon.png",
  "help.yml",
  "commands.yml",
  "permissions.yml",
  ".console_history",
].join("\n");

async function createBackup(): Promise<{ uuid: string; name: string }> {
  const name = `worlds+plugins-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const res = await ptero.post(`/servers/${SERVER_ID}/backups`, {
    name,
    ignored: IGNORED_PATHS,
    is_locked: false,
  });
  return res.data.attributes as { uuid: string; name: string };
}

async function waitForBackupCompletion(uuid: string): Promise<void> {
  log("ptero", `Waiting for backup ${uuid} to complete...`);
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(15_000);
    try {
      const res = await ptero.get(`/servers/${SERVER_ID}/backups/${uuid}`);
      const attrs = res.data.attributes;
      if (attrs.is_successful === true) {
        log("ptero", "Backup complete");
        return;
      }
      if (attrs.is_successful === false) {
        throw new Error("Backup failed on server side");
      }
      log("ptero", `Still in progress (attempt ${attempt + 1}/60)...`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        log("ptero", "Backup not indexed yet, retrying...");
      } else {
        throw err;
      }
    }
  }
  throw new Error("Backup timed out after 15 minutes");
}

async function getDownloadUrl(uuid: string): Promise<string> {
  const res = await ptero.get(`/servers/${SERVER_ID}/backups/${uuid}/download`);
  return res.data.attributes.url as string;
}

async function deleteBackup(uuid: string): Promise<void> {
  await ptero.delete(`/servers/${SERVER_ID}/backups/${uuid}`);
  log("ptero", `Deleted backup ${uuid}`);
}

async function deleteAllBackups(): Promise<void> {
  const res = await ptero.get(`/servers/${SERVER_ID}/backups?per_page=50`);
  const backups: Array<{ attributes: { uuid: string; name: string; is_locked: boolean } }> =
    res.data.data ?? [];
  if (backups.length === 0) {
    log("ptero", "No existing backups to delete");
    return;
  }
  log("ptero", `Deleting ${backups.length} existing backup(s) to free slot...`);
  for (const b of backups) {
    const { uuid, name, is_locked } = b.attributes;
    if (is_locked) {
      log("ptero", `Skipping locked backup ${uuid} (${name})`);
      continue;
    }
    try {
      await deleteBackup(uuid);
    } catch (err: unknown) {
      log("ptero", `Could not delete ${uuid}: ${String(err)}`);
    }
  }
}

// ─── File Download ────────────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string): Promise<void> {
  log("download", "Starting download...");
  await fsp.rm(dest, { force: true });

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    maxRedirects: 10,
    timeout: 10 * 60_000,
  });

  const writer = fs.createWriteStream(dest);
  (response.data as NodeJS.ReadableStream).pipe(writer);

  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    (response.data as NodeJS.ReadableStream).on("error", reject);
  });

  const size = fs.statSync(dest).size;
  log("download", `Done — ${(size / 1024 / 1024).toFixed(2)} MB`);
}

// ─── OTP Flow ─────────────────────────────────────────────────────────────────

async function readLineFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function waitForOtp(): Promise<string> {
  const isTTY = Boolean(process.stdin.isTTY);

  if (isTTY) {
    // Running interactively in a terminal — prompt directly
    log("telegram", "Telegram sent a login code to your phone.");
    const code = await readLineFromStdin("  Enter the Telegram OTP code: ");
    if (!code) throw new Error("No OTP entered");
    log("telegram", "OTP received");
    return code;
  }

  // Running as a background service — wait for the API server to write the file
  setStatus({ phase: "awaiting_otp", message: "Open /api/bot/setup and enter the OTP sent to your phone" });
  log("telegram", "OTP sent. Visit /api/bot/setup to enter the code.");

  try { fs.unlinkSync(OTP_FILE); } catch { /* ignore */ }

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (fs.existsSync(OTP_FILE)) {
      const code = fs.readFileSync(OTP_FILE, "utf8").trim();
      if (code) {
        try { fs.unlinkSync(OTP_FILE); } catch { /* ignore */ }
        log("telegram", `OTP received: ${code}`);
        return code;
      }
    }
  }
  throw new Error("OTP timeout — no code entered within 5 minutes");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("bot", "Pterodactyl backup bot starting...");
  setStatus({ phase: "starting", message: "Initializing..." });

  // Load session
  let sessionString = "";
  try {
    sessionString = fs.readFileSync(SESSION_FILE, "utf8").trim();
    log("telegram", "Existing session loaded");
  } catch {
    log("telegram", "No saved session — will authenticate");
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 3_000,
  });

  setStatus({ phase: "connecting", message: "Connecting to Telegram..." });

  await client.start({
    phoneNumber: async () => PHONE,
    phoneCode: waitForOtp,
    onError: (err: Error) => {
      log("telegram", `Auth error: ${err.message}`);
      throw err;
    },
  });

  // Persist session
  const savedSession = client.session.save() as unknown as string;
  fs.writeFileSync(SESSION_FILE, savedSession, "utf8");
  log("telegram", "Logged in — session saved");

  // Notify Saved Messages that the bot is online, then delete after 30s
  try {
    const startMsg = await client.sendMessage("me", {
      message: `🟢 *Backup Bot Started*\n📅 ${new Date().toISOString()}\n⏱ Backup interval: every 5 minutes`,
    });
    log("telegram", "Startup message sent to Saved Messages (deletes in 30s)");
    setTimeout(async () => {
      try {
        await client.deleteMessages("me", [startMsg.id], { revoke: true });
        log("telegram", "Startup message deleted");
      } catch { /* ignore */ }
    }, 30_000);
  } catch (err: unknown) {
    log("telegram", `Could not send startup message: ${String(err)}`);
  }

  log("bot", "Ready — starting 5-minute backup loop");
  setStatus({ phase: "ready", message: "Waiting for first 5-minute interval..." });

  // Wait the first full interval before the first cycle
  await sleep(INTERVAL_MS);

  while (true) {
    const cycleStart = Date.now();
    const state = loadState();

    try {
      // ── 1. Delete ALL existing backups to free the slot ──
      setStatus({ phase: "cycle", step: "deleting_old_backups" });
      await deleteAllBackups();

      // ── 2. Create new backup ──
      setStatus({ phase: "cycle", step: "creating_backup" });
      log("ptero", "Creating new backup...");
      const backup = await createBackup();
      log("ptero", `Backup created: ${backup.uuid} — ${backup.name}`);

      // ── 3. Wait for completion ──
      setStatus({ phase: "cycle", step: "waiting_for_backup", uuid: backup.uuid });
      await waitForBackupCompletion(backup.uuid);

      // ── 4. Download ──
      setStatus({ phase: "cycle", step: "downloading" });
      const downloadUrl = await getDownloadUrl(backup.uuid);
      await downloadFile(downloadUrl, TMP_BACKUP);

      // ── 5. Delete previous Telegram message ──
      if (state.previousTelegramMsgId) {
        try {
          await client.deleteMessages("me", [state.previousTelegramMsgId], { revoke: true });
          log("telegram", `Deleted old message ${state.previousTelegramMsgId}`);
        } catch (err: unknown) {
          log("telegram", `Could not delete old message: ${String(err)}`);
        }
      }

      // ── 6. Upload to Saved Messages ──
      setStatus({ phase: "cycle", step: "uploading_to_telegram" });
      log("telegram", "Uploading backup to Saved Messages...");
      const fileSize = fs.statSync(TMP_BACKUP).size;
      const ts = new Date().toISOString();
      const sentMsg = await client.sendFile("me", {
        file: TMP_BACKUP,
        caption: `🗄 *Pterodactyl Backup*\n📅 ${ts}\n💾 ${(fileSize / 1024 / 1024).toFixed(2)} MB\n🆔 ${backup.uuid}`,
        forceDocument: true,
        workers: 4,
      });

      const newMsgId = sentMsg.id;
      log("telegram", `Uploaded — message ID ${newMsgId}`);

      // ── 7. Persist new state ──
      saveState({ previousBackupUuid: backup.uuid, previousTelegramMsgId: newMsgId });

      // Cleanup temp file
      try { await fsp.rm(TMP_BACKUP, { force: true }); } catch { /* ignore */ }

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, INTERVAL_MS - elapsed);

      setStatus({
        phase: "waiting",
        message: `Next backup in ${Math.ceil(waitMs / 1000)}s`,
        lastCycleAt: ts,
        lastBackupUuid: backup.uuid,
        lastTelegramMsgId: newMsgId,
        cycleElapsedSec: Math.round(elapsed / 1000),
      });

      log("bot", `Cycle done in ${(elapsed / 1000).toFixed(1)}s — sleeping ${(waitMs / 1000).toFixed(0)}s`);
      await sleep(waitMs);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("bot", `Cycle error: ${msg}`);
      setStatus({ phase: "error", message: msg, errorAt: new Date().toISOString() });
      await sleep(30_000);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
