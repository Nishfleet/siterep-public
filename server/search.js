const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "doe",
  "did",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "much",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "there",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "with",
  "work",
  "you",
  "your",
]);

const SYNONYMS = new Map([
  ["cost", ["price", "pricing", "plan", "subscription", "fee"]],
  ["fee", ["price", "pricing", "cost", "plan", "subscription"]],
  ["plan", ["price", "pricing", "cost", "subscription", "fee"]],
  ["refund", ["return", "moneyback", "reimbursement", "cancel"]],
  ["policy", ["rule", "terms", "process"]],
  ["price", ["pricing", "cost", "plan", "subscription", "fee"]],
  ["pricing", ["price", "cost", "plan", "subscription", "fee"]],
  ["install", ["setup", "embed", "script", "wordpress", "website"]],
  ["setup", ["install", "embed", "script", "wordpress", "website"]],
  ["wix", ["install", "setup", "embed", "script", "website"]],
  ["shopify", ["install", "setup", "embed", "script", "website"]],
  ["squarespace", ["install", "setup", "embed", "script", "website"]],
  ["wordpress", ["install", "setup", "embed", "script", "website"]],
  ["cheap", ["price", "pricing", "cost", "plan", "affordable"]],
  ["affordable", ["price", "pricing", "cost", "plan", "cheap"]],
  ["expensive", ["price", "pricing", "cost", "plan"]],
  ["buy", ["price", "plan", "checkout", "start", "signup"]],
  ["purchase", ["price", "plan", "checkout", "start", "signup"]],
  ["sign", ["signup", "start", "setup", "checkout", "started"]],
  ["signup", ["sign", "start", "setup", "checkout", "started"]],
  ["register", ["signup", "start", "setup", "checkout"]],
  ["started", ["start", "signup", "setup", "checkout"]],
  ["lead", ["contact", "email", "demo", "buyer", "prospect"]],
  ["security", ["privacy", "safe", "source", "proof", "hallucination"]],
  ["source", ["citation", "proof", "reference", "grounded"]],
  ["brand", ["branding", "white", "label"]],
  ["cancel", ["cancellation", "subscription", "refund", "billing", "terminate"]],
  ["subscription", ["plan", "billing", "cancel", "price", "renewal"]],
  ["trial", ["free", "demo", "price", "plan"]],
  ["shipping", ["delivery", "returns", "ship", "postage"]],
  ["delivery", ["shipping", "ship", "returns"]],
  ["hours", ["open", "opening", "schedule", "location", "time"]],
  ["location", ["address", "near", "directions", "hours"]],
  ["contact", ["email", "phone", "support", "reach"]],
  ["book", ["booking", "appointment", "schedule", "reserve"]],
  ["appointment", ["book", "booking", "schedule", "reserve"]],
  ["warranty", ["guarantee", "returns", "refund"]],
  ["integrate", ["integration", "connect", "api", "webhook"]],
]);

const LOW_VALUE_MATCH_TERMS = new Set(["site", "rep", "siterep"]);

const CONTEXT_BORROWING_TERMS = new Set([
  "cost",
  "fee",
  "price",
  "pricing",
  "plan",
  "subscription",
]);

export function candidateSourcesForQuestion(question, sources, limit = 12) {
  const terms = tokenize(question);
  const expandedTerms = expandTerms(terms);
  const ranked = rankSources(question, terms, expandedTerms, sources);
  const minimumScore = Math.max(2, Math.ceil(expandedTerms.length * 0.18));
  return ranked.filter((item) => item.score >= minimumScore && hasMeaningfulTermMatch(item, terms)).slice(0, limit).map((item) => item.source);
}

