# SFU incident runbook — node drain, TURN fallback (F1)

## Alarm: SFU node saturation
`aws_cloudwatch_metric_alarm.sfu_node_saturation` (`observability.tf`) fires
when `ActiveProducersPerNode` exceeds 180 — above the 150 scale-out target
in `autoscaling.tf`'s `aws_autoscaling_policy.sfu_rooms_per_node`, meaning
scaling itself isn't keeping up.

1. Check `aws_autoscaling_group.sfu`'s current size vs `sfu_max_size`
   (`var.sfu_max_size`, default 6). If it's pinned at max, raise it:
   ```
   terraform apply -var-file=envs/<env>/terraform.tfvars \
     -var="sfu_max_size=10"
   ```
2. If new instances aren't launching fast enough, check
   `aws_launch_template.sfu`'s AMI is still resolvable and the
   `aws_ecs_capacity_provider.sfu` managed scaling isn't throttled.
3. Once headroom exists, active rooms rebalance naturally as new rooms are
   routed to less-loaded nodes by `RoomRegistry.js` — existing rooms are
   **never** forcibly moved.

## Draining a specific node (planned maintenance or a bad node)
1. Mark the node draining: `lifecycle/drainSfu.js` stops it accepting new
   room assignments (this is application-level, not an AWS API call).
2. Wait for its room count to reach zero, or for the drain timeout
   (`ops/runbooks/deploy.md` step 5 uses the same mechanism).
3. Terminate the underlying EC2 instance:
   ```
   aws autoscaling terminate-instance-in-auto-scaling-group \
     --instance-id <id> --no-should-decrement-desired-capacity
   ```
   `aws_ecs_capacity_provider.sfu`'s managed scaling replaces it.

## An AZ is lost mid-room
This is the one documented visible failure mode (section 11.2): live rooms
on the lost node end and participants rejoin. There is no silent failover
for an in-progress mediasoup session — communicate this clearly if paging
support during an AZ event.

## TURN fallback isn't working
Two independent TURN paths exist:
- **TURN-over-TCP:443 on the SFU itself** — `aws_security_group.sfu`'s
  ingress rule, health-checked by `aws_lb_target_group.sfu_media`.
- **Dedicated coturn fleet** (`turn.tf`, `aws_autoscaling_group.turn`) —
  for networks that block UDP outright.

Check `aws_secretsmanager_secret.turn_shared_secret` is readable by
`aws_iam_role.turn_instance` first — a stale/rotated secret without an
instance refresh is the most common cause of "TURN worked yesterday."