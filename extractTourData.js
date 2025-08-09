export function extractTourData(message) {
    // Match "Name: ..." up to next pipe '|' or end of line
    const nameMatch = message.match(/Name:\s*([^|]+)/i);
    const phoneMatch = message.match(/Phone:\s*([^|]+)/i);
    const unitMatch = message.match(/Unit:\s*([^|\n]+)/i);  // stops at pipe or newline

    return {
        name: nameMatch ? nameMatch[1].trim() : "Unknown",
        phone: phoneMatch ? phoneMatch[1].trim() : "Unknown",
        unitType: unitMatch ? unitMatch[1].trim() : "Unknown",
    };
}
