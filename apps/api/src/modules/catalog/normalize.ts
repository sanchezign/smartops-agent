/**
 * Product name normalization for exact matching and duplicate detection (pure).
 * "Cemento  Pórtland 25 KG" → "cemento portland 25kg"; "Tornillo 6 mm." → "tornillo 6mm".
 * Only safe, meaning-preserving transformations: anything fuzzier is decided by the
 * extractor (catalogRef + confidence) and ambiguous cases go to human review.
 */

const UNIT_PATTERN = /(\d+(?:[.,]\d+)?)\s+(mm|cm|m|mts?|kg|g|gr|l|lt|lts|ml|w|v|a|hp|pulg|")\b/g;

export function normalizeProductName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[.·•*]+(?=\s|$)/g, " ") // trailing dots / bullets
    .replace(UNIT_PATTERN, "$1$2") // "6 mm" → "6mm"
    .replace(/(\d),(\d)/g, "$1.$2") // decimal comma
    .replace(/[^a-z0-9.%"/\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