export function answerFromSources(question, sources, options = {}) {
  let terms = tokenize(question);
  // Cheap multi-turn memory: short follow-ups ("how much is that?") borrow
  // the previous question's words so retrieval has something to rank on.
  const recentQuestions = Array.isArray(options.recentQuestions) ? options.recentQuestions : [];
  let searchQuestion = question;
  if (shouldBorrowRecentQuestion(question, terms, recentQuestions)) {
    const borrowed = tokenize(recentQuestions[0]);
    terms = [...new Set([...terms, ...borrowed])].slice(0, 18);
    searchQuestion = `${recentQuestions[0]} ${question}`;
  }
  const expandedTerms = expandTerms(terms);
  const ranked = rankSources(searchQuestion, terms, expandedTerms, sources);
  const minimumScore = Math.max(2, Math.ceil(expandedTerms.length * 0.18));
  // Never cite the same source twice: a duplicated entry in the source pool
  // (hydration collisions, double imports) must not crowd out distinct
  // sources or produce repeated citations in the public payload.
  const citedKeys = new Set();
  const matched = ranked
    .filter((item) => item.score >= minimumScore && hasMeaningfulTermMatch(item, terms) && meetsRelevanceBar(item, terms))
    .filter((item) => {
      const key = item.source.id || `${item.source.url || ""}|${item.source.title || ""}`;
      if (citedKeys.has(key)) return false;
      citedKeys.add(key);
      return true;
    })
    .slice(0, 3);

  if (matched.length === 0) {
    return unknownAnswer();
  }

  const supported = matched
    .map((item) => ({
      ...item,
      sentence: bestSentence(searchQuestion, item.source.content || item.source.contentPreview || item.source.excerpt, expandedTerms),
    }))
    .filter((item) => item.sentence)
    .slice(0, 3);

  if (supported.length === 0) {
    return unknownAnswer({
      score: matched[0]?.score || 0,
      matchedTerms: matched[0]?.matchedTerms || [],
    });
  }

  return {
    answer: buildGroundedAnswer(supported),
    sources: supported.map(({ source }) => publicSource(source)),
    leadPrompt: isBuyingIntent(searchQuestion),
    unknown: false,
    confidence: confidenceForScore(supported[0].score, expandedTerms.length),
    score: supported[0].score,
    matchedTerms: supported[0].matchedTerms,
  };
}

export function unknownAnswer(extra = {}) {
  return {
    answer:
      "I don't have that answer yet. Leave your email below and the team will get back to you directly.",
    sources: [],
    leadPrompt: true,
    unknown: true,
    confidence: "none",
    score: extra.score || 0,
    matchedTerms: extra.matchedTerms || [],
  };
}

export function publicSource(source) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    excerpt: source.excerpt,
    status: source.status || "indexed",
    sourceType: source.sourceType || "crawl",
    indexedAt: source.indexedAt,
    healthCheckedAt: source.healthCheckedAt,
    healthMessage: source.healthMessage,
    httpStatus: source.httpStatus,
    wordCount: source.wordCount,
    freshnessStatus: source.freshnessStatus,
    freshnessCheckedAt: source.freshnessCheckedAt,
    liveWordCount: source.liveWordCount,
  };
}

function hasMeaningfulTermMatch(item, terms) {
  const meaningfulTerms = terms.filter((term) => !LOW_VALUE_MATCH_TERMS.has(term));
  if (meaningfulTerms.length === 0) return true;
  const expandedMeaningfulTerms = new Set(expandTerms(meaningfulTerms));
  return (item.matchedTerms || []).some((term) => expandedMeaningfulTerms.has(term));
}

function shouldBorrowRecentQuestion(question, terms, recentQuestions) {
  if (!recentQuestions.length || terms.length >= 4) return false;
  const phrase = normalizePhrase(question);
  const hasPronounReference = /\b(?:it|that|this|those|one|ones|there)\b/.test(phrase);
  const isVagueFollowUp =
    /^(?:how much|what about|how about|and what about|what is that|what does that|does that|is that|tell me more|where is that|when is that)\b/.test(
      phrase,
    );
  const isTellMeMoreFollowUp = /^tell me more(?: please)?$/.test(phrase) || /^tell me more about (?:it|that|this)$/.test(phrase);

  if (terms.length === 0) return isVagueFollowUp || hasPronounReference;
  if (isVagueFollowUp || isTellMeMoreFollowUp) return true;
  return hasPronounReference && terms.every((term) => CONTEXT_BORROWING_TERMS.has(term));
}

function rankSources(question, terms, expandedTerms, sources) {
  const phrase = normalizePhrase(question);
  const termSet = new Set(terms);
  return sources
    .map((source) => {
      const title = normalizePhrase(source.title);
      const url = normalizePhrase(source.url);
      const excerpt = normalizePhrase(source.excerpt);
      const content = normalizePhrase(source.content || source.contentPreview);
      const haystack = `${title} ${url} ${excerpt} ${content}`;
      let score = 0;
      const matchedTerms = [];
      const originalMatches = new Set();
      let strongMatch = false;
      let titleMatch = false;
      let fuzzyTokens = null;
      for (const term of expandedTerms) {
        // The brand's own name matches every page; it is never evidence.
        const lowValue = LOW_VALUE_MATCH_TERMS.has(term);
        const isOriginal = termSet.has(term) && !lowValue;
        if (title.includes(term)) {
          score += 5;
          matchedTerms.push(term);
          if (isOriginal) originalMatches.add(term);
          // Title/excerpt hits are strong evidence even via synonyms
          // ("cost" → "Pricing"), but never via the brand's own name.
          if (!lowValue) {
            strongMatch = true;
            titleMatch = true;
          }
        } else if (excerpt.includes(term)) {
          score += 3;
          matchedTerms.push(term);
          if (isOriginal) originalMatches.add(term);
          if (!lowValue) strongMatch = true;
        } else if (content.includes(term)) {
          score += 2;
          matchedTerms.push(term);
          if (isOriginal) originalMatches.add(term);
        } else if (url.includes(term)) {
          score += 1;
          matchedTerms.push(term);
          if (isOriginal) originalMatches.add(term);
        } else if (isOriginal) {
          // Typo recovery: an original question word with no exact hit anywhere
          // still matches a document token within one edit.
          fuzzyTokens ||= haystack.split(" ");
          if (fuzzyTokenMatch(term, fuzzyTokens)) {
            score += 2;
            matchedTerms.push(term);
            originalMatches.add(term);
          }
        }
      }
      for (const term of terms) {
        if (title === term || title.includes(` ${term} `)) score += 2;
      }

      const compactPhrase = phrase.replace(/\s+/g, " ").trim();
      let phraseMatch = false;
      if (compactPhrase.length > 8 && haystack.includes(compactPhrase)) {
        score += 8;
        strongMatch = true;
        phraseMatch = true;
      }

      return {
        source,
        score,
        matchedTerms: [...new Set(matchedTerms)].slice(0, 8),
        originalMatchCount: originalMatches.size,
        strongMatch,
        titleMatch,
        phraseMatch,
      };
    })
    .sort((a, b) => b.score - a.score || newestTime(b.source) - newestTime(a.source));
}

