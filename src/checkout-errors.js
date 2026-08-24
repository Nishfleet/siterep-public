export function buyerCheckoutErrorMessage(error) {
  const fallback = "Secure checkout is not available right now. Email hello@siterep.net and the team will open it for you.";
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return fallback;
  if (/dodo|razorpay|webhook|api key|signature|provider|trusted checkout|portal/i.test(message)) return fallback;
  return message;
}
