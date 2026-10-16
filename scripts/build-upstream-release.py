#!/usr/bin/env python3
"""Build only the explicit reviewed SQL release; never infer migrations from a directory."""
import hashlib
import json
import re
import sys
from pathlib import Path


def build(root: Path, output: Path) -> None:
    manifest = json.loads((root / 'scripts/upstream-release.json').read_text())
    release = manifest['release']
    if not re.fullmatch(r'[a-z0-9-]{1,80}', release):
        raise ValueError('Invalid release identity')
    chunks = []
    names = []
    for entry in manifest['migrations']:
        name, digest = entry['file'], entry['sha256']
        if not re.fullmatch(r'20261016\d{6}_04[2-4]\d_[a-z0-9_]+\.sql', name):
            raise ValueError('Migration outside the approved release range')
        if name in names or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid or repeated migration identity')
        raw = (root / 'supabase/migrations' / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Migration checksum differs from approved manifest: ' + name)
        sql = raw.decode('utf8')
        # All approved migrations are SQL, run under one outer transaction.
        if re.search(r'^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;', sql, re.M | re.I) or re.search(r'^\s*\\', sql, re.M):
            raise ValueError('Migration contains transaction or psql control: ' + name)
        names.append(name)
        chunks.append('-- source: ' + name + '\n' + sql)
    if not chunks or names != sorted(names):
        raise ValueError('Release must contain ordered explicit migrations')
    before = (root / 'scripts/upstream-release-preflight.sql').read_text()
    after = (root / 'scripts/upstream-release-postflight.sql').read_text()
    checksum = hashlib.sha256(('\n'.join(chunks) + before + after).encode()).hexdigest()
    journal_check = f"""
do $journal$
begin
  if to_regclass('escreveai_ops.schema_releases') is not null and exists (
    select 1 from escreveai_ops.schema_releases where release = '{release}' and checksum <> '{checksum}'
  ) then raise exception 'Recorded release checksum differs; refusing changed migration'; end if;
end $journal$;
"""
    # A missing private journal is normal on the recovered installation. It is not
    # evidence that any historical migration is missing; only this list is considered.
    init = """
create schema if not exists escreveai_ops authorization postgres;
revoke all on schema escreveai_ops from public, anon, authenticated, service_role;
create table if not exists escreveai_ops.schema_releases (
  release text primary key, checksum text not null, applied_at timestamptz not null default now()
);
revoke all on escreveai_ops.schema_releases from public, anon, authenticated, service_role;
"""
    # The read-only preflight uses a dynamic query so a missing journal does not
    # cause parse-time resolution of a relation that has never existed.
    read_journal = f"""
do $journal$
declare recorded text;
begin
  if to_regclass('escreveai_ops.schema_releases') is not null then
    execute 'select checksum from escreveai_ops.schema_releases where release = $1' into recorded using '{release}';
    if recorded is not null and recorded <> '{checksum}' then
      raise exception 'Recorded release checksum differs; refusing changed migration';
    end if;
  end if;
end $journal$;
"""
    output.mkdir(parents=True, exist_ok=True)
    (output / 'release-preflight.sql').write_text('-- escreve.ai stable release preflight\n' + before + read_journal + "\nselect 'ready';\n")
    apply = ('-- escreve.ai stable release apply\nset local lock_timeout = \'5s\';\n'
             "set local statement_timeout = '120s';\n" + before + init + journal_check +
             f"select not exists(select 1 from escreveai_ops.schema_releases where release = '{release}') as install_release \\gset\n"
             '\\if :install_release\n' + '\n'.join(chunks) + '\n' + after +
             f"\ninsert into escreveai_ops.schema_releases(release,checksum) values ('{release}','{checksum}');\n"
             '\\endif\n' + after + "\nselect 'ready';\n")
    (output / 'release-apply.sql').write_text(apply)
    (output / 'release-verify.sql').write_text('-- escreve.ai stable release verify\n' + after + journal_check +
        f"\nselect case when exists(select 1 from escreveai_ops.schema_releases where release = '{release}' and checksum = '{checksum}') then 'ready' else 'missing' end;\n")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Expected artifact root and output directory')
    build(Path(sys.argv[1]), Path(sys.argv[2]))
