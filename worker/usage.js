// Monthly response-quota accounting. Extracted from the worker entry so the
// logic is unit-testable in Node (worker/index.js imports cloudflare:workers
// and cannot be imported outside the Workers runtime).

export function currentUsageMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function effectiveResponseCount(bot, now = new Date()) {
  // Response caps are monthly. A bot stamped with an older month has simply
  // not answered yet this month, so its effective usage is zero even before
  // the write path rolls the counter over.
  const month = String(bot.responseUsageMonth || "");
  if (month && month !== currentUsageMonth(now)) return 0;
  return bot.responseCount || 0;
}

export function rolloverMonthlyResponseUsage(bot, now = new Date()) {
  const month = currentUsageMonth(now);
  if (String(bot.responseUsageMonth || "") !== month) {
    // Legacy bots without a stamp keep their current count for the rest of
    // this month; stamped bots from an earlier month reset to zero.
    if (bot.responseUsageMonth) bot.responseCount = 0;
    bot.responseUsageMonth = month;
  }
  return bot;
}
