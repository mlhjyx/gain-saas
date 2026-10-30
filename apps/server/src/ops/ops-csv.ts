/** 运营台 CSV 导出:与中台一致,BOM + 引号转义。 */
export interface CsvColumn {
  readonly key: string;
  readonly label: string;
}

export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const esc = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text: string;
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const head = columns.map((column) => esc(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => esc(row[column.key])).join(',')).join('\n');
  return `\uFEFF${head}\n${body}\n`;
}

export function csvFilename(name: string): string {
  return `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
}
