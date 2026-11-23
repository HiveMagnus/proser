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

    def run_helper(self, *args, stdin=''):
        stdout = io.StringIO()
        previous = sys.stdin
        sys.stdin = io.StringIO(stdin)
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                helper.main([*args[:1], str(self.env), *args[1:], '--factory-user', USER])
        finally:
            sys.stdin = previous
        return stdout.getvalue()

    def provision(self, identity, secret, *extra, password_line=True):
        stdin = ('sudo-password-not-consumed\n' if password_line else '') + f'PROSER_AGENT_SECRET={secret}\n'
        return self.run_helper('provision', identity, *extra, stdin=stdin)

    def env_values(self):
        return helper.read_env(self.env)[1]

    def test_provision_stores_the_supplied_secret_owner_only_and_never_prints_it(self):
        secret = 'a' * 64
        self.assertEqual(self.provision('service:hermes-agent:a', secret), '')
        self.assertEqual(json.loads(self.credentials.read_text()), {'service:hermes-agent:a': secret})
        self.assertEqual(stat.S_IMODE(self.credentials.stat().st_mode), 0o600)
        values = self.env_values()
        self.assertEqual(values['HERMES_AGENT_CREDENTIALS_FILE'], str(self.credentials))
        self.assertEqual(values['HERMES_AGENT_ALLOWED_GITHUB_IDS'], 'service:hermes-agent:b')
        self.assertEqual(values['HERMES_AGENT_AUTH_SECRET'], 'shared-secret-value-000000000000000')
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o640)

    def test_ignores_a_leading_sudo_password_line_and_requires_the_marked_secret(self):
        self.provision('service:hermes-agent:a', 'b' * 64, password_line=False)
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a'], 'b' * 64)
        for stdin in ['', 'only-a-password\n', 'PROSER_AGENT_SECRET=short\n', "PROSER_AGENT_SECRET=" + "x" * 40 + "'\n"]:
            with self.assertRaises(SystemExit):
                self.run_helper('provision', 'service:hermes-agent:b', stdin=stdin)

    def test_reprovisioning_replaces_the_secret_and_keeps_owner_scope(self):
        self.provision('service:hermes-agent:a', 'c' * 64, '--owner', 'iam:author')
        self.provision('service:hermes-agent:a', 'd' * 64)
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a'],
                         {'secret': 'd' * 64, 'owners': ['iam:author']})

    def test_refuses_a_secret_another_agent_or_the_shared_secret_uses(self):
        self.provision('service:hermes-agent:a', 'e' * 64)
        with self.assertRaises(SystemExit):
            self.provision('service:hermes-agent:b', 'e' * 64)
        with self.assertRaises(SystemExit):
            self.provision('service:hermes-agent:b', 'shared-secret-value-000000000000000')
        self.provision('service:hermes-agent:b', 'f' * 64)
        self.assertNotIn('HERMES_AGENT_ALLOWED_GITHUB_IDS', self.env_values())

    def test_revoke_removes_the_credential_and_keeps_the_identity_off_the_shared_list(self):
        self.provision('service:hermes-agent:a', 'g' * 64)
        self.assertEqual(self.run_helper('revoke', 'service:hermes-agent:a'), '')
        self.assertEqual(json.loads(self.credentials.read_text()), {})
        self.assertEqual(self.env_values()['HERMES_AGENT_ALLOWED_GITHUB_IDS'], 'service:hermes-agent:b')

    def test_refuses_unsafe_or_ambiguous_input(self):
        for identity in ["service:x' && reboot", 'a b', '']:
            with self.assertRaises(SystemExit):
                self.provision(identity, 'h' * 64)
        self.env.write_text(self.env.read_text() + 'HERMES_AGENT_CREDENTIALS={"x":"y"}\n')
        with self.assertRaises(SystemExit):
            self.provision('service:hermes-agent:a', 'h' * 64)

    def test_refuses_the_shared_default_identity_and_a_corrupt_file(self):
        self.env.write_text(self.env.read_text() + 'HERMES_AGENT_GITHUB_ID=service:hermes-agent\n')
        with self.assertRaises(SystemExit):
            self.provision('service:hermes-agent', 'i' * 64)
        self.credentials.write_text('{broken')
        with self.assertRaises(SystemExit):
            self.provision('service:hermes-agent:a', 'i' * 64)
        self.assertEqual(self.credentials.read_text(), '{broken')

    def test_inline_bootstrap_used_over_ssh_runs_the_helper(self):
        # The provisioning script passes the helper base64-encoded in argv.
        encoded = base64.b64encode(HELPER.read_bytes()).decode()
        bootstrap = ('import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)),'
                     '"hermes-agent-credential.py","exec"),{"__name__":"__main__"})')
        result = subprocess.run(
            [sys.executable, '-I', '-c', bootstrap, encoded, 'provision', str(self.env),
             'service:hermes-agent:a', '--factory-user', USER],
            input='password\nPROSER_AGENT_SECRET=' + 'j' * 64 + '\n',
            capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a'], 'j' * 64)


if __name__ == '__main__':
    unittest.main()
