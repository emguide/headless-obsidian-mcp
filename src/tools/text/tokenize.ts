/**
 * Text normalization shared by BM25 indexing and querying. The SAME function
 * must process documents and queries so their token streams line up.
 * Pipeline: lowercase -> split on non-alphanumeric -> drop stopwords -> stem.
 */

// A small, deliberately conservative English stopword set. Kept short so we
// remove only high-frequency function words, never content terms.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will",
  "with", "from", "we", "you", "your", "state",
]);

/**
 * Porter stemmer (Martin Porter's 1980 algorithm). Pure, dependency-free.
 * Reduces English inflections to a common root so "running"/"ran"/"runs"
 * (approximately) share a stem. Operates on a single lowercase word.
 */
export function stem(word: string): string {
  if (word.length < 3) return word;
  // Don't stem words containing digits (e.g., "k8s", "cluster1")
  if (/\d/.test(word)) return word;

  const isConsonant = (w: string, i: number): boolean => {
    const c = w[i];
    if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return false;
    if (c === "y") return i === 0 ? true : !isConsonant(w, i - 1);
    return true;
  };
  const measure = (w: string): number => {
    let n = 0;
    let prevVowel = false;
    for (let i = 0; i < w.length; i++) {
      const cons = isConsonant(w, i);
      if (!cons) prevVowel = true;
      else if (prevVowel) {
        n++;
        prevVowel = false;
      }
    }
    return n;
  };
  const hasVowel = (w: string): boolean => {
    for (let i = 0; i < w.length; i++) if (!isConsonant(w, i)) return true;
    return false;
  };
  const endsDoubleConsonant = (w: string): boolean =>
    w.length >= 2 &&
    w[w.length - 1] === w[w.length - 2] &&
    isConsonant(w, w.length - 1);
  const cvc = (w: string): boolean => {
    if (w.length < 3) return false;
    const i = w.length - 1;
    if (!isConsonant(w, i) || isConsonant(w, i - 1) || !isConsonant(w, i - 2))
      return false;
    const c = w[i];
    return c !== "w" && c !== "x" && c !== "y";
  };

  let w = word;

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) { /* keep */ }
  else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  let step1bFixup = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bFixup = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bFixup = true;
  }
  if (step1bFixup) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += "e";
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  const replaceSuffix = (
    pairs: [string, string][],
    minMeasure: number
  ): void => {
    for (const [suf, rep] of pairs) {
      if (w.endsWith(suf)) {
        const stemPart = w.slice(0, w.length - suf.length);
        if (measure(stemPart) > minMeasure) w = stemPart + rep;
        return;
      }
    }
  };

  // Step 2
  replaceSuffix(
    [
      ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
      ["izer", "ize"], ["abli", "able"], ["alli", "al"], ["entli", "ent"],
      ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
      ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
      ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
    ],
    0
  );

  // Step 3
  replaceSuffix(
    [
      ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
      ["ical", "ic"], ["ful", ""], ["ness", ""],
    ],
    0
  );

  // Step 4
  const step4 = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
    "ment", "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
  ];
  for (const suf of step4) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, w.length - suf.length);
      if (measure(stemPart) > 1) {
        if (suf === "ion") {
          if (/[st]$/.test(stemPart)) w = stemPart;
        } else {
          w = stemPart;
        }
      }
      break;
    }
  }
  // "ion" handled separately (needs preceding s/t).
  if (w.endsWith("ion")) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 1 && /[st]$/.test(stemPart)) w = stemPart;
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stemPart = w.slice(0, -1);
    const m = measure(stemPart);
    if (m > 1 || (m === 1 && !cvc(stemPart))) w = stemPart;
  }
  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l"))
    w = w.slice(0, -1);

  return w;
}

/** Tokenize text into normalized, stemmed terms (duplicates preserved). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
