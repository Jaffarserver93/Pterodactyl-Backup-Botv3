import { Router } from "express";
import * as fs from "fs";

const OTP_FILE = "/tmp/bot_otp.txt";
const STATUS_FILE = "/tmp/bot_status.json";

const router = Router();

router.get("/bot/setup", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Backup Bot Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#1e293b;border-radius:12px;padding:32px;max-width:420px;width:100%;border:1px solid #334155}
    h1{font-size:22px;margin-bottom:8px;display:flex;align-items:center;gap:10px}
    p{color:#94a3b8;font-size:14px;margin-bottom:24px;line-height:1.6}
    label{display:block;font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:6px}
    input{width:100%;padding:12px 14px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f1f5f9;font-size:20px;letter-spacing:6px;text-align:center;outline:none}
    input:focus{border-color:#3b82f6}
    button{width:100%;padding:12px;margin-top:16px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#2563eb}
    .status{margin-top:24px;padding:14px;background:#0f172a;border-radius:8px;font-size:12px;font-family:monospace;color:#64748b;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
    .badge-yellow{background:#854d0e;color:#fef08a}
    .badge-green{background:#14532d;color:#86efac}
    .badge-red{background:#7f1d1d;color:#fca5a5}
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 Backup Bot</h1>
    <p>A one-time login code was sent to your Telegram phone number. Enter it below to authorize the bot.</p>
    <form method="POST" action="/api/bot/otp">
      <label>Telegram OTP Code</label>
      <input type="text" name="code" placeholder="12345" autofocus maxlength="10" inputmode="numeric"/>
      <button type="submit">Submit OTP →</button>
    </form>
    <div class="status" id="status">Loading status...</div>
  </div>
  <script>
    function refreshStatus() {
      fetch('/api/bot/status').then(r=>r.json()).then(d=>{
        document.getElementById('status').textContent = JSON.stringify(d, null, 2);
      }).catch(()=>{
        document.getElementById('status').textContent = 'Bot not started yet';
      });
    }
    refreshStatus();
    setInterval(refreshStatus, 3000);
  </script>
</body>
</html>`);
});

router.post("/bot/otp", (req, res) => {
  const code = (req.body?.code || "").trim();
  if (!code) {
    res.status(400).send("No OTP code provided");
    return;
  }
  fs.writeFileSync(OTP_FILE, code, "utf8");
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>OTP Submitted</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#1e293b;border-radius:12px;padding:32px;max-width:380px;width:100%;text-align:center;border:1px solid #334155}
    h2{margin-bottom:12px;font-size:20px}
    p{color:#94a3b8;font-size:14px}
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:48px;margin-bottom:16px">✅</div>
    <h2>OTP Submitted!</h2>
    <p>The bot is completing login. This page can be closed. Check <strong>/api/bot/status</strong> for progress.</p>
  </div>
</body>
</html>`);
});

router.get("/bot/status", (_req, res) => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    res.json(JSON.parse(raw));
  } catch {
    res.json({ phase: "not_started", message: "Bot has not started yet" });
  }
});

export default router;
