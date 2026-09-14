# Restore-database runbook — PITR drill, quarterly

A restore that has never been tested is not a backup. This drill is
scripted (`ops/scripts/verify-backup.sh`), runs in CI quarterly, and this
document is what a human follows if it ever has to be done for real.

## Scheduled drill (automated)
`ops/scripts/verify-backup.sh` already does steps 1–5 below against a
scratch instance and destroys it afterward. Check the CI job history for
`verify-backup` before assuming a manual drill is needed.

## Real incident: restoring `aws_db_instance.primary`

1. **Stop writes.** Scale `aws_ecs_service.api` and `.worker` to 0 desired
   count so nothing writes to the corrupted primary while you work.
2. **Pick a point in time.** RDS PITR supports any point within the
   `backup_retention_period` (7 days, `data.tf`). For anything older, use
   the AWS Backup vault (`aws_backup_vault.main`, 90-day retention in prod).
3. **Restore to a new identifier** — never restore over the original:
   ```
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier classroom-<env>-pg \
     --target-db-instance-identifier classroom-<env>-pg-restored \
     --restore-time <ISO8601-timestamp> \
     --db-subnet-group-name classroom-<env>-db-subnets \
     --vpc-security-group-ids <aws_security_group.rds.id>
   ```
4. **Verify** row counts on a handful of high-traffic tables (`messages`,
   `enrollments`, `lesson_progress`) against expectations before cutting
   over.
5. **Cut over**: update `DATABASE_URL` in the running task definitions (or
   re-point via a Terraform var + `terraform apply`) to the restored
   instance, then rename identifiers once confirmed stable.
6. **Resume writes**: scale `api`/`worker` back to their normal desired
   counts (`var.api_desired_count`, `var.worker_desired_count`).
7. **Post-mortem**: file what caused the corruption/loss before closing
   the incident — a restore without a cause found tends to repeat.

## Cross-region copy
If the primary region itself is unavailable, the nightly snapshot exists in
`aws_backup_vault.cross_region` (`eu-west-1` by default, `backup.tf`).
Restoring from there follows the same steps against that region's RDS API
endpoint, then requires re-pointing `infra/envs/<env>/terraform.tfvars`'s
`aws_region` for a full regional failover — a much bigger decision than a
single-instance restore, and should not be done without on-call.md's escalation.