// A keyword score alone invites confident non-sequiturs (one stray substring
// hit clears the old bar). Demand real evidence: either two distinct words
// from the visitor's question, or a strong title/excerpt hit.
function meetsRelevanceBar(item, terms) {
  const meaningfulTerms = terms.filter((term) => !LOW_VALUE_MATCH_TERMS.has(term));
  if (meaningfulTerms.length <= 1) return item.originalMatchCount >= 1 || item.strongMatch;
  // Multi-word questions pass on two original-word hits, a title-level hit
  // (titles are curated topic labels, and brand-name matches never count),
  // or the full question phrase appearing verbatim. Demanding MOST words
  // match refused natural phrasings of covered topics ("how much is the
  // starter plan" — "plan" appears nowhere in the pricing source body), while
  // excerpt-body hits alone stay insufficient ("plus tax" in a pricing
  // excerpt must not answer "can you file my taxes"). The AI compose layer
  // is the second gate: it answers from the retrieved excerpts or reports
  // unsupported, which becomes an honest refusal.
  return item.originalMatchCount >= 2 || item.titleMatch || item.phraseMatch;
}

function buildGroundedAnswer(matches) {
  // Cite the source the answer text actually came from, not every ranked one.
  const sentence = matches[0].sentence;
  return `${sentence} Source: ${matches[0].source.title}.`;
}

function bestSentence(question, content, expandedTerms = expandTerms(tokenize(question))) {
  const terms = tokenize(question);
  const original = String(content || "").trim();
  const qaAnswer = answerFromStructuredQa(question, original, terms, expandedTerms);
  if (qaAnswer) return qaAnswer;

  const raw = original.replace(/\s+/g, " ").trim();
  const sentences = raw
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24 && sentence.length < 420);
  const candidates = sentences.length ? sentences : sourceWindows(raw, expandedTerms);

  let best = "";
  let bestScore = 0;
  let bestIndex = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const sentence = candidates[index];
    const score = supportScore(question, sentence, terms, expandedTerms);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestScore <= 0) return "";

  // The answer often continues into the next sentence (price → trial note,
  // step 1 → step 2). Append it when it stays on topic and fits.
  const next = bestIndex >= 0 ? candidates[bestIndex + 1] : "";
  if (next && best.length + next.length <= 440 && supportScore(question, next, terms, expandedTerms) > 0) {
    return `${best} ${next}`;
  }
  return best;
}

function answerFromStructuredQa(question, raw, terms, expandedTerms) {
  if (!/(^|\n)\s*(?:question|q)\s*:/i.test(raw) || !/(^|\n)\s*(?:answer|a)\s*:/i.test(raw)) return "";
  const blocks = raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  let best = "";
  let bestScore = 0;
  for (const block of blocks) {
    const match = block.match(/(?:^|\n)\s*(?:question|q)\s*:\s*([\s\S]*?)(?:\n\s*(?:answer|a)\s*:\s*([\s\S]*?))(?:\n\s*(?:source url|source|topic)\s*:|$)/i);
    if (!match) continue;
    const importedQuestion = match[1].trim();
    const importedAnswer = match[2].trim();
    const score = supportScore(question, importedQuestion, terms, expandedTerms) * 2 + supportScore(question, importedAnswer, terms, expandedTerms);
    if (score > bestScore) {
      bestScore = score;
      best = answerSnippet(importedAnswer);
    }
  }
  return bestScore > 0 ? best : "";
}

