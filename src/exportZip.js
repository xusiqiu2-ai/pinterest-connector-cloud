const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const { getExportsDir } = require('./storage');

async function createBatchZip(batchName, batchRoot) {
  await fs.promises.mkdir(getExportsDir(), { recursive: true });
  const zipPath = path.join(getExportsDir(), `${batchName}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(batchRoot, batchName);
    archive.finalize();
  });

  const stat = await fs.promises.stat(zipPath);
  return {
    zipPath,
    size_bytes: stat.size,
    modified_time: stat.mtime.toISOString()
  };
}

module.exports = {
  createBatchZip
};
