//! Word-level n-gram extraction and containment overlap.
//!
//! Ported from `composer/src/core/ngram.ts` (surface-agnostic,
//! walking-skeleton spec §7).

use std::collections::HashMap;

/// Extract word-level n-grams from `text`. Words are produced by lowercasing
/// then splitting on non-alphanumeric characters; each n-gram is counted so
/// overlap can be computed with multiplicity. Returns `gram -> count`.
pub fn extract_ngrams(text: &str, n: usize) -> HashMap<String, u32> {
    let mut ngrams = HashMap::new();
    if n == 0 {
        return ngrams;
    }
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() < n {
        return ngrams;
    }
    for i in 0..=(words.len() - n) {
        let gram = words[i..i + n].join(" ");
        *ngrams.entry(gram).or_insert(0u32) += 1;
    }
    ngrams
}

/// Containment ratio: what fraction of `candidate`'s n-grams (with
/// multiplicity) also appear in `source`? Returns a value in `[0, 1]`.
///
/// This is *directional* — it answers "how much of `candidate` is contained
/// in `source`". The caller picks the direction to match the question being
/// asked (see `ownership` vs `guard`).
pub fn ngram_overlap(candidate: &HashMap<String, u32>, source: &HashMap<String, u32>) -> f64 {
    if candidate.is_empty() {
        return 0.0;
    }
    let mut matching = 0u32;
    let mut total = 0u32;
    for (gram, count) in candidate {
        let count = *count;
        total += count;
        if let Some(&source_count) = source.get(gram) {
            matching += count.min(source_count);
        }
    }
    if total == 0 {
        0.0
    } else {
        matching as f64 / total as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_trigrams_with_counts() {
        let g = extract_ngrams("the cat sat", 3);
        // one trigram: "the cat sat"
        assert_eq!(g.len(), 1);
        assert_eq!(g.get("the cat sat"), Some(&1));
    }

    #[test]
    fn counts_repeated_ngrams() {
        let g = extract_ngrams("a b c a b c", 3);
        assert_eq!(g.get("a b c"), Some(&2));
    }

    #[test]
    fn too_few_words_yields_no_ngrams() {
        assert!(extract_ngrams("hello world", 3).is_empty());
    }

    #[test]
    fn overlap_full_containment() {
        let cand = extract_ngrams("the quick brown fox", 3);
        let src = extract_ngrams("the quick brown fox jumps", 3);
        // candidate trigrams: {the quick brown, quick brown fox}; both in source
        assert!((ngram_overlap(&cand, &src) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn overlap_is_directional() {
        // big source, tiny candidate: candidate fully contained → ~1.0
        let big = extract_ngrams("alpha beta gamma delta epsilon zeta", 3);
        let small = extract_ngrams("alpha beta gamma", 3);
        assert!(ngram_overlap(&small, &big) > 0.99);
        // reverse: big candidate vs small source → low overlap
        assert!(ngram_overlap(&big, &small) < 0.5);
    }

    #[test]
    fn overlap_zero_when_disjoint() {
        let a = extract_ngrams("red green blue", 3);
        let b = extract_ngrams("one two three", 3);
        assert_eq!(ngram_overlap(&a, &b), 0.0);
    }
}
