# Deploy runbook — normal release path

Matches section 10 of the architecture doc exactly. Nothing here is manual
except the two approval gates.

## 1. Pull request
CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, contract
tests against `packages/contracts/src/zod/*`, and posts a `terraform plan`
for `infra/` as a PR comment. Merge requires all green + one review.

## 2. Merge to main
`build-images.yml` builds three images from the same commit SHA — `api`,
`sfu`, `worker` — pushes each to its `aws_ecr_repository` (`ecr.tf`), and
fails the build if the image scan finds a critical vulnerability.

## 3. Staging
```
terraform -chdir=infra init -backend-config=envs/staging/backend.hcl
terraform -chdir=infra apply -var-file=envs/staging/terraform.tfvars \
  -var="api_image=<ecr-repo-url>:<sha>" \
  -var="worker_image=<ecr-repo-url>:<sha>" \
  -var="sfu_image=<ecr-repo-url>:<sha>"
```
The migration task (`ops/migrations/migrate-task.json`) runs first, then
`aws_ecs_service.api` / `.realtime` / `.worker` / `.sfu` update. Run
`ops/scripts/smoke.sh staging` — it must pass before promoting further.

## 4. Production (manual approval)
Same `terraform apply`, `envs/prod/terraform.tfvars`, **same image digest**
that passed staging — never a fresh build. `aws_ecs_service.*`'s
`deployment_circuit_breaker` rolls back automatically on failed health
checks during this step.

## 5. SFU nodes
`aws_autoscaling_group.sfu` replaces nodes one at a time: mark draining
(see `sfu-incident.md`'s drain procedure), wait for `lifecycle/drainSfu.js`
to report the node empty or the drain timeout to elapse, then terminate.
No active room should be killed by a routine deploy.

## 6. Web
`deploy-web.yml`: build → `aws_s3_bucket.web` → CloudFront invalidation on
`aws_cloudfront_distribution.web`. `index.html` is never cached
(`cache_policy_id` = CachingDisabled in `cdn.tf`), so the invalidation only
needs to cover hashed assets that changed.

## 7. Mobile
`deploy-mobile.yml` runs an EAS build using the token in
`aws_secretsmanager_secret.expo_token` (`pipeline.tf`), tagged release only.
The API keeps the previous contract version alive for one release cycle.

## 8. After release
Confirm `RELEASE_SHA` shows up in logs, traces, and `/healthz`. Watch
`aws_sns_topic.alarms` (`observability.tf`) for 30 minutes. Rollback is
`rollback.md`.