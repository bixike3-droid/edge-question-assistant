from pathlib import Path
import json,re,zipfile,hashlib

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
version=manifest['version']
package=json.loads((root/'package.json').read_text(encoding='utf-8'))
core=(root/'core.js').read_text(encoding='utf-8')
if package['version'] != version or ('const VERSION = "'+version+'";') not in core:
    raise SystemExit('Version mismatch')
files=['manifest.json','sidepanel.html','style.css','app.js','renderer.js','core.js','api.js','store.js','selection.js','background.js','README.md','DEVELOPMENT.md','ACCEPTANCE.md']
files += [str(p.relative_to(root)).replace('\\','/') for folder in ['icons','vendor'] for p in (root/folder).rglob('*') if p.is_file()]
html=(root/'sidepanel.html').read_text(encoding='utf-8')
for path in re.findall(r'<(?:script|link)[^>]+(?:src|href)="([^"]+)"',html):
    if path.startswith('http') or not (root/path).is_file(): raise SystemExit('Missing or remote runtime resource: '+path)
for path in set(re.findall(r'url\((fonts/[^)]+)\)',(root/'vendor/katex/katex.min.css').read_text(encoding='utf-8'))):
    if not (root/'vendor/katex'/path).is_file(): raise SystemExit('Missing font: '+path)
for name in [f'edge-question-assistant-v{version}.zip','edge-question-assistant.zip']:
    target=root.parent/name
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(set(files)): archive.write(root/file,'edge-question-assistant/'+file)
    print(name,len(files),target.stat().st_size,hashlib.sha256(target.read_bytes()).hexdigest())
