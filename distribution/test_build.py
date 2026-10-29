import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('skill_build', ROOT / 'distribution/build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class StandalonePackageTests(unittest.TestCase):
    def test_package_is_small_self_contained_and_runs_existing_pipeline_contracts(self):
        # Retain one isolated package and its logs as reproducible verification evidence.
        evidence = ROOT / 'artifacts'
        evidence.mkdir(exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix='skill-package-', dir=evidence))
        archive = folder / 'storyboard-workbench.zip'
        result = builder.build(archive)
        self.assertLess(result['zipBytes'], 1024 * 1024)
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            self.assertFalse(any('/tests/' in name or name.endswith(('.png', '.xlsx', '.mp4')) for name in names))
            self.assertFalse(any('/assets/' in name and not name.endswith('/assets/web/workflow.mjs') for name in names))
            self.assertFalse(any('/server.mjs' in name or '/docs/' in name for name in names))
            manifest = json.loads(package.read('storyboard-workbench/package-manifest.json'))
            for row in manifest['files']:
                data = package.read('storyboard-workbench/' + row['path'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])
            package.extractall(folder / 'extracted')
        installed = folder / 'extracted/storyboard-workbench'
        failures = []
        for file in installed.rglob('*.md'):
            for target in re.findall(r'\[[^\]\r\n]*\]\(([^\s)]+)\)', file.read_text(encoding='utf-8')):
                if target.startswith(('#', 'http:', 'https:', 'mailto:')):
                    continue
                destination = (file.parent / target.split('#')[0]).resolve()
                if not destination.is_relative_to(installed) or not destination.exists():
                    failures.append(str(file.relative_to(installed)) + ': ' + target)
        self.assertEqual(failures, [])
        doctor = subprocess.run(['node', str(installed / 'storyboard-workbench/scripts/runtime.mjs'), 'doctor'], capture_output=True, encoding='utf-8')
        self.assertEqual(doctor.returncode, 0, doctor.stdout + doctor.stderr)
        self.assertEqual(json.loads(doctor.stdout)['status'], 'ready')
        # Execute unchanged synthetic contracts against the extracted runtime, not the source runtime.
        tests = installed / 'storyboard-workbench/tests'
        tests.mkdir()
        test_names = ['runtime.test.mjs', 'visual.test.mjs', 'visual-v2.test.mjs', 'generation-bridge.test.mjs', 'libtv-generation.test.mjs']
        for name in test_names:
            (tests / name).write_bytes(builder.git('show', manifest['sourceRevision'] + ':storyboard-workbench/tests/' + name))
        environment = {**os.environ, 'TEMP': str(folder), 'TMP': str(folder), 'TMPDIR': str(folder)}
        process = subprocess.run(['node', '--test', *map(str, [tests / name for name in test_names])], cwd=installed, env=environment, capture_output=True, encoding='utf-8', timeout=120)
        (folder / 'contracts.log').write_text(process.stdout + process.stderr, encoding='utf-8')
        (folder / 'package-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        self.assertEqual(process.returncode, 0, process.stdout[-6000:] + process.stderr)
        print('Package verification evidence: ' + str(folder))


if __name__ == '__main__':
    unittest.main()
