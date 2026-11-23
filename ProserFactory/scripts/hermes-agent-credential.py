#!/usr/bin/env python3
"""Create, rotate or revoke one Hermes agent's own Factory signing secret.

Runs as root on the Factory host. The credentials live in the JSON file named
by HERMES_AGENT_CREDENTIALS_FILE in the Factory environment file. The file is
added to the environment file when it is missing, and is owned by the Factory
service user with mode 0600 because Factory reads it at runtime.

`provision` prints the agent's secret on stdout and nothing else, so the caller
can hand it to the agent host without storing it. Status goes to stderr.
"""
import argparse
import json
import os
import pwd
import re
import secrets
import sys
import tempfile
from pathlib import Path

IDENTITY = re.compile(r'^[A-Za-z0-9:._@+-]{1,160}$')
DEFAULT_FILE_NAME = 'hermes-agent-credentials.json'
MINIMUM_SECRET_LENGTH = 32


def fail(message):
    raise SystemExit(f'ERROR: {message}')


def env_value(raw):
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
        value = value[1:-1]
    return value


def read_env(path):
    if not path.is_file():
        fail(f'Factory environment file not found: {path}')
    lines = path.read_text().splitlines()
    values = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = env_value(value)
    return lines, values


def split_ids(value):
    return [item.strip() for item in value.split(',') if item.strip()]


def write_atomic(path, text, uid, gid, mode):
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def update_env(lines, updates):
    """Replace or append KEY=value lines; a value of None removes the key."""
    seen = set()
    out = []
    for line in lines:
        key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else None
        if key in updates:
            seen.add(key)
            if updates[key] is not None:
                out.append(f'{key}={updates[key]}')
            continue
        out.append(line)
    missing = [key for key, value in updates.items() if key not in seen and value is not None]
    if missing and out and out[-1].strip():
        out.append('')
    out.extend(f'{key}={updates[key]}' for key in missing)
    return out


def load_credentials(path):
    if not path.exists():
        return {}
    try:
        credentials = json.loads(path.read_text())
    except json.JSONDecodeError:
        fail(f'{path} is not valid JSON; repair it before provisioning')
    if not isinstance(credentials, dict):
        fail(f'{path} must contain a JSON object')
    return credentials


def entry_secret(entry):
    return entry if isinstance(entry, str) else entry.get('secret') if isinstance(entry, dict) else None


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['provision', 'revoke'])
    parser.add_argument('env_file', type=Path)
    parser.add_argument('identity')
    parser.add_argument('--owner', default='', help='Account this agent may act for; added to its owners list.')
    parser.add_argument('--rotate', action='store_true', help='Replace an existing secret.')
    parser.add_argument('--factory-user', default='proser-factory', help='User the Factory service runs as.')
    args = parser.parse_args(argv)

    if not IDENTITY.match(args.identity):
        fail('Agent identity may contain only letters, digits and :._@+-')
    if args.owner and not IDENTITY.match(args.owner):
        fail('Owner identity may contain only letters, digits and :._@+-')
    try:
        service_user = pwd.getpwnam(args.factory_user)
    except KeyError:
        fail(f'Factory service user {args.factory_user} does not exist')

    env_path = args.env_file.resolve()
    lines, values = read_env(env_path)
    if values.get('HERMES_AGENT_CREDENTIALS', ''):
        fail('HERMES_AGENT_CREDENTIALS is set inline in the Factory environment file. '
             'Move its entries into a file named by HERMES_AGENT_CREDENTIALS_FILE first.')
    configured = values.get('HERMES_AGENT_CREDENTIALS_FILE', '')
    credentials_path = Path(configured) if configured else env_path.parent / DEFAULT_FILE_NAME
    if not credentials_path.is_absolute():
        credentials_path = env_path.parent / credentials_path
    credentials = load_credentials(credentials_path)

    # An identity with its own secret must not also be accepted under the
    # shared secret, so it leaves the shared allow-list either way.
    allowed = [item for item in split_ids(values.get('HERMES_AGENT_ALLOWED_GITHUB_IDS', '')) if item != args.identity]
    env_updates = {'HERMES_AGENT_ALLOWED_GITHUB_IDS': ','.join(allowed) if allowed else None}
    if not configured:
        env_updates['HERMES_AGENT_CREDENTIALS_FILE'] = str(credentials_path)
    if values.get('HERMES_AGENT_GITHUB_ID', '') == args.identity:
        fail('This identity is HERMES_AGENT_GITHUB_ID, the shared default identity. Provision a separate identity.')

    if args.action == 'revoke':
        if args.identity not in credentials:
            print(f'{args.identity} has no dedicated credential.', file=sys.stderr)
        credentials.pop(args.identity, None)
        secret = None
    else:
        previous = credentials.get(args.identity)
        entry = previous if isinstance(previous, dict) else {'secret': previous} if isinstance(previous, str) else {}
        secret = entry.get('secret')
        if args.rotate or not isinstance(secret, str) or len(secret) < MINIMUM_SECRET_LENGTH:
            taken = {entry_secret(value) for name, value in credentials.items() if name != args.identity}
            taken.add(values.get('HERMES_AGENT_AUTH_SECRET', ''))
            secret = secrets.token_urlsafe(48)
            while secret in taken:
                secret = secrets.token_urlsafe(48)
        entry['secret'] = secret
        if args.owner:
            owners = entry.get('owners') if isinstance(entry.get('owners'), list) else []
            if args.owner not in owners:
                owners.append(args.owner)
            entry['owners'] = owners
        credentials[args.identity] = entry if 'owners' in entry else secret

    write_atomic(credentials_path, json.dumps(credentials, indent=2, sort_keys=True) + '\n',
                 service_user.pw_uid, service_user.pw_gid, 0o600)
    env_stat = env_path.stat()
    write_atomic(env_path, '\n'.join(update_env(lines, env_updates)) + '\n',
                 env_stat.st_uid, env_stat.st_gid, env_stat.st_mode & 0o777)
    print(f'{args.action}: {args.identity} in {credentials_path} ({len(credentials)} agents)', file=sys.stderr)
    if secret:
        print(secret)


if __name__ == '__main__':
    main(sys.argv[1:])
