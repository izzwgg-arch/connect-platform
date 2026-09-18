import { escapeHtml } from '@/lib/email/shell'

export interface PurchaseOrderEmailOptions {
  poNumber: string
  /** Greeting name (vendor contact or company). */
  vendorName: string
  total: string
  /** Purchase order date, e.g. 08/05/2026 */
  orderDate: string
  message?: string
  /** Sender display name, e.g. Samuel Stern */
  senderName: string
  /** Sender role line, e.g. Purchasing */
  senderRole?: string
  senderPhone?: string
  senderEmail?: string
}

/**
 * Plain vendor PO email matching the TrimPro outbound layout:
 * greeting + short body + signature, then a light "Purchase Order Summary"
 * box with PO #, date, and total (full details are in the PDF attachment).
 */
export function buildPurchaseOrderEmail(opts: PurchaseOrderEmailOptions): string {
  const {
    poNumber,
    vendorName,
    total,
    orderDate,
    message,
    senderName,
    senderRole = 'Purchasing',
    senderPhone,
    senderEmail,
  } = opts

  const totalDisplay = total.startsWith('$') ? total : `$${total}`
  const bodyText = message?.trim()
    ? escapeHtml(message).replace(/\n/g, '<br />')
    : 'Please find our purchase order attached to this email. Thank You!'

  const signatureLines = [
    `<div>${escapeHtml(senderName)}${senderRole ? ` / ${escapeHtml(senderRole)}` : ''}</div>`,
    senderPhone ? `<div>P - ${escapeHtml(senderPhone)}</div>` : '',
    senderEmail
      ? `<div>E - <a href="mailto:${escapeHtml(senderEmail)}" style="color:#0563c1;text-decoration:underline;">${escapeHtml(senderEmail)}</a></div>`
      : '',
  ]
    .filter(Boolean)
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Purchase Order ${escapeHtml(poNumber)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#000000;">
  <div style="padding:16px 20px;max-width:640px;">
    <p style="margin:0 0 14px;">Dear ${escapeHtml(vendorName)},</p>
    <p style="margin:0 0 18px;">${bodyText}</p>
    <div style="margin:0 0 22px;">
      ${signatureLines}
    </div>
    <div style="background:#f3f3f3;border:1px solid #d9d9d9;padding:14px 16px;font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.55;color:#111111;">
      <div style="text-align:center;margin:0 0 10px;letter-spacing:0.02em;">----------------------- Purchase Order Summary -----------------------</div>
      <div><strong>Purchase Order #:</strong> ${escapeHtml(poNumber)}</div>
      <div><strong>Purchase Order Date:</strong> ${escapeHtml(orderDate)}</div>
      <div><strong>Total:</strong> ${escapeHtml(totalDisplay)}</div>
      <div style="margin-top:12px;">The complete version has been provided as an attachment to this email.</div>
      <div style="margin-top:10px;">----------------------------------------------------------</div>
    </div>
  </div>
</body>
</html>`
}
