// Patches host.config.mjs for Azure Functions deployment:
// - comm.adapter → 'azure-functions'
// - dispatch.backend → 'durable' (removes sqlite store)
import fs from 'node:fs';

const file = process.argv[2] || 'host.config.mjs';
let src = fs.readFileSync(file, 'utf8');

src = src.replace(
  /adapter:\s*['"]express['"]/,
  "adapter: 'azure-functions'",
);

src = src.replace(
  /store:\s*\{[^}]*kind:\s*['"]sqlite['"][^}]*\},?\s*/,
  "backend: 'durable',\n      ",
);

fs.writeFileSync(file, src);
