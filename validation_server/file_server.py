"""
file_server.py — HTTP validation server for XSD/XML validation.

Exposes a single endpoint that Postman pre-request scripts call to validate
the XML body of a request before it is sent to the real API.

Endpoint:
    POST /<folder>/<RequestName>

    Resolves the XSD at: schemas/<folder>/<RequestName>.xsd (relative to repo root)
    Reads the raw XML from the request body and validates it against that schema.

Responses:
    200  {"valid": true}
    400  {"valid": false, "message": "<validation error>"}
    404  {"error": "XSD not found", "xsdPath": "<path>"}
    500  {"error": "<message>"}

Usage:
    python validation_server/file_server.py
    # Listening on http://localhost:3456

Install dependencies first: pip install -r validation_server/requirements.txt
"""

import json
import os
import xmlschema
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 3456
ROOT = os.path.join(os.path.dirname(__file__), '..')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        """Override default logging to print method + path only."""
        print(f"{self.command} {self.path}")

    def send_json(self, status, data):
        """Write a JSON response with the given HTTP status code."""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """Handle POST /<folder>/<RequestName> — validate XML body against XSD.

        Path segments map directly to the schema path:
            POST /sample/BasicDocument
            → schemas/sample/BasicDocument.xsd
        """
        segments = [s for s in self.path.split('/') if s]
        if len(segments) < 2:
            self.send_json(404, {'error': 'Not found'})
            return

        xsd_path = os.path.join(ROOT, 'schemas', segments[0], f"{'/'.join(segments[1:])}.xsd")
        if not os.path.exists(xsd_path):
            self.send_json(404, {'error': 'XSD not found', 'xsdPath': xsd_path})
            return

        length = int(self.headers.get('Content-Length', 0))
        xml_body = self.rfile.read(length).decode()

        try:
            xmlschema.XMLSchema(xsd_path).validate(xml_body)
            self.send_json(200, {'valid': True})
        except xmlschema.XMLSchemaValidationError as e:
            self.send_json(400, {'valid': False, 'message': str(e)})
        except Exception as e:
            self.send_json(500, {'error': str(e)})


if __name__ == '__main__':
    httpd = HTTPServer(('', PORT), Handler)
    print(f'File server listening on http://localhost:{PORT}')
    httpd.serve_forever()
