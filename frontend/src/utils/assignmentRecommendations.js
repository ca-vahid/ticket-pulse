export function parseRecommendationArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  const text = value.trim();
  if (!text.startsWith('[')) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, index + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }

  return [];
}

export function getRecommendationList(recommendation) {
  if (!recommendation) return [];
  if (Array.isArray(recommendation)) return recommendation;
  return parseRecommendationArray(recommendation.recommendations);
}

export function withNormalizedRecommendations(recommendation) {
  if (!recommendation) return recommendation;
  return {
    ...recommendation,
    recommendations: getRecommendationList(recommendation),
  };
}
