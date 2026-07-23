/**
 * A pure, filesystem-agnostic BM25 ranker. Documents are added as already-
 * tokenized term streams; scoring is standard Okapi BM25. Holds only derived
 * counts (term frequencies, document frequencies, lengths) — never raw text.
 */

const K1 = 1.2;
const B = 0.75;

export interface BM25Hit {
  docId: string;
  score: number;
}

interface DocStats {
  /** term -> occurrences in this document */
  tf: Map<string, number>;
  /** total token count of this document */
  length: number;
}

export class BM25 {
  private docs = new Map<string, DocStats>();
  /** term -> number of documents containing it */
  private df = new Map<string, number>();
  /** term -> list of docIds containing it (postings) */
  private postings = new Map<string, string[]>();
  private avgdl = 0;
  private finalized = false;

  add(docId: string, tokens: string[]): void {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(docId, { tf, length: tokens.length });
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
      const list = this.postings.get(term) ?? [];
      list.push(docId);
      this.postings.set(term, list);
    }
    this.finalized = false;
  }

  finalize(): void {
    let total = 0;
    for (const d of this.docs.values()) total += d.length;
    this.avgdl = this.docs.size > 0 ? total / this.docs.size : 0;
    this.finalized = true;
  }

  get size(): number {
    return this.docs.size;
  }

  search(queryTokens: string[], limit: number, allowedIds?: Set<string>, offset = 0): { hits: BM25Hit[]; total: number } {
    if (!this.finalized) this.finalize();
    if (queryTokens.length === 0 || this.docs.size === 0) return { hits: [], total: 0 };
    if (allowedIds && allowedIds.size === 0) return { hits: [], total: 0 };

    const N = this.docs.size;
    const scores = new Map<string, number>();
    // Score only documents that appear in some query term's postings list.
    const queryTerms = new Set(queryTokens);

    for (const term of queryTerms) {
      const df = this.df.get(term);
      if (!df) continue; // term not in corpus
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const docId of this.postings.get(term)!) {
        if (allowedIds && !allowedIds.has(docId)) continue;
        const doc = this.docs.get(docId)!;
        const tf = doc.tf.get(term)!;
        const denom = tf + K1 * (1 - B + (B * doc.length) / (this.avgdl || 1));
        const contribution = idf * ((tf * (K1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    const ranked = [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
    // Window the ranked list: skip `offset`, then take `limit`. `slice` clamps
    // to length, so an over-large offset (or `offset + MAX_SAFE_INTEGER` for the
    // unbounded-limit case) simply yields the tail / an empty array.
    return { hits: ranked.slice(offset, offset + limit), total: ranked.length };
  }
}
