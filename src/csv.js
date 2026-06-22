const fs = require('fs/promises');

const referenceLinkFields = [
  'id',
  'file_name',
  'main_category',
  'secondary_category',
  'platform',
  'source_url',
  'image_url',
  'source_title',
  'source_project_or_board',
  'dedupe_note',
  'pin_id',
  'board_id',
  'width',
  'height',
  'formal_status'
];

const manifestFields = [
  'id',
  'file_name',
  'relative_path',
  'absolute_path',
  'size_bytes',
  'modified_time',
  'sha256',
  'main_category',
  'secondary_category',
  'platform',
  'source_url'
];

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows, fields) {
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push(fields.map((field) => csvEscape(row[field])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function writeCsv(filePath, rows, fields) {
  await fs.writeFile(filePath, toCsv(rows, fields), 'utf8');
}

module.exports = {
  manifestFields,
  referenceLinkFields,
  toCsv,
  writeCsv
};
