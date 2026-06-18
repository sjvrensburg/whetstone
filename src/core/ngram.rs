//! Word-level n-gram extraction and containment overlap.
//!
//! Ported from `composer/src/core/ngram.ts` (surface-agnostic,
//! walking-skeleton spec §7).

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

/// Fold the common cross-script homoglyphs (Cyrillic/Greek letters that render
/// identically to a Latin letter) onto their Latin look-alike. Without this, a
/// paste disguised by swapping a Latin `o` for a Cyrillic `о` tokenizes into
/// different words and the ownership metric reads it as freshly rewritten.
///
/// This is a curated fold of the realistic attack (mostly-Latin text with a
/// few non-Latin look-alikes spliced in), not a full Unicode TR39 skeleton.
/// Folding only ever merges glyphs, so it can only *raise* measured survival
/// (the conservative direction — it never lets disguised text look more owned).
fn fold_confusable(c: char) -> char {
    match c {
        // Cyrillic → Latin look-alikes (lowercase; uppercase is handled by the
        // prior lowercasing pass).
        'а' => 'a',
        'е' | 'ё' | 'є' => 'e',
        'о' => 'o',
        'р' => 'p',
        'с' => 'c',
        'х' => 'x',
        'у' => 'y',
        'к' => 'k',
        'м' => 'm',
        'н' => 'h',
        'т' => 't',
        'в' => 'b',
        'і' | 'ї' => 'i',
        'ј' => 'j',
        'ѕ' => 's',
        'д' => 'a',
        'г' => 'r',
        // Greek → Latin look-alikes.
        'ο' => 'o',
        'α' => 'a',
        'ν' => 'v',
        'ρ' => 'p',
        'τ' => 't',
        'υ' => 'u',
        'ι' => 'i',
        'κ' => 'k',
        'ε' => 'e',
        'χ' => 'x',
        'β' => 'b',
        'η' => 'n',
        'μ' => 'u',
        'γ' => 'y',
        'σ' => 'o',
        _ => c,
    }
}

/// Canonicalize `text` into comparable word tokens: NFKC-normalize, lowercase,
/// fold homoglyphs, then split on Unicode word boundaries. Unicode-aware
/// segmentation means non-ASCII scripts produce real tokens instead of one
/// undifferentiated blob — the old ASCII-only split treated any non-ASCII
/// paste as wordless, which made the ownership gate fail open on it.
pub fn canonical_words(text: &str) -> Vec<String> {
    let normalized: String = text.nfkc().collect::<String>().to_lowercase();
    let folded: String = normalized.chars().map(fold_confusable).collect();
    folded.unicode_words().map(|w| w.to_string()).collect()
}

/// Number of canonical word tokens in `text` (see [`canonical_words`]).
pub fn word_count(text: &str) -> usize {
    canonical_words(text).len()
}

/// Extract word-level n-grams from `text`. Words are produced by
/// [`canonical_words`]; each n-gram is counted so overlap can be computed with
/// multiplicity. Returns `gram -> count`.
pub fn extract_ngrams(text: &str, n: usize) -> HashMap<String, u32> {
    let mut ngrams = HashMap::new();
    if n == 0 {
        return ngrams;
    }
    let words = canonical_words(text);
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