function answerSnippet(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= 420) return cleaned;
  return trimWordWindow(cleaned.slice(0, 420));
}

function sourceWindows(raw, expandedTerms) {
  if (!raw || raw.length < 25) return [];
  if (raw.length <= 420) return [raw];
  const lower = raw.toLowerCase();
  const firstMatch = expandedTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (!Number.isFinite(firstMatch)) return [];
  const start = Math.max(0, firstMatch - 150);
  const end = Math.min(raw.length, firstMatch + 270);
  return [trimWordWindow(raw.slice(start, end))].filter((item) => item.length > 24);
}

function trimWordWindow(value) {
  return value.replace(/^\S*\s/, "").replace(/\s\S*$/, "").trim();
}

function supportScore(question, sentence, terms, expandedTerms) {
  const lower = sentence.toLowerCase();
  let score = 0;
  let sentenceTokens = null;
  for (const term of expandedTerms) {
    if (lower.includes(term)) {
      score += terms.includes(term) ? 2 : 1;
    } else if (terms.includes(term)) {
      sentenceTokens ||= normalizePhrase(lower).split(" ");
      if (fuzzyTokenMatch(term, sentenceTokens)) score += 2;
    }
  }
  if (isPricingQuestion(question) && /(?:[$₹€£]\s?\d|\d+\s?(?:\/|per|mo|month|year|yr))/i.test(sentence)) score += 3;
  if (isInstallQuestion(question) && /\b(?:script|snippet|paste|embed|install|wordpress|tag|body|site|website)\b/i.test(sentence)) score += 2;
  if (isSourceQuestion(question) && /\b(?:source|cite|citation|proof|indexed|refuse|invent|hallucinat|grounded)\b/i.test(sentence)) score += 2;
  return score;
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    .map(stemLight)
    .slice(0, 18);
}

// Light stemming: fold trivial plural/verb endings so "prices"/"pricing edits"
// match "price" without a stemmer dependency.
function stemLight(term) {
  if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

// True when two terms differ by a single edit (insert, delete, substitute, or
// adjacent transposition) — recovers the typo'd version of a content word.
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const lengthDiff = Math.abs(a.length - b.length);
  if (lengthDiff > 1) return false;
  if (a.length === b.length) {
    let mismatches = 0;
    let firstMismatch = -1;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        mismatches += 1;
        if (mismatches > 2) return false;
        if (firstMismatch === -1) firstMismatch = index;
      }
    }
    if (mismatches <= 1) return true;
    // Allow one adjacent transposition.
    return (
      mismatches === 2 &&
      firstMismatch + 1 < a.length &&
      a[firstMismatch] === b[firstMismatch + 1] &&
      a[firstMismatch + 1] === b[firstMismatch] &&
      a.slice(firstMismatch + 2) === b.slice(firstMismatch + 2)
    );
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      longIndex += 1;
    }
  }
  return true;
}

function fuzzyTokenMatch(term, tokens) {
  if (term.length < 5) return false;
  for (const token of tokens) {
    if (Math.abs(token.length - term.length) <= 1 && withinOneEdit(term, token)) return true;
  }
  return false;
}

function expandTerms(terms) {
  const expanded = new Set(terms);
  for (const term of terms) {
    let synonyms = SYNONYMS.get(term);
    if (!synonyms && term.length >= 4) {
      // A typo'd content word ("costt", "pricng") still unlocks its synonym
      // family when it is one edit away from a known key.
      for (const key of SYNONYMS.keys()) {
        if (Math.abs(key.length - term.length) <= 1 && withinOneEdit(term, key)) {
          synonyms = [key, ...(SYNONYMS.get(key) || [])];
          break;
        }
      }
    }
    for (const synonym of synonyms || []) expanded.add(synonym);
  }
  return [...expanded].slice(0, 36);
}

function normalizePhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function confidenceForScore(score, termCount) {
  if (score >= Math.max(14, termCount * 2.5)) return "high";
  if (score >= Math.max(7, termCount * 1.25)) return "medium";
  return "low";
}

function newestTime(source) {
  const time = Date.parse(source.indexedAt || source.updatedAt || "");
  return Number.isFinite(time) ? time : 0;
}

function isBuyingIntent(question) {
  return /price|plan|cost|buy|demo|quote|contact|call|book|trial|hire|service|available|brand|remove/i.test(question);
}

function isPricingQuestion(question) {
  return /price|pricing|plan|cost|fee|subscription|trial|month|year/i.test(question);
}

function isInstallQuestion(question) {
  return /install|setup|embed|script|wordpress|website|tag|snippet/i.test(question);
}

function isSourceQuestion(question) {
  return /source|cite|citation|proof|accurate|hallucinat|invent|grounded/i.test(question);
}
