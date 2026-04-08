"""
validate.py — XSD/XML validation helper.

Validates an XML file against an XSD schema using the xmlschema library.

Usage (CLI):
    python validate.py <schema.xsd> <instance.xml>

Exit codes:
    0  — XML is valid (stdout contains 'VALID: XML is valid')
    1  — Python exception or unhandled error (no exit() called; process exits 1 by default)

Also importable: call validate(xsd_path, xml_path) directly.
Install dependencies: pip install -r requirements.txt
"""

import xmlschema
import sys


def validate(xsd_path, xml_path):
    """Validate xml_path against the XSD at xsd_path.

    Prints a VALID/INVALID/ERROR line to stdout. Does not raise — all errors are caught
    and reported as printed messages so callers can check stdout for the 'VALID:' marker.

    Args:
        xsd_path: Absolute or relative path to the .xsd schema file.
        xml_path: Absolute or relative path to the .xml instance file.
    """
    try:
        schema = xmlschema.XMLSchema(xsd_path)
        schema.validate(xml_path)
        print("VALID: XML is valid")
    except xmlschema.XMLSchemaValidationError as e:
        print("INVALID: XML is NOT valid")
        print(e)
    except Exception as e:
        print("ERROR:", e)


if __name__ == "__main__":
    validate(sys.argv[1], sys.argv[2])