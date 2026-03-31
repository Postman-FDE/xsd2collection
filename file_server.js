const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3456;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`${req.method} ${req.url}`);

  if (req.method === 'POST') {
    // Dynamic POST /<folder>/<requestName> — validate XML against XSD
    const segments = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (segments.length < 2) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const folder = segments[0];
    const requestName = segments.slice(1).join('/');
    const xsdPath = path.join(__dirname, 'schemas', folder, `${requestName}.xsd`);

    // Check if the XSD file exists
    if (!fs.existsSync(xsdPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'XSD not found', xsdPath }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      // Write XML body to a temp file
      const tempXmlPath = path.join(os.tmpdir(), `validate_${Date.now()}.xml`);
      fs.writeFileSync(tempXmlPath, body);

      const validateScript = path.join(__dirname, 'validate.py');
      const child = spawn('python3', [validateScript, xsdPath, tempXmlPath], {
        cwd: __dirname
      });

      let combinedOutput = '';

      child.stdout.on('data', (data) => {
        combinedOutput += data.toString();
      });

      child.stderr.on('data', (data) => {
        combinedOutput += data.toString();
      });

      child.on('close', (exitCode) => {
        // Clean up temp file
        try { fs.unlinkSync(tempXmlPath); } catch (_) {}

        if (exitCode === 0 && combinedOutput.includes('✅')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ valid: true, message: combinedOutput.trim() }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ valid: false, message: combinedOutput.trim() }));
        }
      });

      child.on('error', (err) => {
        // Clean up temp file on error too
        try { fs.unlinkSync(tempXmlPath); } catch (_) {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`File server listening on http://localhost:${PORT}`);
});