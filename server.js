// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DATABRICKS_APP_PORT || 8000;

app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Auto-mount each /api/*.js file as a route
const apiDir = path.join(__dirname, 'api');
const apiFiles = fs.readdirSync(apiDir).filter(f => f.endsWith('.js'));

for (const file of apiFiles) {
  const routeName = file.replace('.js', '');
  const modulePath = `./api/${file}`;
  const { default: handler } = await import(modulePath);
  app.all(`/api/${routeName}`, (req, res) => handler(req, res));
  console.log(`Mounted /api/${routeName}`);
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
