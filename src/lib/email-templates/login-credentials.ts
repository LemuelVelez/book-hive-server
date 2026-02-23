function escapeHtml(input: string) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function buildLoginCredentialsEmail(opts: {
  appName?: string
  fullName?: string | null
  email: string
  temporaryPassword: string
  loginUrl: string
  verifyEmailUrl?: string | null
}) {
  const appName = (opts.appName || "JRMSU-TC Book-Hive").trim()
  const safeApp = escapeHtml(appName)

  const name =
    opts.fullName && String(opts.fullName).trim().length > 0
      ? String(opts.fullName).trim()
      : "there"
  const safeName = escapeHtml(name)

  const safeEmail = escapeHtml(opts.email)
  const safePass = escapeHtml(opts.temporaryPassword)
  const safeLoginUrl = escapeHtml(opts.loginUrl)

  const verify = opts.verifyEmailUrl ? String(opts.verifyEmailUrl).trim() : ""
  const safeVerifyUrl = verify ? escapeHtml(verify) : ""

  const subject = `Your login credentials • ${appName}`

  const verifyBlock = safeVerifyUrl
    ? `
      <div style="margin:16px 0;padding:14px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">
        <div style="font-weight:700;margin-bottom:6px;">Step 1: Verify your email</div>
        <div style="font-size:14px;color:#374151;line-height:1.5;">
          Click this link to verify your email address:
        </div>
        <div style="margin-top:10px;">
          <a href="${safeVerifyUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">
            Verify email
          </a>
        </div>
        <div style="margin-top:10px;font-size:12px;color:#6b7280;word-break:break-all;">
          Or copy/paste: ${safeVerifyUrl}
        </div>
      </div>
    `
    : ""

  const html = `
  <div style="background:#ffffff;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;padding:24px;">
    <div style="max-width:640px;margin:0 auto;">
      <div style="font-size:18px;font-weight:800;margin-bottom:12px;">${safeApp}</div>

      <p style="margin:0 0 10px;">Hi ${safeName},</p>
      <p style="margin:0 0 14px;">
        An administrator created an account for you. Here are your login credentials:
      </p>

      <div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 14px;background:#f9fafb;">
        <div style="font-size:13px;color:#6b7280;margin-bottom:6px;">Email</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;">${safeEmail}</div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:6px;">Temporary password</div>
        <div style="font-size:15px;font-weight:800;letter-spacing:0.3px;">${safePass}</div>

        <div style="margin-top:12px;font-size:12px;color:#6b7280;">
          For your security, please change this password after you log in.
        </div>
      </div>

      ${verifyBlock}

      <div style="margin:16px 0;padding:14px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;">
        <div style="font-weight:700;margin-bottom:6px;">Step 2: Sign in</div>
        <div style="margin-top:10px;">
          <a href="${safeLoginUrl}" style="display:inline-block;padding:10px 12px;border-radius:10px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">
            Open login page
          </a>
        </div>
        <div style="margin-top:10px;font-size:12px;color:#6b7280;word-break:break-all;">
          Or copy/paste: ${safeLoginUrl}
        </div>
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;" />
      <p style="margin:0;font-size:12px;color:#6b7280;">
        If you did not expect this email, you can ignore it or contact your administrator.
      </p>
    </div>
  </div>
  `.trim()

  const text = [
    `${appName}`,
    ``,
    `Hi ${name},`,
    `An administrator created an account for you. Here are your login credentials:`,
    ``,
    `Email: ${opts.email}`,
    `Temporary password: ${opts.temporaryPassword}`,
    ``,
    verify ? `Verify your email first: ${verify}` : ``,
    `Login: ${opts.loginUrl}`,
    ``,
    `For your security, please change this password after you log in.`,
  ]
    .filter(Boolean)
    .join("\n")

  return { subject, html, text }
}