export function currentUsageMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function effectiveResponseCount(bot, now = new Date()) {
  const month = String(bot.responseUsageMonth || "");
  if (month && month !== currentUsageMonth(now)) return 0;
  return bot.responseCount || 0;
}

export function rolloverMonthlyResponseUsage(bot, now = new Date()) {
  const month = currentUsageMonth(now);
  if (String(bot.responseUsageMonth || "") !== month) {
    if (bot.responseUsageMonth) bot.responseCount = 0;
    bot.responseUsageMonth = month;
  }
  return bot;
}
