import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import axios from "axios";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

// Load .env for local development (silently ignored if not present)
try {
  const { config } = await import("dotenv");
  config();
} catch { /* dotenv not installed — rely on real env vars */ }

// ─── Config ───────────────────────────────────────────────────────────────────

const API_ID        = parseInt(process.env.TELEGRAM_API_ID  || "");
const API_HASH      = process.env.TELEGRAM_API_HASH         || "";
const PHONE         = process.env.TELEGRAM_PHONE            || "";
const SESSION_ENV   = process.env.TELEGRAM_SESSION          || "";
const PTERO_URL     = (process.env.PTERO_URL                || "").replace(/\/$/, "");
const PTERO_KEY     = process.env.PTERO_API_KEY             || "";
const SERVER_ID     = process.env.PTERO_SERVER_ID           || "";
const INTERVAL_MS   = parseInt(process.env.BACKUP_INTERVAL_SEC || "300") * 1000;
const PORT          = parseInt(process.env.PORT             || "8080");

for (const [k, v] of Object.entries({ TELEGRAM_API_ID: API_ID, TELEGRAM_API_HASH: API_HASH, TELEGRAM_PHONE: PHONE, PTERO_URL, PTERO_API_KEY: PTERO_KEY, PTERO_SERVER_ID: SERVER_ID })) {
  if (!v) { console.error(`[bot] Missing required env var: ${k}`); process.exit(1); }
}

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, "../../.telegram_session");
const TMP_BACKUP  = "/tmp/ptero_backup.tar.gz";

// ─── In-memory state (ok to lose on restart — deletes all backups anyway) ────

let prevBackupUuid:   string | null = null;
let prevTgMsgId:      number | null = null;
let botStatus: Record<string, unknown> = { phase: "starting" };

