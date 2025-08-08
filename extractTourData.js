// extractTourData.js
export function extractTourData(message) {
    // Example message format from your AI:
    // [TOUR_REQUEST] Name: John Doe | Phone: 123456789 | Unit: Apartment
    const nameMatch = message.match(/Name:\s*([^|]+)/i);
    const phoneMatch = message.match(/Phone:\s*([^|]+)/i);
    const unitMatch = message.match(/Unit:\s*(.+)/i);

    return {
        name: nameMatch ? nameMatch[1].trim() : "Unknown",
        phone: phoneMatch ? phoneMatch[1].trim() : "Unknown",
        unitType: unitMatch ? unitMatch[1].trim() : "Unknown",
    };
}
