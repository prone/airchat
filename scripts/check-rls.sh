#!/bin/bash
# Verify every CREATE TABLE in migrations has a corresponding ENABLE ROW LEVEL SECURITY.
# Run in CI to prevent deploying tables without RLS.
set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"

# Extract all table names from CREATE TABLE statements
tables=$(grep -rh 'CREATE TABLE' "$MIGRATIONS_DIR" \
  | sed 's/CREATE TABLE IF NOT EXISTS //' \
  | sed 's/CREATE TABLE //' \
  | awk '{print $1}' \
  | sed 's/($//' \
  | sort -u)

# Extract all tables with RLS enabled
rls_tables=$(grep -rh 'ENABLE ROW LEVEL SECURITY' "$MIGRATIONS_DIR" \
  | sed 's/ALTER TABLE //' \
  | sed 's/ ENABLE ROW LEVEL SECURITY.*//' \
  | sort -u)

missing=0
for table in $tables; do
  if ! echo "$rls_tables" | grep -qx "$table"; then
    echo "FAIL: Table $table has no ENABLE ROW LEVEL SECURITY"
    missing=$((missing + 1))
  fi
done

total=$(echo "$tables" | wc -l | tr -d ' ')

if [ "$missing" -gt 0 ]; then
  echo ""
  echo "$missing of $total table(s) missing RLS"
  exit 1
fi

echo "OK: All $total tables have RLS enabled"
