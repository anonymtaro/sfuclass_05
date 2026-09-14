# Rollback runbook — image pin + task-definition revert

Use this when `deploy.md`'s step 8 alarms fire, or the deployment circuit
breaker didn't catch a bad release on its own.

## Automatic path
`aws_ecs_service.api` / `.realtime` / `.worker` all have
`deployment_circuit_breaker { enable = true, rollback = true }`. If ECS
marks the new task set unhealthy against `/readyz`, it reverts to the
previous task definition revision by itself — nothing to do but confirm it
happened in the ECS console or:
```
aws ecs describe-services --cluster classroom-<env>-cluster \
  --services classroom-<env>-api --query 'services[0].deployments'
```

## Manual path
1. Find the last-known-good task definition revision:
   ```
   aws ecs list-task-definitions --family-prefix classroom-<env>-api --sort DESC
   ```
2. Revert the service to it:
   ```
   aws ecs update-service --cluster classroom-<env>-cluster \
     --service classroom-<env>-api \
     --task-definition classroom-<env>-api:<previous-revision>
   ```
3. Repeat for `realtime`, `worker`, `sfu` as needed — they roll back
   independently.
4. Record the reverted-to digest in
   `aws_ssm_parameter.last_deployed_digest["api"]` (`pipeline.tf`) so the
   next `deploy-api.yml` run diffs against the right baseline.

## Database
Terraform's `db/migrate.js` follows expand-then-contract (see
`restore-database.md` and section 9.1 of the architecture doc), so a
rollback should always meet a schema it can read. If a migration genuinely
needs undoing, that is a forward migration that reverses it — never edit
history. If data is already corrupted, escalate to `restore-database.md`'s
PITR path instead of trying to roll the schema back.

## SFU
Never roll back mid-drain. If a bad SFU image is mid-rollout, stop the
`aws_autoscaling_group.sfu` instance refresh, let in-flight rooms finish on
the old nodes, then redeploy the previous task definition to new capacity.