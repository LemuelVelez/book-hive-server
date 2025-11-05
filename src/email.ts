import nodemailer from "nodemailer";

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) {
  console.warn("⚠️ GMAIL_USER / GMAIL_APP_PASSWORD not set. Email will fail.");
}

export const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user, pass },
});

// Simple wrapper for consistent from:
export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  const from = `"JRMSU-TC Book-Hive" <${user}>`;
  return mailer.sendMail({ from, ...opts });
}
