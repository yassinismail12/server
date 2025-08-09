export function extractTourData(message) {
    // Split message to isolate main data block, discard confirmation text
    const [mainData] = message.split(/Your booking has been confirmed/i);

    // Use regex to extract each field line-by-line from mainData
    const nameMatch = mainData.match(/Name:\s*(.+)/i);
    const phoneMatch = mainData.match(/Phone:\s*(.+)/i);
    const emailMatch = mainData.match(/Email:\s*(.+)/i);
    const dateMatch = mainData.match(/Date:\s*(.+)/i);
    const unitMatch = mainData.match(/Unit Type?:\s*(.+)/i);  // matches Unit Type or Unit

    return {
        name: nameMatch ? nameMatch[1].trim() : "Unknown",
        phone: phoneMatch ? phoneMatch[1].trim() : "Unknown",
        email: emailMatch ? emailMatch[1].trim() : "Unknown",
        date: dateMatch ? dateMatch[1].trim() : "Unknown",
        unitType: unitMatch ? unitMatch[1].trim() : "Unknown",
    };
}
