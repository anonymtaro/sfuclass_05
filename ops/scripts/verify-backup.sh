#!/usr/bin/env bash
# ops/scripts/verify-backup.sh
# restore snapshot into scratch RDS. Runs quarterly in CI (restore-database.md).
set -euo pipefail

ENV="${1:?usage: verify-backup.sh <env>}"
VAULT="classroom-${ENV}-backup-vault"
SCRATCH_ID="classroom-${ENV}-pg-restore-drill-$(date +%s)"
SG_ID="${RDS_SECURITY_GROUP_ID:?set RDS_SECURITY_GROUP_ID (aws_security_group.rds.id output)}"
SUBNET_GROUP="classroom-${ENV}-db-subnets"

cleanup() {
  echo "Cleaning up scratch instance $SCRATCH_ID ..."
  aws rds delete-db-instance --db-instance-identifier "$SCRATCH_ID" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 1/4 find latest recovery point in $VAULT =="
RECOVERY_POINT_ARN=$(aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name "$VAULT" \
  --by-resource-type "RDS" \
  --query 'sort_by(RecoveryPoints, &CreationDate)[-1].RecoveryPointArn' \
  --output text)
[ -n "$RECOVERY_POINT_ARN" ] && [ "$RECOVERY_POINT_ARN" != "None" ] \
  || { echo "No recovery point found in $VAULT"; exit 1; }
echo "Using recovery point: $RECOVERY_POINT_ARN"

echo "== 2/4 restore into scratch instance $SCRATCH_ID =="
BACKUP_ROLE_ARN=$(aws backup describe-backup-vault --backup-vault-name "$VAULT" --query 'IamRoleArn' --output text 2>/dev/null || echo "")
JOB_ID=$(aws backup start-restore-job \
  --recovery-point-arn "$RECOVERY_POINT_ARN" \
  --iam-role-arn "$BACKUP_ROLE_ARN" \
  --metadata "{\"DBInstanceIdentifier\":\"$SCRATCH_ID\",\"DBSubnetGroupName\":\"$SUBNET_GROUP\",\"VpcSecurityGroupIds\":\"$SG_ID\",\"PubliclyAccessible\":\"false\"}" \
  --query 'RestoreJobId' --output text)

echo "Waiting for restore job $JOB_ID to complete (this can take a while) ..."
while true; do
  STATUS=$(aws backup describe-restore-job --restore-job-id "$JOB_ID" --query 'Status' --output text)
  echo "  status: $STATUS"
  if [ "$STATUS" = "COMPLETED" ]; then break; fi
  if [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "ABORTED" ]; then
    echo "Restore job failed"
    exit 1
  fi
  sleep 30
done

echo "== 3/4 run migrations against the restored instance =="
aws rds wait db-instance-available --db-instance-identifier "$SCRATCH_ID"
SCRATCH_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$SCRATCH_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
export DATABASE_URL="postgres://verify:${SCRATCH_DB_PASSWORD:?set SCRATCH_DB_PASSWORD}@${SCRATCH_ENDPOINT}:5432/classroom"
node server/src/db/migrate.js

echo "== 4/4 row-count sanity check =="
node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const table of ["users", "courses", "messages", "enrollments"]) {
    const { rows } = await c.query(`SELECT count(*) FROM ${table}`);
    console.log(`${table}: ${rows[0].count} rows`);
    if (Number(rows[0].count) === 0) throw new Error(`${table} is empty in the restored instance`);
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
'

echo "VERIFY-BACKUP OK: restore + migrate + row-count check all passed for $ENV"
# cleanup() runs on exit via the trap above - scratch instance is always destroyed.