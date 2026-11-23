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
                helper.main([*args[:2], '--env-file', str(self.env), *args[2:], '--factory-user', USER])
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
            [sys.executable, '-I', '-c', bootstrap, encoded, 'provision', 'service:hermes-agent:a',
             '--env-file', str(self.env), '--factory-user', USER],
            input='password\nPROSER_AGENT_SECRET=' + 'j' * 64 + '\n',
            capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(self.credentials.read_text())['service:hermes-agent:a'], 'j' * 64)


class ComposeLayoutTest(unittest.TestCase):
    """Both Compose layouts, with `docker compose` replaced by fixed output."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / 'secrets').mkdir()
        self.compose = self.root / 'compose.yml'
        self.compose.write_text('services: {}\n')
        self.config = {}
        self.owner_calls = 0
        self.saved = helper.compose_config, helper.container_owner
        helper.compose_config = lambda args: self.config

        def owner(args):
            # Running a command after the secret is read must not lose it.
            self.owner_calls += 1
            self.assertEqual(sys.stdin.read(), '')
            return os.getuid(), os.getgid()
        helper.container_owner = owner

    def tearDown(self):
        helper.compose_config, helper.container_owner = self.saved
        self.directory.cleanup()

    def run_helper(self, *args, secret=None):
        previous = sys.stdin
        sys.stdin = io.StringIO(f'PROSER_AGENT_SECRET={secret}\n' if secret else '')
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                helper.main([*args[:2], '--compose-file', str(self.compose), *args[2:]])
        finally:
            sys.stdin = previous
        return out.getvalue()

    def env_file_layout(self, extra=''):
        env = self.root / 'factory.env'
        env.write_text('FACTORY_AUTH_SECRET=x\nHERMES_AGENT_AUTH_SECRET=shared-secret-value-000000000000000\n' + extra)
        os.chmod(env, 0o600)
        self.config = {'services': {'factory': {
            'env_file': [{'path': str(env), 'format': 'raw'}],
            'volumes': [
                {'type': 'bind', 'source': str(self.root / 'data'), 'target': '/opt/proser-factory/data'},
                {'type': 'bind', 'source': str(self.root / 'secrets'), 'target': '/opt/proser-factory/secrets', 'read_only': True},
                {'type': 'volume', 'source': 'named', 'target': '/srv/secrets'},
            ]}}}
        return env

    def test_env_file_layout_writes_into_the_secrets_mount_and_records_the_container_path(self):
        env = self.env_file_layout()
        self.assertEqual(self.run_helper('provision', 'service:hermes-agent:a', '--owner', 'iam:author', secret='k' * 64), '')
        stored = self.root / 'secrets' / 'hermes-agent-credentials.json'
        self.assertEqual(json.loads(stored.read_text()), {'service:hermes-agent:a': {'secret': 'k' * 64, 'owners': ['iam:author']}})
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o600)
        self.assertEqual(stored.stat().st_uid, os.getuid())
        self.assertEqual(helper.read_env(env)[1]['HERMES_AGENT_CREDENTIALS_FILE'], '/opt/proser-factory/secrets/hermes-agent-credentials.json')
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        self.assertEqual(self.owner_calls, 1)
        self.run_helper('revoke', 'service:hermes-agent:a')
        self.assertEqual(json.loads(stored.read_text()), {})

    def test_env_file_layout_follows_an_existing_container_path_and_explicit_owner(self):
        (self.root / 'data').mkdir()
        self.env_file_layout('HERMES_AGENT_CREDENTIALS_FILE=/opt/proser-factory/data/agents.json\n')
        self.run_helper('provision', 'service:hermes-agent:a', '--container-owner', f'{os.getuid()}:{os.getgid()}', secret='l' * 64)
        self.assertEqual(json.loads((self.root / 'data' / 'agents.json').read_text()), {'service:hermes-agent:a': 'l' * 64})
        self.assertEqual(self.owner_calls, 0)

    def test_env_file_layout_refuses_without_a_usable_bind_mount(self):
        self.env_file_layout('HERMES_AGENT_CREDENTIALS_FILE=/elsewhere/agents.json\n')
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a', secret='m' * 64)
        self.env_file_layout()
        self.config['services']['factory']['volumes'] = []
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a', secret='m' * 64)

    def test_interpolation_layout_keeps_single_quoted_json_in_the_compose_env_file(self):
        env = self.root / '.env.compose'
        env.write_text('PROSER_DB_PASSWORD=x\nHERMES_AGENT_CREDENTIALS=\n')
        self.config = {'services': {'factory': {'environment': {'HERMES_AGENT_CREDENTIALS': ''}}}}
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a', secret='n' * 64)
        self.run_helper('provision', 'service:hermes-agent:a', '--compose-env-file', str(env), '--owner', 'iam:author', secret='n' * 64)
        self.run_helper('provision', 'service:hermes-agent:b', '--compose-env-file', str(env), secret='o' * 64)
        line = next(l for l in env.read_text().splitlines() if l.startswith('HERMES_AGENT_CREDENTIALS='))
        self.assertTrue(line.startswith("HERMES_AGENT_CREDENTIALS='{") and line.endswith("}'"))
        self.assertEqual(json.loads(helper.read_env(env)[1]['HERMES_AGENT_CREDENTIALS']), {
            'service:hermes-agent:a': {'owners': ['iam:author'], 'secret': 'n' * 64},
            'service:hermes-agent:b': 'o' * 64,
        })
        self.assertFalse((self.root / 'secrets' / 'hermes-agent-credentials.json').exists())
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:c', '--compose-env-file', str(env), secret='n' * 64)
        self.run_helper('revoke', 'service:hermes-agent:a', '--compose-env-file', str(env))
        self.run_helper('revoke', 'service:hermes-agent:b', '--compose-env-file', str(env))
        self.assertNotIn('HERMES_AGENT_CREDENTIALS', helper.read_env(env)[1])

    def test_refuses_a_service_that_cannot_receive_credentials(self):
        self.config = {'services': {'factory': {'environment': {}}}}
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a', secret='p' * 64)
        self.config = {'services': {}}
        with self.assertRaises(SystemExit):
            self.run_helper('provision', 'service:hermes-agent:a', secret='p' * 64)


if __name__ == '__main__':
    unittest.main()
