import * as nodemailer from "nodemailer";

// Prefer HTTP email API (Resend) in production to avoid SMTP blocks.
// Falls back to Gmail SMTP (for local dev) or JSON transport (logs only).

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const RESEND_FROM =
  process.env.RESEND_FROM?.trim() ||
  `"JRMSU-TC Book-Hive" <onboarding@resend.dev>`; // for real prod, verify and use your domain

// Read and trim Gmail creds (used only when no RESEND_API_KEY is present)
const user = process.env.GMAIL_USER?.trim();
const pass = process.env.GMAIL_APP_PASSWORD?.trim();

// If no API key and no SMTP creds, we'll still operate using jsonTransport
if (!RESEND_API_KEY && (!user || !pass)) {
  console.warn(
    "⚠️ No RESEND_API_KEY and no GMAIL_USER/GMAIL_APP_PASSWORD. Using JSON transport (logs instead of sending)."
  );
}

/* ---------------------- Type guards / helpers ---------------------- */

function hasMessage(x: unknown): x is { message: unknown } {
  return typeof x === "object" && x !== null && "message" in x;
}

function extractMessage(x: unknown, fallback = "Email send failed."): string {
  if (hasMessage(x) && typeof x.message === "string") return x.message;
  try {
    return JSON.stringify(x);
  } catch {
    return fallback;
  }
}

/** Send via Resend HTTP API */
async function sendViaResend(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  const payload: any = {
    from: RESEND_FROM,
    to: opts.to,
    subject: opts.subject,
  };
  if (opts.html) payload.html = opts.html;
  if (opts.text) payload.text = opts.text;

  if (opts.attachments?.length) {
    payload.attachments = opts.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
    }));
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    let msg = `Resend API error (${resp.status})`;
    try {
      const j: unknown = await resp.json();
      const m =
        typeof (j as any)?.message === "string"
          ? (j as any).message
          : extractMessage(j, msg);
      msg = m || msg;
    } catch {
      // ignore JSON parse errors; keep default msg
    }
    throw new Error(msg);
  }
  // Resp JSON type is provider-defined; we don't rely on its shape elsewhere.
  return resp.json();
}

/** Nodemailer transports for local/dev SMTP or logging */
const mailer =
  user && pass
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
      })
    : nodemailer.createTransport({ jsonTransport: true });

/**
 * Simple wrapper to send mail.
 * Chooses Resend first (HTTP), then Gmail SMTP, then JSON logging.
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  const from = `"JRMSU-TC Book-Hive" <${user ??
    RESEND_FROM.match(/<([^>]+)>/)?.[1] ?? "no-reply@localhost"}>`; // for SMTP we use Gmail user; for Resend we already send from RESEND_FROM

  try {
    if (RESEND_API_KEY) {
      return await sendViaResend(opts);
    }
    // Fallback to SMTP (mostly for local dev)
    return await mailer.sendMail({ from, ...opts });
  } catch (err) {
    // Provide a helpful error if Gmail SMTP rejects or times out
    const msg = extractMessage(err, "Email send failed.");

    if (/535/i.test(msg)) {
      throw new Error(
        "Gmail rejected the SMTP login (535). Enable 2-Step Verification and use a 16-character App Password."
      );
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
      throw new Error(
        "Email send timed out. On Render, outbound SMTP is blocked—switch to RESEND_API_KEY or another HTTP email API."
      );
    }
    throw new Error(msg);
  }
}
