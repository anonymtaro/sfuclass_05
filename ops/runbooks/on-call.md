# On-call runbook — alert → owner → first action

All alarms below publish to `aws_sns_topic.alarms` (`observability.tf`),
plus `worker_queue_depth_high` which lives in `autoscaling.tf` because it
also drives scaling.

| Alarm | Owner | First action |
|---|---|---|
| `api-5xx-rate` | API on-call | Check the last release (`deploy.md` step 8); if a deploy just happened, `rollback.md` first, investigate second. |
| `readiness-failures` | API on-call | `aws ecs describe-tasks` for the `api` service; check RDS/Redis reachability before assuming app-level bug. |
| `sfu-node-saturation` | Media on-call | `sfu-incident.md`. |
| `worker-queue-depth-high` | Platform on-call | Confirm `aws_ecs_service.worker` is actually scaling (`autoscaling.tf`); check for a stuck job holding a queue lock. |
| `transcode-lag` | Media on-call | Check MediaConvert queue (`aws_media_convert_queue.main`) for a stuck/erroring job; `jobs/reconcileTranscodes.js` should self-heal within an hour. |
| `chat-delivery-latency` | Platform on-call | Check the Redis adapter (`realtime/redisAdapter.js`) and `aws_elasticache_replication_group.main` CPU/evictions. |
| `db-cpu` / `db-connections` | Data on-call | Find the offending query; check `PG_POOL_MAX` isn't exceeded across all `api`/`worker` tasks combined. |
| `storage-quota-drift` | Billing on-call | Run `jobs/recomputeStorageUsage.js` manually; if drift persists, check `StorageGuard.js` for a race on concurrent uploads. |
| `cert-expiry-alb` / equivalent for the CloudFront cert | Platform on-call | ACM renewal should be automatic (DNS validation records already exist in `route53.tf`) — investigate why it didn't renew, don't just wait. |

## Escalation
If the first action doesn't resolve it within 30 minutes, or the incident
touches customer data (a leaked secret, a bad migration that wrote wrong
data, a restore in progress), escalate to the platform lead rather than
continuing to debug solo — `restore-database.md` and `rotate-secrets.md`
both assume a second pair of eyes for anything past step 1.

## Comms
Post to the incident channel with: what alarm fired, what you've ruled
out, and current customer impact (none / degraded / down). Update every
15 minutes even if there's no news — silence reads as "nobody's on it."