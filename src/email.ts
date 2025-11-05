import * as nodemailer from "nodemailer";

// Expecting Gmail with App Password
const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;

if (!user || !pass) {
  console.warn(
    "⚠️ GMAIL_USER / GMAIL_APP_PASSWORD not set. Using JSON transport to log emails instead of sending."
  );
}

/**
 * Use real Gmail transport when creds exist; otherwise fall back to a
 * JSON transport that logs messages (prevents runtime crashes in dev).
 */
export const mailer =
  user && pass
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
      })
    : nodemailer.createTransport({
        jsonTransport: true, // logs the message as JSON instead of sending
      });

/**
 * Simple wrapper for consistent From header.
 * If Gmail creds are missing, the message will be logged (not sent).
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  const from = `"JRMSU-TC Book-Hive" <${user ?? "no-reply@localhost"}>`;
  return mailer.sendMail({ from, ...opts });
}
