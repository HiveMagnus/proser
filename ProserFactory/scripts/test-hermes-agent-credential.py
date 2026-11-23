#!/usr/bin/env python3
"""Tests for hermes-agent-credential.py, run without root as the current user."""
import base64
import contextlib
import importlib.util
import io
import json
import os
import pwd
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).with_name('hermes-agent-credential.py')
spec = importlib.util.spec_from_file_location('hermes_agent_credential', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
USER = pwd.getpwuid(os.getuid()).pw_name


class CredentialHelperTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.env = self.root / '.env'
        self.env.write_text(
            'NODE_ENV=production\n'
            'HERMES_AGENT_AUTH_SECRET=shared-secret-value-000000000000000\n'
            'HERMES_AGENT_ALLOWED_GITHUB_IDS=service:hermes-agent:a,service:hermes-agent:b\n'
        )
        os.chmod(self.env, 0o640)
        self.credentials = self.root / 'hermes-agent-credentials.json'

    def tearDown(self):
        self.directory.cleanup()

    def run_helper(self, *args):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            helper.main([*args[:1], str(self.env), *args[1:], '--factory-user', USER])
        return stdout.getvalue()

    def env_values(self):
        return helper.read_env(self.env)[1]

    def test_provision_creates_owner_only_file_and_moves_identity_off_the_shared_list(self):
        printed = self.run_helper('provision', 'service:hermes-agent:a')
        secret = printed.strip()
        self.assertEqual(printed.count('\n'), 1)
        self.assertGreaterEqual(len(secret), 32)
        self.assertEqual(json.loads(self.credentials.read_text()), {'service:hermes-agent:a': secret})
        self.assertEqual(stat.S_IMODE(self.credentials.stat().st_mode), 0o600)
        values = self.env_values()
        self.assertEqual(values['HERMES_AGENT_CREDENTIALS_FILE'], str(self.credentials))
        self.assertEqual(values['HERMES_AGENT_ALLOWED_GITHUB_IDS'], 'service:hermes-agent:b')
        self.assertEqual(values['HERMES_AGENT_AUTH_SECRET'], 'shared-secret-value-000000000000000')
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o640)

    def test_provision_reuses_a_secret_unless_rotated_and_scopes_owners(self):
        first = self.run_helper('provision', 'service:hermes-agent:a').strip()
        again = self.run_helper('provision', 'service:hermes-agent:a', '--owner', 'iam:author').strip()
        self.assertEqual(first, again)
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a'],
                         {'secret': first, 'owners': ['iam:author']})
        rotated = self.run_helper('provision', 'service:hermes-agent:a', '--rotate').strip()
        self.assertNotEqual(rotated, first)
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a']['owners'], ['iam:author'])

    def test_each_agent_gets_a_distinct_secret(self):
        first = self.run_helper('provision', 'service:hermes-agent:a').strip()
        second = self.run_helper('provision', 'service:hermes-agent:b').strip()
        self.assertNotEqual(first, second)
        self.assertNotIn('HERMES_AGENT_ALLOWED_GITHUB_IDS', self.env_values())

    def test_revoke_removes_the_credential_and_keeps_the_identity_off_the_shared_list(self):
        self.run_helper('provision', 'service:hermes-agent:a')
        self.assertEqual(self.run_helper('revoke', 'service:hermes-agent:a'), '')
        self.assertEqual(json.loads(self.credentials.read_text()), {})
        self.assertEqual(self.env_values()['HERMES_AGENT_ALLOWED_GITHUB_IDS'], 'service:hermes-agent:b')

    def test_refuses_unsafe_or_ambiguous_input(self):
        for identity in ["service:x' && reboot", 'a b', '']:
            with self.assertRaises(SystemExit):
                self.run_helper('provision', identity)
        self.env.write_text(self.env.read_text() + 'HERMES_AGENT_CREDENTIALS={"x":"y"}\n')
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a')

    def test_refuses_the_shared_default_identity_and_a_corrupt_file(self):
        self.env.write_text(self.env.read_text() + 'HERMES_AGENT_GITHUB_ID=service:hermes-agent\n')
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent')
        self.credentials.write_text('{broken')
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a')
        self.assertEqual(self.credentials.read_text(), '{broken')

    def test_inline_bootstrap_used_over_ssh_runs_the_helper(self):
        # The provisioning script passes the helper base64-encoded in argv.
        encoded = base64.b64encode(HELPER.read_bytes()).decode()
        bootstrap = ('import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)),'
                     '"hermes-agent-credential.py","exec"),{"__name__":"__main__"})')
        result = subprocess.run(
            [sys.executable, '-I', '-c', bootstrap, encoded, 'provision', str(self.env),
             'service:hermes-agent:a', '--factory-user', USER],
            capture_output=True, text=True, check=True)
        self.assertGreaterEqual(len(result.stdout.strip()), 32)
        self.assertIn('service:hermes-agent:a', json.loads(self.credentials.read_text()))


if __name__ == '__main__':
    unittest.main()
