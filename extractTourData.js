export function extractTourData(message) {
    // Match fields, optionally surrounded by []
    const nameMatch = message.match(/\[?Name\]?:\s*(.+)/i);
    const phoneMatch = message.match(/\[?Phone\]?:\s*(.+)/i);
    const emailMatch = message.match(/\[?Email\]?:\s*(.+)/i);
    const dateMatch = message.match(/\[?Date\]?:\s*(.+)/i);
    const unitMatch = message.match(/Unit Type?:\s*(.+)/i);

    return {
        name: nameMatch ? nameMatch[1].trim() : "Unknown",
        phone: phoneMatch ? phoneMatch[1].trim() : "Unknown",
        email: emailMatch ? emailMatch[1].trim() : "Unknown",
        date: dateMatch ? dateMatch[1].trim() : "Unknown",
        unitType: unitMatch ? unitMatch[1].trim() : "Unknown",
    };
}
