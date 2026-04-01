import xmlschema
import sys

def validate(xsd_path, xml_path):
    try:
        schema = xmlschema.XMLSchema(xsd_path)
        schema.validate(xml_path)
        print("✅ XML is valid")
    except xmlschema.XMLSchemaValidationError as e:
        print("❌ XML is NOT valid")
        print(e)
    except Exception as e:
        print("⚠ Error:", e)

if __name__ == "__main__":
    validate(sys.argv[1], sys.argv[2])