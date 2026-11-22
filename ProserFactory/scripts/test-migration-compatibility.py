#!/usr/bin/env python3
"""Focused tests for the conservative Factory schema release gate."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('check-migration-compatibility.py')
SPEC = importlib.util.spec_from_file_location('factory_migration_gate', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MigrationCompatibilityTests(unittest.TestCase):
    def test_additive_column_table_and_index(self):
        sql = '''CREATE TABLE "new_items" ("id" TEXT NOT NULL PRIMARY KEY);
                 ALTER TABLE "books" ADD COLUMN "subtitle" TEXT;
                 ALTER TABLE "books" ADD COLUMN "visible" BOOLEAN DEFAULT TRUE NOT NULL;
                 CREATE INDEX "new_items_id_idx" ON "new_items"("id");'''
        self.assertTrue(MODULE.safe_additive_sql(sql))

    def test_destructive_and_effectful_sql_is_held(self):
        for sql in ('DROP TABLE "books";', 'ALTER TABLE "books" DROP COLUMN "title";',
                    'UPDATE "books" SET "title" = NULL;',
                    'ALTER TABLE "books" ADD COLUMN "owner" TEXT NOT NULL;',
                    'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;'):
            with self.subTest(sql=sql):
                self.assertFalse(MODULE.safe_additive_sql(sql))

    def test_old_migration_edit_is_held(self):
        with patch.object(MODULE, 'git', side_effect=[b'', b'',
                b'M\0ProserFactory/prisma/migrations/20260901_old/migration.sql\0']):
            with self.assertRaisesRegex(ValueError, 'Existing Prisma authority changed'):
                MODULE.assess('a' * 40, 'b' * 40)

    def test_new_schema_without_migration_is_held(self):
        with patch.object(MODULE, 'git', side_effect=[b'', b'',
                b'M\0ProserFactory/prisma/schema.prisma\0']):
            with self.assertRaisesRegex(ValueError, 'without a new migration'):
                MODULE.assess('a' * 40, 'b' * 40)

    def test_new_additive_migration_is_reported(self):
        path = 'ProserFactory/prisma/migrations/20260901_new/migration.sql'
        with patch.object(MODULE, 'git', side_effect=[b'', b'',
                f'M\0ProserFactory/prisma/schema.prisma\0A\0{path}\0'.encode(),
                b'ALTER TABLE "books" ADD COLUMN "subtitle" TEXT;']):
            result = MODULE.assess('a' * 40, 'b' * 40)
        self.assertEqual(result['status'], 'additive-compatible')
        self.assertEqual(result['newMigrations'], [path])


if __name__ == '__main__':
    unittest.main()
