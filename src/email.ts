import * as nodemailer from "nodemailer";

// Read and trim Gmail creds
const user = process.env.GMAIL_USER?.trim();
const pass = process.env.GMAIL_APP_PASSWORD?.trim();

if (!user || !pass) {
  console.warn(
    "⚠️ GMAIL_USER / GMAIL_APP_PASSWORD not set. Using JSON transport (logs instead of sending)."
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

/* ---------------------- Nodemailer transport ---------------------- */

export const mailer =
  user && pass
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true, // TLS from the start
        auth: { user, pass },
      })
    : nodemailer.createTransport({
        jsonTransport: true, // logs the message as JSON instead of sending
      });

/* ---------------------- Public API ---------------------- */

export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
  replyTo?: string;
}) {
  const from = `"JRMSU-TC Book-Hive" <${user ?? "no-reply@localhost"}>`;

  try {
    return await mailer.sendMail({ from, ...opts });
  } catch (err) {
    const msg = extractMessage(err, "Email send failed.");

    // Common Gmail / network cases with clearer guidance
    if (/535/i.test(msg)) {
      throw new Error(
        "Gmail rejected the SMTP login (535). Enable 2-Step Verification and use a 16-character App Password for this Gmail account."
      );
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
      throw new Error(
        "SMTP connection timed out. On Render free tier, outbound SMTP is blocked—upgrade the instance or use an email API."
      );
    }
    throw new Error(msg);
  }
}