function setStatus(data: Record<string, unknown>) {
  botStatus = { ...data, updatedAt: new Date().toISOString() };
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Built-in HTTP server (OTP entry + status, used as Render web service) ───

let pendingOtp: ((code: string) => void) | null = null;

const OTP_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Backup Bot — OTP</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#1e293b;border-radius:12px;padding:32px;max-width:420px;width:100%;border:1px solid #334155}
    h1{font-size:20px;margin-bottom:8px}
    p{color:#94a3b8;font-size:14px;margin-bottom:20px;line-height:1.5}
    label{display:block;font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:6px}
    input{width:100%;padding:12px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f1f5f9;font-size:22px;letter-spacing:8px;text-align:center;outline:none}
    input:focus{border-color:#3b82f6}
    button{width:100%;padding:12px;margin-top:14px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#2563eb}
    .status{margin-top:20px;padding:12px;background:#0f172a;border-radius:8px;font-size:12px;font-family:monospace;color:#64748b;white-space:pre-wrap;max-height:140px;overflow:auto}
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 Pterodactyl Backup Bot</h1>
    <p>A login code was sent to your phone. Enter it below to authorize the bot.</p>
    <form method="POST" action="/otp">
      <label>Telegram OTP Code</label>
      <input name="code" type="text" placeholder="12345" autofocus maxlength="10" inputmode="numeric"/>
      <button type="submit">Submit →</button>
    </form>
    <div class="status" id="s">Loading...</div>
  </div>
  <script>
    const refresh = () => fetch('/status').then(r=>r.json()).then(d=>{
      document.getElementById('s').textContent = JSON.stringify(d,null,2);
    }).catch(()=>{});
    refresh(); setInterval(refresh, 3000);
  </script>
</body>
</html>`;

const SUCCESS_PAGE = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0">
<div style="font-size:48px;margin-bottom:16px">✅</div>
<h2>OTP submitted!</h2><p>The bot is completing login. You can close this page.</p></body></html>`;

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(OTP_PAGE);
    return;
  }

  if (req.method === "POST" && req.url === "/otp") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const code = new URLSearchParams(body).get("code")?.trim() ?? "";
      if (code && pendingOtp) {
        pendingOtp(code);
        pendingOtp = null;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_PAGE);
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No pending OTP request");
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(botStatus));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

async function waitForOtp(): Promise<string> {
  setStatus({ phase: "awaiting_otp", message: "Open the bot URL and enter the OTP sent to your phone" });
  log("telegram", `OTP sent to ${PHONE}. Open the service URL and enter the code.`);
  return new Promise<string>((resolve) => {
    pendingOtp = resolve;
    setTimeout(() => {
      if (pendingOtp) { pendingOtp = null; resolve(""); }
    }, 10 * 60_000);
  });
}

// ─── Pterodactyl API ──────────────────────────────────────────────────────────

const IGNORED_PATHS = [
  "*.jar", "*.log", "logs", "crash-reports", "cache", "libraries", "versions",
  "server.properties", "bukkit.yml", "spigot.yml", "paper.yml",
  "paper-global.yml", "paper-world-defaults.yml", "config",
  "ops.json", "whitelist.json", "banned-ips.json", "banned-players.json",
  "eula.txt", "usercache.json", "usernamecache.json", "server-icon.png",
  "help.yml", "commands.yml", "permissions.yml", ".console_history",
].join("\n");

const ptero = axios.create({
  baseURL: `${PTERO_URL}/api/client`,
  headers: { Authorization: `Bearer ${PTERO_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
  timeout: 60_000,
});

async function deleteAllBackups() {
  const res = await ptero.get(`/servers/${SERVER_ID}/backups?per_page=50`);
  const list: Array<{ attributes: { uuid: string; name: string; is_locked: boolean } }> = res.data.data ?? [];
  if (!list.length) { log("ptero", "No existing backups"); return; }
  log("ptero", `Deleting ${list.length} backup(s)...`);
  for (const b of list) {
    if (b.attributes.is_locked) { log("ptero", `Skipping locked: ${b.attributes.uuid}`); continue; }
    try { await ptero.delete(`/servers/${SERVER_ID}/backups/${b.attributes.uuid}`); log("ptero", `Deleted ${b.attributes.uuid}`); }
    catch (e) { log("ptero", `Could not delete ${b.attributes.uuid}: ${e}`); }
  }
}

async function createBackup(): Promise<{ uuid: string; name: string }> {
  const name = `worlds+plugins-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const res = await ptero.post(`/servers/${SERVER_ID}/backups`, { name, ignored: IGNORED_PATHS, is_locked: false });
  return res.data.attributes as { uuid: string; name: string };
}

async function waitForBackupCompletion(uuid: string) {
  log("ptero", `Waiting for backup ${uuid}...`);
  for (let i = 0; i < 60; i++) {
    await sleep(15_000);
    try {
      const res = await ptero.get(`/servers/${SERVER_ID}/backups/${uuid}`);
      const a = res.data.attributes;
      if (a.is_successful === true) { log("ptero", "Backup complete"); return; }
      if (a.is_successful === false) throw new Error("Backup failed on server");
      log("ptero", `Still in progress (${i + 1}/60)...`);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404) { log("ptero", "Not indexed yet..."); }
      else throw e;
    }
  }
  throw new Error("Backup timed out (15 min)");
}

async function getDownloadUrl(uuid: string): Promise<string> {
  const res = await ptero.get(`/servers/${SERVER_ID}/backups/${uuid}/download`);
  return res.data.attributes.url as string;
}

// ─── File Download ────────────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string) {
  log("download", "Starting...");
  await fsp.rm(dest, { force: true });
  const response = await axios({ method: "GET", url, responseType: "stream", maxRedirects: 10, timeout: 15 * 60_000 });
  const writer = fs.createWriteStream(dest);
  (response.data as NodeJS.ReadableStream).pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    (response.data as NodeJS.ReadableStream).on("error", reject);
  });
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  log("download", `Done — ${mb} MB`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("bot", "Pterodactyl backup bot starting...");
  log("bot", `Panel: ${PTERO_URL} | Server: ${SERVER_ID} | Interval: ${INTERVAL_MS / 1000}s`);

  // Start HTTP server
  const httpServer = createServer(handleRequest);
  httpServer.listen(PORT, () => log("http", `Listening on port ${PORT} — open this URL in your browser for OTP and status`));

  // Load Telegram session (env var first, then file, then fresh)
  let sessionString = SESSION_ENV;
  if (!sessionString) {
    try { sessionString = fs.readFileSync(SESSION_FILE, "utf8").trim(); log("telegram", "Session loaded from file"); }
    catch { log("telegram", "No saved session — will authenticate"); }
  } else {
    log("telegram", "Session loaded from TELEGRAM_SESSION env var");
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5, retryDelay: 3_000 });

  setStatus({ phase: "connecting", message: "Connecting to Telegram..." });
  await client.start({
    phoneNumber: async () => PHONE,
    phoneCode: waitForOtp,
    onError: (err: Error) => { log("telegram", `Auth error: ${err.message}`); throw err; },
  });

  const savedSession = client.session.save() as unknown as string;
  // Save to file (works locally and on Render with persistent disk)
  try { fs.writeFileSync(SESSION_FILE, savedSession, "utf8"); } catch { /* no persistent disk */ }

  log("telegram", "✅ Logged in — session saved");
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("telegram", "TELEGRAM_SESSION (copy this to Render env vars to skip OTP on redeploy):");
  log("telegram", savedSession);
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  log("bot", `Ready — first backup in ${INTERVAL_MS / 1000}s`);
  setStatus({ phase: "ready", message: `First backup in ${INTERVAL_MS / 1000}s` });
  await sleep(INTERVAL_MS);

  while (true) {
    const cycleStart = Date.now();
    try {
      // 1 — Delete all existing backups
      setStatus({ phase: "cycle", step: "deleting_old_backups" });
      await deleteAllBackups();

      // 2 — Create new backup
      setStatus({ phase: "cycle", step: "creating_backup" });
      log("ptero", "Creating backup (worlds + plugins only)...");
      const backup = await createBackup();
      log("ptero", `Created: ${backup.uuid}`);

      // 3 — Wait for completion
      setStatus({ phase: "cycle", step: "waiting_for_backup", uuid: backup.uuid });
      await waitForBackupCompletion(backup.uuid);

      // 4 — Download
      setStatus({ phase: "cycle", step: "downloading" });
      const url = await getDownloadUrl(backup.uuid);
      await downloadFile(url, TMP_BACKUP);
      const sizeMb = (fs.statSync(TMP_BACKUP).size / 1024 / 1024).toFixed(2);

      // 5 — Delete previous Telegram message
      if (prevTgMsgId) {
        try { await client.deleteMessages("me", [prevTgMsgId], { revoke: true }); log("telegram", `Deleted old message ${prevTgMsgId}`); }
        catch (e) { log("telegram", `Could not delete old msg: ${e}`); }
      }

      // 6 — Upload to Saved Messages
      setStatus({ phase: "cycle", step: "uploading_to_telegram" });
      log("telegram", "Uploading to Saved Messages...");
      const ts = new Date().toISOString();
      const sent = await client.sendFile("me", {
        file: TMP_BACKUP,
        caption: `🗄 *Pterodactyl Backup*\n📅 ${ts}\n💾 ${sizeMb} MB\n🆔 ${backup.uuid}`,
        forceDocument: true,
        workers: 4,
      });
      prevTgMsgId = sent.id;
      prevBackupUuid = backup.uuid;
      log("telegram", `Uploaded — message ID ${sent.id}`);

      // 7 — Delete temp file immediately to free disk space
      try { await fsp.rm(TMP_BACKUP, { force: true }); log("download", "Temp file deleted"); }
      catch { /* ignore */ }

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, INTERVAL_MS - elapsed);
      setStatus({
        phase: "waiting",
        message: `Next backup in ${Math.ceil(waitMs / 1000)}s`,
        lastCycleAt: ts,
        lastBackupUuid: backup.uuid,
        lastTelegramMsgId: sent.id,
        lastSizeMb: sizeMb,
        cycleElapsedSec: Math.round(elapsed / 1000),
      });
      log("bot", `Cycle done in ${(elapsed / 1000).toFixed(1)}s — sleeping ${(waitMs / 1000).toFixed(0)}s`);
      await sleep(waitMs);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("bot", `Cycle error: ${msg}`);
      setStatus({ phase: "error", message: msg, errorAt: new Date().toISOString() });
      try { await fsp.rm(TMP_BACKUP, { force: true }); } catch { /* ignore */ }
      await sleep(30_000);
    }
  }
}

main().catch((err) => { console.error("[bot] Fatal:", err); process.exit(1); });
