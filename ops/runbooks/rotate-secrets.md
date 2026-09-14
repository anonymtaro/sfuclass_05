# Rotate-secrets runbook

Every secret referenced here lives in Secrets Manager under
`${local.name_prefix}-*`, encrypted with `aws_kms_key.secrets` (`kms.tf`).
`aws_iam_role.ecs_task_execution`'s policy already scopes
`secretsmanager:GetSecretValue` to that prefix — rotating the value never
requires touching IAM.

## JWT signing key pair (`aws_secretsmanager_secret.jwt_keys`)
1. Generate a new RS256 key pair.
2. Write both keys into the secret as a **new version** (don't delete the
   old version yet — in-flight access tokens are still signed with it):
   ```
   aws secretsmanager put-secret-value \
     --secret-id classroom-<env>-jwt-keys \
     --secret-string '{"JWT_PRIVATE_KEY":"...","JWT_PUBLIC_KEY":"..."}'
   ```
3. Restart `aws_ecs_service.api` and `.realtime` (rolling, zero downtime —
   `deployment_circuit_breaker` protects against a bad key format).
4. After `JWT_ACCESS_TTL` has fully elapsed since step 3, the old key can
   be safely forgotten — no explicit deletion needed, Secrets Manager
   versions age out on their own retention.

If `var.jwt_rotation_lambda_arn` is set, `aws_secretsmanager_secret_rotation`
does steps 1–2 automatically every 90 days — this manual procedure is only
for an out-of-cycle rotation (suspected leak, etc).

## Cookie secret, APNs/FCM credentials, TURN shared secret
Same `put-secret-value` pattern against:
- `classroom-<env>-cookie-secret`
- `classroom-<env>-apns-credentials`
- `classroom-<env>-fcm-credentials`
- `classroom-<env>-turn-shared-secret`

The TURN secret additionally needs an instance refresh on
`aws_autoscaling_group.turn` and the SFU's own TURN listener, since
`user_data` bakes the secret into `/etc/turnserver.conf` at boot rather
than reading it live.

## RDS master password
Never rotate manually — `manage_master_user_password = true` in `data.tf`
means Secrets Manager rotates this on its own AWS-managed schedule.

## Database credential leaked outside the above
Escalate per `on-call.md` — a leaked RDS credential (as opposed to a
routine rotation) means checking `aws_iam_role_policy` grants and audit
logs before just rotating and moving on.