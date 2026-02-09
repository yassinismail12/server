// src/utils/chunking.js

/**
 * Split text by lines (used as the base for menus, lists, etc.)
 */
function splitByLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Split text by blank blocks (good for FAQs, paragraphs, listings)
 */
function splitByBlankBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Group an array of strings into bundles (prevents too many chunks)
 */
function bundle(items, bundleSize) {
  const out = [];
  for (let i = 0; i < items.length; i += bundleSize) {
    out.push(items.slice(i, i + bundleSize).join("\n"));
  }
  return out;
}

/**
 * Main chunking dispatcher
 * - NEVER alters text content
 * - ONLY groups text mechanically
 */
export function chunkSection(sectionName, text) {
  const t = String(text || "").trim();
  if (!t) return [];

  switch (sectionName) {
    case "menu": {
      // Menu: many short lines → bundle
      const lines = splitByLines(t);
      return bundle(lines, 30); // 30 items per chunk
    }

    case "offers": {
      const lines = splitByLines(t);
      return bundle(lines, 10);
    }

    case "faqs": {
      const blocks = splitByBlankBlocks(t);
      return bundle(blocks, 8);
    }

    case "listings": {
      const blocks = splitByBlankBlocks(t);
      return bundle(blocks, 8);
    }

    case "paymentPlans": {
      const blocks = splitByBlankBlocks(t);
      return bundle(blocks, 3);
    }

    case "hours":
    case "location":
    default:
      // Small, critical info → keep intact
      return [t];
  }
}
