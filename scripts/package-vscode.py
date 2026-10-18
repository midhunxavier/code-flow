"""Package the local extension without credentials, dependencies or test fixtures."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parent.parent
extension = root / "integrations" / "vscode"
manifest = json.loads((extension / "package.json").read_text())
version = escape(manifest["version"])
output = root / "output" / "vscode" / f"code-flow-{manifest['version']}.vsix"
output.parent.mkdir(parents=True, exist_ok=True)
vsix = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="code-flow" Version="{version}" Publisher="codeflow-local"/><DisplayName>Code Flow</DisplayName><Description xml:space="preserve">Start and review local Code Flow runs.</Description><Tags>codeflow,agents</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="false"/></Properties><License>extension/LICENSE</License></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets></PackageManifest>'''
types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>'''
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    archive.writestr("extension.vsixmanifest", vsix)
    archive.writestr("[Content_Types].xml", types)
    for name in ["package.json", "extension.cjs", "client.cjs", "README.md"]:
        archive.write(extension / name, f"extension/{name}")
    archive.write(root / "LICENSE", "extension/LICENSE")
print(output)
