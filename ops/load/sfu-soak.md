# SFU soak test — room fan-out procedure (F1)

Validates `autoscaling.tf`'s `sfu_rooms_per_node` target tracking (150
producers/node) and the alarm threshold in `observability.tf` (180) before
a capacity-sensitive launch (semester start, marketing push, etc).

## Setup
1. Deploy to staging with `sfu_min_size` raised to match expected baseline
   load — don't soak-test against a cold single-node ASG.
2. Seed N synthetic rooms via `ops/scripts/seed.js --rooms=<n>
   --peers-per-room=<m>` (demo tenant, staging only).
3. Each synthetic peer publishes cam+mic (2 producers) using a headless
   mediasoup-client harness — not real browsers, to keep the load generator
   itself cheap to run at scale.

## Ramp
| Stage | Rooms | Peers/room | Producers/node target |
|---|---|---|---|
| Baseline | 10 | 4 | well under 150 |
| Ramp 1 | 50 | 6 | approach 150 |
| Ramp 2 | 100 | 8 | should trigger scale-out |
| Soak | hold Ramp 2 for 30 min | | confirm stability, not just the spike |

## What to watch
- `ActiveProducersPerNode` (`ClassroomPlatform/SFU` namespace) — should
  trend toward 150 and trigger `aws_autoscaling_policy.sfu_rooms_per_node`
  before hitting the 180 alarm threshold.
- `aws_autoscaling_group.sfu` desired/current capacity — new nodes should
  appear within `estimated_instance_warmup` (120s) of crossing target.
- Per-room join latency and reconnect rate — a saturated node should
  degrade gracefully (new rooms route elsewhere), not fail joins outright.
- CPU/network on individual EC2 instances (`sfu_instance_type`,
  `c6i.xlarge` default) — confirm the instance type is actually the
  bottleneck before assuming the target value is wrong.

## Teardown
Tear down synthetic rooms via `seed.js --cleanup`, scale `sfu_min_size`
back down, and file soak results (rooms/node achieved, time-to-scale,
any join failures) against the capacity plan for the event being prepared for.