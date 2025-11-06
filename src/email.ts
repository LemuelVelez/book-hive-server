import * as nodemailer from "nodemailer";

// Read and trim creds to avoid hidden spaces/newlines
const user = process.env.GMAIL_USER?.trim();
const pass = process.env.GMAIL_APP_PASSWORD?.trim();

if (!user || !pass) {
  console.warn(
    "⚠️ GMAIL_USER / GMAIL_APP_PASSWORD not set. Using JSON transport (logs instead of sending)."
  );
}

/**
 * Gmail with App Password works best with explicit SMTP settings.
 * Port 465 + secure:true is the most reliable path.
 */
export const mailer =
  user && pass
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true, // TLS from the start
        auth: { user, pass },
        // logger: true,
        // debug: true,
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

  try {
    const info = await mailer.sendMail({ from, ...opts });
    return info;
  } catch (err) {
    // Narrow unknown → string message
    const rawMessage =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message)
        : "Email send failed.";

    // Make common Gmail error easier to understand
    if (rawMessage.includes("535")) {
      const human =
        "Gmail rejected the SMTP login (535). Make sure 2-Step Verification is ON and you're using a fresh 16-character App Password (no spaces) for this Gmail address. Then restart the server so the new .env is loaded.";
      // Preserve original as cause when possible
      try {
        throw new Error(human, { cause: err });
      } catch {
        throw new Error(human);
      }
    }

    // Re-throw with a readable message if it wasn't an Error
    if (err instanceof Error) throw err;
    throw new Error(rawMessage);
  }
}
