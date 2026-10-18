#!/usr/bin/env python3
"""Build a self-contained Apple Silicon app without user data.

Supply Node and LICENSE from one verified official darwin-arm64 distribution.
Expected hashes bind the build to those reviewed inputs. The default ad-hoc
signature is not a Developer ID signature or Apple notarization.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
NAME = '算力有限责任公司'
BUILD = '14'
MINIMUM_MACOS = '13.5'
SERVER_FILES = (
    'app.mjs', 'files.mjs', 'member.mjs', 'providers.mjs', 'repetition.mjs',
    'secrets.mjs', 'state.mjs', 'storage-location.mjs', 'validation.mjs',
)
VENDOR_FILES = ('package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.md')
FORBIDDEN_NAMES = {
    '.git', '.DS_Store', '.local-data', 'work', 'previous-apps', 'test', 'tests',
    '__tests__', '__pycache__', 'chat-state.json', 'provider-secrets.enc',
    'chatgpt-auth.json', 'chatgpt-host.json', 'auth.json', 'secrets.json',
}


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def output(*args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def check_hash(path, expected, label):
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected) or digest(path) != expected.lower():
        raise RuntimeError(f'{label} SHA-256 does not match the reviewed input')


def sensitive(path):
    return any(part in FORBIDDEN_NAMES or part.startswith(('.env', '.local-data', '.write-'))
               for part in path.parts) or path.name.endswith(('.test.mjs', '.test.js', '.tsbuildinfo', '.map', '.log', '.tmp'))


def copy_file(source, target):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f'Expected a regular release asset: {source}')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    os.chmod(target, 0o644)


def copy_frontend(target):
    source = ROOT / 'dist'
    copy_file(source / 'index.html', target / 'index.html')
    assets = source / 'assets'
    if not assets.is_dir():
        raise RuntimeError('Run npm run build before packaging')
    for item in sorted(assets.iterdir()):
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.(?:js|css)', item.name):
            raise RuntimeError(f'Unexpected frontend release asset: {item.name}')
        copy_file(item, target / 'assets' / item.name)
    # Only HTML and built JS/CSS are distributed; no copied provider artwork.


def copy_runtime_package(source, target):
    """Copy executable JS/JSON and upstream notices, excluding tests/source maps."""
    for item in sorted(source.rglob('*')):
        relative = item.relative_to(source)
        if sensitive(relative) or any(part in ('src', 'example', 'examples', 'docs', '.github') for part in relative.parts):
            continue
        if item.is_symlink():
            raise RuntimeError(f'Unexpected dependency symlink: {relative}')
        if not item.is_file():
            continue
        is_notice = bool(re.match(r'^(?:licen[sc]e|notice|copying|copyright|authors)(?:[._-].*)?$', item.name, re.I))
        if item.suffix in ('.js', '.mjs', '.cjs', '.json') or is_notice:
            copy_file(item, target / relative)


def verify_inventory(app):
    allowed_link = Path('Contents/Resources/backend/node_modules/@siwc/local')
    for item in app.rglob('*'):
        relative = item.relative_to(app)
        if sensitive(relative):
            raise RuntimeError(f'Private data or build residue in release: {relative}')
        if item.is_symlink():
            if relative != allowed_link or os.readlink(item) != '../../vendor/siwc-local':
                raise RuntimeError(f'Unexpected release symlink: {relative}')
            if not item.resolve().is_relative_to(app.resolve()):
                raise RuntimeError(f'Release symlink escapes bundle: {relative}')


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--node-license', type=Path, required=True,
                    help='LICENSE shipped with the same official Node distribution')
parser.add_argument('--node-sha256', required=True, help='Reviewed SHA-256 of bin/node')
parser.add_argument('--node-license-sha256', required=True, help='Reviewed SHA-256 of that distribution LICENSE')
parser.add_argument('--out-dir', type=Path, default=ROOT.parent / 'desktop-app')
parser.add_argument('--sign-identity', help='Optional installed Developer ID Application identity; default is ad-hoc')
opts = parser.parse_args()
node = opts.node.resolve(strict=True)
node_license = opts.node_license.resolve(strict=True)
if not node.is_file() or not node_license.is_file():
    raise RuntimeError('Node executable and its matching LICENSE must be files')
if node.parent.name != 'bin' or node_license != node.parent.parent / 'LICENSE':
    raise RuntimeError('Use bin/node and LICENSE from the same extracted official Node distribution')
check_hash(node, opts.node_sha256, 'Node')
check_hash(node_license, opts.node_license_sha256, 'Node LICENSE')
node_info = json.loads(output(node, '-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'))
if node_info['platform'] != 'darwin' or node_info['arch'] != 'arm64':
    raise RuntimeError('This release requires the official darwin-arm64 Node executable')
if output('/usr/bin/lipo', '-archs', node) != 'arm64':
    raise RuntimeError('Node Mach-O architecture must be arm64')
if not re.match(r'v(?:2[4-9]|[3-9][0-9])\.', node_info['version']):
    raise RuntimeError('Use a reviewed supported Node LTS release, version 24 or newer')
node_build = output('/usr/bin/xcrun', 'vtool', '-show-build', node)
node_minos = re.search(r'\bminos\s+(\d+\.\d+(?:\.\d+)?)', node_build)
def version_tuple(value):
    return tuple(int(part) for part in value.split('.')) + (0,) * (3 - len(value.split('.')))
if not node_minos or version_tuple(node_minos.group(1)) > version_tuple(MINIMUM_MACOS):
    raise RuntimeError('Node minimum macOS version exceeds this app release target')
license_text = node_license.read_text()
if 'Node.js' not in license_text or 'Permission is hereby granted' not in license_text:
    raise RuntimeError('The supplied Node LICENSE is not the full distribution license')
for required in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
    if not (ROOT / required).is_file():
        raise RuntimeError(f'Confirm release licensing before building: {required} is missing')
metadata = json.loads((ROOT / 'package.json').read_text())
version = metadata['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise RuntimeError('package.json must have a release version')

identity = opts.sign_identity or '-'
if opts.sign_identity:
    identities = output('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning')
    matches = re.findall(r'([A-Fa-f0-9]{40}) "(Developer ID Application:[^"]+)"', identities)
    valid = [(fingerprint, name) for fingerprint, name in matches if identity in (fingerprint, name)]
    if len(valid) != 1:
        raise RuntimeError('The requested Developer ID Application identity is not installed or is ambiguous')
    identity = valid[0][0]

out = opts.out_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
destination = out / (NAME + '.app')
if destination.exists():
    raise RuntimeError('Output app already exists; use a new --out-dir. Installed apps are never overwritten.')

with tempfile.TemporaryDirectory(prefix='.suanli-build-', dir=out) as temp:
    scratch = Path(temp)
    app = scratch / (NAME + '.app')
    contents = app / 'Contents'
    resources = contents / 'Resources'
    macos = contents / 'MacOS'
    backend = resources / 'backend'
    runtime = resources / 'runtime'
    for folder in (macos, backend, runtime):
        folder.mkdir(parents=True, exist_ok=True)
    copy_frontend(backend / 'dist')
    for name in SERVER_FILES:
        copy_file(ROOT / 'server' / name, backend / 'server' / name)
    for name in ('start.mjs', 'import-secrets.mjs'):
        copy_file(ROOT / 'scripts' / name, backend / 'scripts' / name)
    copy_file(ROOT / 'package.json', backend / 'package.json')
    sdk_source = ROOT / 'vendor' / 'siwc-local'
    sdk_target = backend / 'vendor' / 'siwc-local'
    for name in VENDOR_FILES:
        copy_file(sdk_source / name, sdk_target / name)
    compiled_sdk = list((sdk_source / 'dist').glob('*.js'))
    if not compiled_sdk:
        raise RuntimeError('Build the local SDK before packaging')
    for source in compiled_sdk:
        copy_file(source, sdk_target / 'dist' / source.name)

    modules = backend / 'node_modules'
    (modules / '@siwc').mkdir(parents=True)
    os.symlink('../../vendor/siwc-local', modules / '@siwc' / 'local')
    pending = ['zod', 'jose', 'openai', 'proper-lockfile']
    copied = set()
    while pending:
        name = pending.pop()
        if name in copied:
            continue
        source = ROOT / 'node_modules' / name
        if not source.is_dir():
            raise RuntimeError('Missing runtime dependency: ' + name)
        dependency = json.loads((source / 'package.json').read_text())
        copy_runtime_package(source, modules / name)
        copied.add(name)
        pending.extend(dependency.get('dependencies', {}))
        pending.extend(n for n in dependency.get('optionalDependencies', {}) if (ROOT / 'node_modules' / n).is_dir())
    copy_file(node, runtime / 'node')
    os.chmod(runtime / 'node', 0o755)
    copy_file(node_license, runtime / 'LICENSE')
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
        copy_file(ROOT / name, resources / name)

    plist = {
        'CFBundleName': NAME, 'CFBundleDisplayName': NAME,
        'CFBundleIdentifier': 'com.suanli.localchat.desktop',
        'CFBundleExecutable': 'SuanliChat', 'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': version, 'CFBundleVersion': BUILD,
        'CFBundleIconFile': 'AppIcon', 'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': MINIMUM_MACOS,
        'LSApplicationCategoryType': 'public.app-category.productivity',
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'NSHumanReadableCopyright': '算力有限责任公司 · 个人非商业使用',
    }
    with (contents / 'Info.plist').open('wb') as file:
        plistlib.dump(plist, file)
    swift_help = output('/usr/bin/xcrun', 'swiftc', '-help')
    prefix_flags = ['-file-prefix-map', f'{ROOT}=/SuanliSource'] if '-file-prefix-map' in swift_help else []
    swift_flags = ['-swift-version', '5', '-O', '-target', f'arm64-apple-macosx{MINIMUM_MACOS}', *prefix_flags]
    run('/usr/bin/xcrun', 'swiftc', *swift_flags, '-framework', 'AppKit', '-framework', 'WebKit',
        ROOT / 'desktop' / 'App.swift', '-o', macos / 'SuanliChat')
    run('/usr/bin/xcrun', 'swiftc', *swift_flags, '-framework', 'Security',
        ROOT / 'server' / 'keychain.swift', '-o', runtime / 'keychain-helper')
    run('/usr/bin/xcrun', 'swiftc', *prefix_flags, ROOT / 'desktop' / 'MakeIcon.swift', '-o', scratch / 'make-icon')
    run(scratch / 'make-icon', scratch / 'AppIcon-1024.png')
    iconset = scratch / 'AppIcon.iconset'
    iconset.mkdir()
    for points in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = '@2x' if scale == 2 else ''
            run('/usr/bin/sips', '-z', str(points * scale), str(points * scale),
                scratch / 'AppIcon-1024.png', '--out', iconset / f'icon_{points}x{points}{suffix}.png')
    run('/usr/bin/iconutil', '-c', 'icns', iconset, '-o', resources / 'AppIcon.icns')

    sign_flags = ['--force', '--sign', identity]
    if opts.sign_identity:
        sign_flags.extend(['--options', 'runtime', '--timestamp'])
    node_flags = list(sign_flags)
    if opts.sign_identity:
        entitlements = scratch / 'node-entitlements.plist'
        with entitlements.open('wb') as file:
            plistlib.dump({'com.apple.security.cs.allow-jit': True,
                          'com.apple.security.cs.allow-unsigned-executable-memory': True}, file)
        node_flags.extend(['--entitlements', str(entitlements)])
    # Sign nested executables explicitly before sealing the outer bundle.
    for executable, flags in ((runtime / 'keychain-helper', sign_flags),
                              (runtime / 'node', node_flags), (macos / 'SuanliChat', sign_flags)):
        run('/usr/bin/codesign', *flags, executable)
        run('/usr/bin/codesign', '--verify', '--strict', executable)
    verify_inventory(app)
    run('/usr/bin/codesign', *sign_flags, app)
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', app)
    # Import-only smoke test; never execute the real credential helper here.
    subprocess.run([str(runtime / 'node'), '--input-type=module', '-e',
                    "await Promise.all(['zod','jose','openai','proper-lockfile','@siwc/local'].map(x=>import(x)))"],
                   cwd=backend, check=True)
    app.rename(destination)

report = {
    'app': str(destination), 'version': version, 'build': BUILD,
    'node': node_info['version'], 'architecture': 'arm64', 'minimumMacOS': MINIMUM_MACOS,
    'nodeInputSHA256': opts.node_sha256.lower(), 'nodeLicenseSHA256': opts.node_license_sha256.lower(),
    'runtimeDependencies': sorted(copied), 'credentialsBundled': False,
    'keychainHelperBundled': True, 'requiresDeveloperToolsAtRuntime': False,
    'signature': 'Developer ID' if opts.sign_identity else 'ad-hoc', 'notarized': False,
}
(out / 'build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))

