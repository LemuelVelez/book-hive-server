import express from "express";
import multer from "multer";
import { sendMail } from "../email";
import { query } from "../db";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/support/ticket
router.post("/ticket", upload.single("attachment"), async (req, res, next) => {
  try {
    const { name, email, category, subject, message, context } = req.body || {};
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ ok: false, message: "Missing fields." });
    }

    // Persist a simple ticket row (optional but helpful)
    const ins = await query<{ id: string }>(
      `INSERT INTO support_tickets (name, email, category, subject, message, context_json)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        String(name),
        String(email),
        category || null,
        String(subject),
        String(message),
        context || null,
      ]
    );

    const ticketId = ins.rows[0].id;
    const inbox = process.env.SUPPORT_INBOX || process.env.GMAIL_USER;
    const attachments = [];

    if (req.file) {
      attachments.push({
        filename: req.file.originalname || "attachment",
        content: req.file.buffer,
      });
    }

    const prettyContext = context ? `\n\nContext: ${context}` : "";
    const text = `New support ticket${ticketId ? ` #${ticketId}` : ""}

From: ${name} <${email}>
Category: ${category || "N/A"}

Subject: ${subject}

Message:
${message}
${prettyContext}
`;

    await sendMail({
      to: inbox!,
      subject: `Support Ticket${ticketId ? ` #${ticketId}` : ""}: ${subject}`,
      text,
      attachments,
    });

    res.json({ ok: true, ticketId });
  } catch (err) {
    next(err);
  }
});

export default router;
