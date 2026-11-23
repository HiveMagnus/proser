#!/usr/bin/env python3
"""Set or revoke one Hermes agent's own Factory signing secret.

Runs as root on the Factory host and supports three layouts:

- Native (--env-file): the credentials live in the JSON file named by
  HERMES_AGENT_CREDENTIALS_FILE in the Factory environment file. It is created
  beside that file when the setting is absent and is owned by the Factory
  service user (--factory-user) with mode 0600.
- Compose with a Factory env_file (--compose-file): the credentials file lives
  in a bind mount of the factory service, by default the one whose container
  path ends in /secrets. The env file receives the container path, and the
  file is owned by the user the factory container runs as.
- Compose without a Factory env_file, such as the repository's compose.yml
  (--compose-file with --compose-env-file): Factory receives
  HERMES_AGENT_CREDENTIALS through interpolation, so the credentials are kept
  as single-quoted JSON in that env file, for example .env.compose.

`provision` reads the secret from stdin as a `PROSER_AGENT_SECRET=<value>` line
and never writes it anywhere else. Other stdin lines, such as a sudo password
that sudo did not consume, are ignored. The operator generates the secret, so
it travels only from the operator to the Factory host and the agent host.
"""
import argparse
import json
import os
import pwd
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

IDENTITY = re.compile(r'^[A-Za-z0-9:._@+-]{1,160}$')
SECRET = re.compile(r'^[A-Za-z0-9_-]{32,256}$')
OWNER = re.compile(r'^([0-9]{1,10}):([0-9]{1,10})$')
SECRET_PREFIX = 'PROSER_AGENT_SECRET='
DEFAULT_FILE_NAME = 'hermes-agent-credentials.json'


def fail(message):
    raise SystemExit(f'ERROR: {message}')


def read_secret(stream):
    for line in stream:
        if line.startswith(SECRET_PREFIX):
            value = line[len(SECRET_PREFIX):].strip()
            if not SECRET.match(value):
                fail('The agent secret must be 32 to 256 URL-safe characters')
            return value
    fail('No PROSER_AGENT_SECRET line was supplied on stdin')


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


def parse_credentials(text, source):
    try:
        credentials = json.loads(text)
    except json.JSONDecodeError:
        fail(f'{source} is not valid JSON; repair it before provisioning')
    if not isinstance(credentials, dict):
        fail(f'{source} must contain a JSON object')
    return credentials


def entry_secret(entry):
    return entry if isinstance(entry, str) else entry.get('secret') if isinstance(entry, dict) else None


@dataclass
class Layout:
    env_path: Path
    credentials_path: Path | None  # host path of the credentials file; None stores them inline
    configured_path: str  # value HERMES_AGENT_CREDENTIALS_FILE must hold
    owner: tuple[int, int]


def compose_command(args):
    command = ['docker', 'compose']
    if args.compose_env_file:
        command += ['--env-file', str(args.compose_env_file)]
    for file in args.compose_file:
        command += ['-f', str(file)]
    return command


