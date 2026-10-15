export async function reserveWebhookEvent(db, event) {
  const eventId = event.eventId || `evt_sha_${String(event.payloadSha256 || "").slice(0, 40)}` || `evt_${crypto.randomUUID()}`;
  const existing = await db.prepare(`SELECT event_id, status FROM payment_webhook_events WHERE event_id = ?`).bind(eventId).first();
  if (existing && String(existing.status || "") === "processed") return { duplicate: true, eventId };
  if (existing) {
    await db
      .prepare(`UPDATE payment_webhook_events SET status = 'received', received_at = ? WHERE event_id = ?`)
      .bind(new Date().toISOString(), eventId)
      .run();
    return { duplicate: false, eventId, retry: true };
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_webhook_events (event_id, event_type, payment_link_id, payment_id, payload_sha256, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'received')`,
    )
    .bind(eventId, event.eventType || "", event.paymentLinkId || "", event.paymentId || "", event.payloadSha256 || "", new Date().toISOString())
    .run();
  return { duplicate: false, eventId };
}

export async function markWebhookEvent(db, eventId, status, error = "") {
  if (!eventId) return;
  await db
    .prepare(`UPDATE payment_webhook_events SET status = ?, error = ?, processed_at = ? WHERE event_id = ?`)
    .bind(status, String(error || "").slice(0, 500), status === "processed" ? new Date().toISOString() : null, eventId)
    .run();
}

export function paymentLedgerEntryStatement(db, entry) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO payment_ledger_entries (reference_id, event_type, amount_subunits, currency, provider_id, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(entry.referenceId || "", entry.eventType || "", Number(entry.amountSubunits || 0), entry.currency || "", entry.providerId || "", entry.eventId || "", entry.createdAt || new Date().toISOString());
}

export async function insertPaymentLedgerEntry(db, entry) {
  await paymentLedgerEntryStatement(db, entry).run();
}
