export function parseDelimited(text: string, delimiter = ";"): Record<string, string>[] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(current.trim());
      current = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    current += char;
  }

  row.push(current.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());

  return rows.slice(1).map((values) => {
    const object: Record<string, string> = {};
    headers.forEach((header, index) => {
      object[header] = (values[index] ?? "").trim();
    });
    return object;
  });
}