def compose_config(args):
    result = subprocess.run([*compose_command(args), 'config', '--no-env-resolution', '--format', 'json'],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if result.returncode != 0:
        fail(f'docker compose config failed: {result.stderr.strip()[:400]}')
    return json.loads(result.stdout)


def container_owner(args):
    # `docker compose exec` forwards stdin, which still carries the secret.
    result = subprocess.run([*compose_command(args), 'exec', '-T', args.factory_service, 'sh', '-c', 'id -u; id -g'],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True)
    parts = result.stdout.split()
    if result.returncode != 0 or len(parts) != 2 or not all(part.isdigit() for part in parts):
        fail('Could not read the user the factory container runs as. Start the stack or pass --container-owner UID:GID.')
    return int(parts[0]), int(parts[1])


def native_layout(args):
    try:
        service_user = pwd.getpwnam(args.factory_user)
    except KeyError:
        fail(f'Factory service user {args.factory_user} does not exist')
    env_path = args.env_file.resolve()
    _, values = read_env(env_path)
    configured = values.get('HERMES_AGENT_CREDENTIALS_FILE', '')
    path = Path(configured) if configured else env_path.parent / DEFAULT_FILE_NAME
    if not path.is_absolute():
        path = env_path.parent / path
    return Layout(env_path, path, str(path), (service_user.pw_uid, service_user.pw_gid))


def compose_layout(args):
    config = compose_config(args)
    service = (config.get('services') or {}).get(args.factory_service)
    if not service:
        fail(f'The Compose files define no {args.factory_service} service')
    env_files = [Path(item['path'] if isinstance(item, dict) else item) for item in service.get('env_file') or []]
    if not env_files:
        # Interpolation layout: Factory reads HERMES_AGENT_CREDENTIALS from the
        # Compose environment, so the credentials live in the env file itself.
        if 'HERMES_AGENT_CREDENTIALS' not in (service.get('environment') or {}):
            fail(f'The {args.factory_service} service neither reads an env_file nor receives HERMES_AGENT_CREDENTIALS')
        if not args.compose_env_file:
            fail('This Compose layout keeps credentials in its interpolation env file; pass --compose-env-file')
        return Layout(args.compose_env_file.resolve(), None, '', (0, 0))
    env_path = next((path for path in env_files if path.is_file() and
                     re.search(r'^(HERMES_AGENT_|FACTORY_AUTH_SECRET=)', path.read_text(), re.M)), env_files[-1])
    _, values = read_env(env_path)
    binds = [(Path(volume['source']), PurePosixPath(volume['target']))
             for volume in service.get('volumes') or [] if volume.get('type') == 'bind']
    configured = values.get('HERMES_AGENT_CREDENTIALS_FILE', '')
    if configured:
        target = PurePosixPath(configured)
        match = next(((source, mount) for source, mount in binds if target.is_relative_to(mount) and target != mount), None)
        if not match:
            fail(f'HERMES_AGENT_CREDENTIALS_FILE={configured} is not inside a bind mount of the {args.factory_service} service')
        host = match[0] / target.relative_to(match[1])
    else:
        match = next(((source, mount) for source, mount in binds if mount.name == 'secrets'), None)
        if not match:
            fail(f'Add a bind mount for a secrets directory to the {args.factory_service} service, '
                 'for example ./secrets:/opt/proser-factory/secrets:ro, or set HERMES_AGENT_CREDENTIALS_FILE '
                 'to a path inside an existing bind mount.')
        target = match[1] / DEFAULT_FILE_NAME
        host = match[0] / DEFAULT_FILE_NAME
    if not host.parent.is_dir():
        fail(f'The bind mount source {host.parent} does not exist')
    if args.container_owner:
        parsed = OWNER.match(args.container_owner)
        if not parsed:
            fail('--container-owner must be UID:GID')
        owner = (int(parsed[1]), int(parsed[2]))
    else:
        owner = container_owner(args)
    return Layout(env_path, host, str(target), owner)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['provision', 'revoke'])
    parser.add_argument('identity')
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--env-file', type=Path, help='Native Factory environment file.')
    target.add_argument('--compose-file', type=Path, action='append', help='Compose file; repeat in order.')
    parser.add_argument('--compose-env-file', type=Path, help='Compose interpolation env file, such as .env.compose.')
    parser.add_argument('--factory-service', default='factory', help='Compose service that runs Factory.')
    parser.add_argument('--container-owner', default='', help='UID:GID the factory container runs as.')
    parser.add_argument('--owner', default='', help='Account this agent may act for; added to its owners list.')
    parser.add_argument('--factory-user', default='proser-factory', help='User the native Factory service runs as.')
    args = parser.parse_args(argv)

    if not IDENTITY.match(args.identity):
        fail('Agent identity may contain only letters, digits and :._@+-')
    if args.owner and not IDENTITY.match(args.owner):
        fail('Owner identity may contain only letters, digits and :._@+-')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', args.factory_service):
        fail('--factory-service is not a valid Compose service name')

    # Read the secret before running any other command, so nothing else can
    # consume or see the stdin that carries it.
    secret = read_secret(sys.stdin) if args.action == 'provision' else None
    layout = compose_layout(args) if args.compose_file else native_layout(args)
    inline = layout.credentials_path is None
    lines, values = read_env(layout.env_path)
    if inline:
        if values.get('HERMES_AGENT_CREDENTIALS_FILE', ''):
            fail(f'{layout.env_path} sets HERMES_AGENT_CREDENTIALS_FILE, which this Compose layout does not pass to Factory')
        raw = values.get('HERMES_AGENT_CREDENTIALS', '')
        credentials = parse_credentials(raw, f'HERMES_AGENT_CREDENTIALS in {layout.env_path}') if raw else {}
    else:
        if values.get('HERMES_AGENT_CREDENTIALS', ''):
            fail('HERMES_AGENT_CREDENTIALS is set inline in the Factory environment file. '
                 'Move its entries into a file named by HERMES_AGENT_CREDENTIALS_FILE first.')
        path = layout.credentials_path
        credentials = parse_credentials(path.read_text(), path) if path.exists() else {}

    if values.get('HERMES_AGENT_GITHUB_ID', '') == args.identity:
        fail('This identity is HERMES_AGENT_GITHUB_ID, the shared default identity. Provision a separate identity.')

    # An identity with its own secret must not also be accepted under the
    # shared secret, so it leaves the shared allow-list either way.
    allowed = [item for item in split_ids(values.get('HERMES_AGENT_ALLOWED_GITHUB_IDS', '')) if item != args.identity]
    env_updates = {'HERMES_AGENT_ALLOWED_GITHUB_IDS': ','.join(allowed) if allowed else None}
    if not inline and values.get('HERMES_AGENT_CREDENTIALS_FILE', '') != layout.configured_path:
        env_updates['HERMES_AGENT_CREDENTIALS_FILE'] = layout.configured_path

    if args.action == 'revoke':
        if args.identity not in credentials:
            print(f'{args.identity} has no dedicated credential.', file=sys.stderr)
        credentials.pop(args.identity, None)
    else:
        taken = {entry_secret(value) for name, value in credentials.items() if name != args.identity}
        if secret in taken or secret == values.get('HERMES_AGENT_AUTH_SECRET', ''):
            fail('The agent secret is already in use; generate a new one')
        previous = credentials.get(args.identity)
        entry = previous if isinstance(previous, dict) else {}
        entry['secret'] = secret
        if args.owner:
            owners = entry.get('owners') if isinstance(entry.get('owners'), list) else []
            if args.owner not in owners:
                owners.append(args.owner)
            entry['owners'] = owners
        credentials[args.identity] = entry if 'owners' in entry else secret

    if inline:
        # Single quotes keep Compose from interpolating the JSON. Identities and
        # secrets are restricted to characters that cannot close the quotes.
        compact = json.dumps(credentials, separators=(',', ':'), sort_keys=True)
        env_updates['HERMES_AGENT_CREDENTIALS'] = f"'{compact}'" if credentials else None
        stored = layout.env_path
    else:
        write_atomic(layout.credentials_path, json.dumps(credentials, indent=2, sort_keys=True) + '\n',
                     layout.owner[0], layout.owner[1], 0o600)
        stored = layout.credentials_path
    env_stat = layout.env_path.stat()
    write_atomic(layout.env_path, '\n'.join(update_env(lines, env_updates)) + '\n',
                 env_stat.st_uid, env_stat.st_gid, env_stat.st_mode & 0o777)
    print(f'{args.action}: {args.identity} in {stored} ({len(credentials)} agents)', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
